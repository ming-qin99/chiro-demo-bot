import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { getClinicSettings, getClinikoSettings, normalizeClinicPhone } from "../clinic-config.js";
import { dispatchProactiveNoticeTo } from "../proactive-email.js";
import { sendImessage } from "../sendblue.js";
import { appointmentPatientId, ClinikoClient, patientDisplayName } from "./client.js";
import { treatmentNoteTodos } from "./tools.js";
import type {
  ClinikoIndividualAppointment,
  ClinikoPage,
  ClinikoPatient,
  ClinikoTreatmentNote,
} from "./types.js";

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface OutreachWindows {
  reminderFrom: Date;
  reminderTo: Date;
  followupFrom: Date;
  followupTo: Date;
}

export function outreachWindows(now: number, followupDelayHours: number): OutreachWindows {
  const hour = 60 * 60 * 1_000;
  return {
    reminderFrom: new Date(now + 24 * hour),
    reminderTo: new Date(now + 25 * hour),
    followupFrom: new Date(now - 24 * hour),
    followupTo: new Date(now - followupDelayHours * hour),
  };
}

function firstPatientPhone(patient: ClinikoPatient): string | null {
  for (const entry of patient.patient_phone_numbers ?? []) {
    const phone = normalizeClinicPhone(entry.number);
    if (phone) return phone;
  }
  return null;
}

function dateLabel(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

async function client(): Promise<ClinikoClient | null> {
  const settings = await getClinikoSettings();
  if (!settings.enabled || !settings.apiKey) return null;
  return new ClinikoClient({
    apiKey: settings.apiKey,
    shard: settings.shard,
    userAgent: settings.userAgent,
  });
}

async function appointmentsBetween(
  cliniko: ClinikoClient,
  field: "starts_at" | "ends_at",
  from: Date,
  to: Date,
): Promise<ClinikoIndividualAppointment[]> {
  return cliniko.paginate<ClinikoIndividualAppointment>(
    "/individual_appointments",
    "individual_appointments",
    {
      "q[]": [`${field}:>=${from.toISOString()}`, `${field}:<${to.toISOString()}`],
      sort: field,
    },
    5,
  );
}

async function patientForAppointment(
  cliniko: ClinikoClient,
  appointment: ClinikoIndividualAppointment,
): Promise<ClinikoPatient | null> {
  const id = appointmentPatientId(appointment);
  if (!id) return null;
  return cliniko.request<ClinikoPatient>(`/patients/${encodeURIComponent(id)}`);
}

async function persistPatientMessage(phone: string, text: string): Promise<boolean> {
  const sent = await sendImessage(phone, text);
  if (!sent) return false;
  await convex.mutation(api.messages.send, {
    conversationId: `sms:${phone}`,
    role: "assistant",
    content: text,
  });
  return true;
}

async function processReminder(
  cliniko: ClinikoClient,
  appointment: ClinikoIndividualAppointment,
  timezone: string,
): Promise<void> {
  const patient = await patientForAppointment(cliniko, appointment);
  const phone = patient ? firstPatientPhone(patient) : null;
  const outreachId = randomId("outreach");
  const claim = await convex.mutation(api.clinikoOutreach.claim, {
    outreachId,
    kind: "reminder",
    appointmentId: String(appointment.id),
    patientPhone: phone ?? "unavailable",
    scheduledFor: Date.parse(appointment.starts_at),
  });
  if (!claim.claimed) return;
  try {
    if (!phone) {
      await convex.mutation(api.clinikoOutreach.setStatus, {
        outreachId,
        status: "skipped",
        error: "Patient has no deliverable phone number",
      });
      return;
    }
    const type = appointment.appointment_type?.name || "appointment";
    const practitioner = appointment.practitioner?.label || "your practitioner";
    const text = `Reminder: your ${type} with ${practitioner} is ${dateLabel(appointment.starts_at, timezone)}. Reply C to confirm, or tell me if you need to reschedule.`;
    const sent = await persistPatientMessage(phone, text);
    await convex.mutation(api.clinikoOutreach.setStatus, {
      outreachId,
      status: sent ? "sent" : "failed",
      error: sent ? undefined : "Sendblue delivery failed",
    });
  } catch (err) {
    await convex.mutation(api.clinikoOutreach.setStatus, {
      outreachId,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function latestTreatmentNote(
  cliniko: ClinikoClient,
  patientId: string,
): Promise<ClinikoTreatmentNote | null> {
  const payload = await cliniko.request<ClinikoPage<ClinikoTreatmentNote>>(
    `/patients/${encodeURIComponent(patientId)}/treatment_notes`,
    { query: { sort: "created_at:desc", per_page: 5 } },
  );
  return (
    ((payload.treatment_notes ?? []) as ClinikoTreatmentNote[]).find(
      (note) => !note.draft && Boolean(note.finalized_at) && treatmentNoteTodos(note).length > 0,
    ) ?? null
  );
}

async function processFollowup(
  cliniko: ClinikoClient,
  appointment: ClinikoIndividualAppointment,
): Promise<void> {
  const clinic = await getClinicSettings();
  const patientId = appointmentPatientId(appointment);
  if (!patientId) return;
  const patient = await patientForAppointment(cliniko, appointment);
  const phone = patient ? firstPatientPhone(patient) : null;
  const outreachId = randomId("outreach");
  const claim = await convex.mutation(api.clinikoOutreach.claim, {
    outreachId,
    kind: "followup",
    appointmentId: String(appointment.id),
    patientPhone: phone ?? "unavailable",
    scheduledFor: Date.parse(appointment.ends_at),
  });
  if (!claim.claimed) return;
  try {
    if (!patient || !phone) {
      await convex.mutation(api.clinikoOutreach.setStatus, {
        outreachId,
        status: "skipped",
        error: "Patient has no deliverable phone number",
      });
      return;
    }
    const note = await latestTreatmentNote(cliniko, patientId);
    if (!note) {
      await convex.mutation(api.clinikoOutreach.setStatus, {
        outreachId,
        status: "skipped",
        error: "No finalized practitioner follow-up instructions found",
      });
      return;
    }
    const todos = treatmentNoteTodos(note);
    const text = `Hi ${patient.preferred_first_name || patient.first_name}, here are the follow-up steps ${clinic.practitionerName} documented for you: ${todos.join(" • ")}`;
    if (clinic.followupAutoSend) {
      const sent = await persistPatientMessage(phone, text);
      await convex.mutation(api.clinikoOutreach.setStatus, {
        outreachId,
        status: sent ? "sent" : "failed",
        error: sent ? undefined : "Sendblue delivery failed",
      });
      return;
    }
    const staffPhone = clinic.staffPhoneNumbers[0];
    if (!staffPhone) {
      await convex.mutation(api.clinikoOutreach.setStatus, {
        outreachId,
        status: "failed",
        error: "No staff phone configured for follow-up approval",
      });
      return;
    }
    const draftId = randomId("draft");
    await convex.mutation(api.drafts.create, {
      draftId,
      conversationId: `sms:${staffPhone}`,
      kind: "clinic.followup",
      summary: `Follow-up for ${patientDisplayName(patient)} after their recent appointment`,
      payload: JSON.stringify({ phone, text, outreachId }),
    });
    await convex.mutation(api.clinikoOutreach.setStatus, {
      outreachId,
      status: "drafted",
      draftId,
    });
    await dispatchProactiveNoticeTo(
      staffPhone,
      `A patient follow-up draft is ready for ${patientDisplayName(patient)}. Review it and reply “send it” to deliver. [${draftId}]`,
      "staff",
    );
  } catch (err) {
    await convex.mutation(api.clinikoOutreach.setStatus, {
      outreachId,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export async function tickClinikoOutreach(now = Date.now()): Promise<void> {
  const cliniko = await client();
  if (!cliniko) return;
  const clinic = await getClinicSettings();
  const windows = outreachWindows(now, clinic.followupDelayHours);
  const [reminders, followups] = await Promise.all([
    appointmentsBetween(cliniko, "starts_at", windows.reminderFrom, windows.reminderTo),
    appointmentsBetween(cliniko, "ends_at", windows.followupFrom, windows.followupTo),
  ]);
  for (const appointment of reminders) {
    await processReminder(cliniko, appointment, clinic.timezone).catch((err) =>
      console.error("[cliniko-outreach] reminder failed", err),
    );
  }
  for (const appointment of followups) {
    await processFollowup(cliniko, appointment).catch((err) =>
      console.error("[cliniko-outreach] follow-up failed", err),
    );
  }
}

export function startClinikoOutreachLoop(intervalMs = 5 * 60 * 1_000): () => void {
  const timer = setInterval(() => {
    tickClinikoOutreach().catch((err) => console.error("[cliniko-outreach] tick failed", err));
  }, intervalMs);
  return () => clearInterval(timer);
}
