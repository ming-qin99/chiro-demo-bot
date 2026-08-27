import { z } from "zod";
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { getClinikoSettings, normalizeClinicPhone } from "../clinic-config.js";
import type { IntegrationContext } from "../integrations/registry.js";
import { createClaudeMcpServer } from "../runtimes/claude.js";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText, type RuntimeTool, type RuntimeToolResult } from "../runtimes/types.js";
import { sendImessage } from "../sendblue.js";
import {
  appointmentPatientId,
  ClinikoClient,
  findPatientByPhone,
  patientDisplayName,
} from "./client.js";
import type {
  ClinikoAvailableTime,
  ClinikoBusiness,
  ClinikoIndividualAppointment,
  ClinikoPage,
  ClinikoPatient,
  ClinikoTreatmentNote,
} from "./types.js";

const NAMESPACE = "cliniko";
const TODO_FIELD =
  /home\s*(?:exercise|program)|exercise\s*(?:plan|instruction)|advice|recommend(?:ation|ed)?|to.?do|homework|instruction|follow.?up\s*(?:plan|action|instruction)/i;
const CANCELLATION_REASON = {
  feeling_better: 10,
  condition_worse: 20,
  sick: 30,
  away: 40,
  other: 50,
  work: 60,
} as const;
const cancellationReasonV = z
  .enum(["feeling_better", "condition_worse", "sick", "away", "other", "work"])
  .optional()
  .default("other");

export function clinikoCancellationBody(
  reason: keyof typeof CANCELLATION_REASON,
  note?: string,
  applyToRepeats = false,
) {
  return {
    cancellation_note: note ?? null,
    cancellation_reason: CANCELLATION_REASON[reason],
    apply_to_repeats: applyToRepeats,
  };
}

function asJson(value: unknown): RuntimeToolResult {
  return runtimeText(JSON.stringify(value, null, 2));
}

function toolError(err: unknown): RuntimeToolResult {
  return runtimeText(`[cliniko error] ${err instanceof Error ? err.message : String(err)}`, false);
}

async function wrap(fn: () => Promise<unknown>): Promise<RuntimeToolResult> {
  try {
    return asJson(await fn());
  } catch (err) {
    return toolError(err);
  }
}

async function configuredClient(): Promise<ClinikoClient> {
  const settings = await getClinikoSettings();
  if (!settings.enabled || !settings.apiKey) {
    throw new Error("Cliniko is not enabled or CLINIKO_API_KEY is missing");
  }
  return new ClinikoClient({
    apiKey: settings.apiKey,
    shard: settings.shard,
    userAgent: settings.userAgent,
  });
}

function safePatient(patient: ClinikoPatient) {
  return {
    id: patient.id,
    name: patientDisplayName(patient),
    firstName: patient.preferred_first_name || patient.first_name,
    lastName: patient.last_name,
    email: patient.email,
    timeZone: patient.time_zone,
  };
}

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function treatmentNoteTodos(note: ClinikoTreatmentNote): string[] {
  const todos: string[] = [];
  for (const section of note.content?.sections ?? []) {
    for (const question of section.questions ?? []) {
      if (!TODO_FIELD.test(`${section.name ?? ""} ${question.name ?? ""}`)) continue;
      if (question.answer === null || question.answer === undefined) continue;
      const answer = stripHtml(String(question.answer));
      if (answer) todos.push(answer);
    }
  }
  return todos;
}

function safeNote(note: ClinikoTreatmentNote) {
  return {
    id: note.id,
    title: note.title,
    author: note.author_name,
    createdAt: note.created_at,
    finalizedAt: note.finalized_at,
    practitionerTodos: treatmentNoteTodos(note),
  };
}

function patientIdFromContext(ctx: IntegrationContext): string {
  if (!ctx.clinikoPatientId) {
    throw new Error("This conversation is not matched to a Cliniko patient");
  }
  return ctx.clinikoPatientId;
}

async function verifyAppointmentOwner(
  client: ClinikoClient,
  appointmentId: string,
  patientId: string,
): Promise<ClinikoIndividualAppointment> {
  const appointment = await client.request<ClinikoIndividualAppointment>(
    `/individual_appointments/${encodeURIComponent(appointmentId)}`,
  );
  if (appointmentPatientId(appointment) !== patientId) {
    throw new Error("That appointment does not belong to the patient pinned to this conversation");
  }
  return appointment;
}

function patientReadTools(ctx: IntegrationContext): RuntimeTool[] {
  const tools: RuntimeTool[] = [];
  if (ctx.clinikoPatientId) {
    tools.push(
      defineRuntimeTool(
        NAMESPACE,
        "get_my_details",
        "Get the Cliniko identity and contact details for the patient pinned to this conversation. It cannot accept another patient id.",
        {},
        async () =>
          wrap(async () => {
            const patientId = patientIdFromContext(ctx);
            return safePatient(
              await (await configuredClient()).request<ClinikoPatient>(
                `/patients/${encodeURIComponent(patientId)}`,
              ),
            );
          }),
      ),
      defineRuntimeTool(
        NAMESPACE,
        "get_my_upcoming_appointments",
        "List upcoming appointments for the patient pinned to this conversation.",
        { limit: z.number().int().min(1).max(20).optional().default(10) },
        async (args) =>
          wrap(async () => {
            const patientId = patientIdFromContext(ctx);
            const payload = await (await configuredClient()).request<
              ClinikoPage<ClinikoIndividualAppointment>
            >("/individual_appointments", {
              query: {
                "q[]": [`patient_id:=${patientId}`, `starts_at:>=${new Date().toISOString()}`],
                sort: "starts_at",
                per_page: args.limit,
              },
            });
            return payload.individual_appointments ?? [];
          }),
      ),
      defineRuntimeTool(
        NAMESPACE,
        "get_my_past_appointments",
        "List recent past appointments for the patient pinned to this conversation.",
        { limit: z.number().int().min(1).max(20).optional().default(10) },
        async (args) =>
          wrap(async () => {
            const patientId = patientIdFromContext(ctx);
            const payload = await (await configuredClient()).request<
              ClinikoPage<ClinikoIndividualAppointment>
            >("/individual_appointments", {
              query: {
                "q[]": [`patient_id:=${patientId}`, `ends_at:<${new Date().toISOString()}`],
                sort: "starts_at:desc",
                per_page: args.limit,
              },
            });
            return payload.individual_appointments ?? [];
          }),
      ),
      defineRuntimeTool(
        NAMESPACE,
        "get_my_treatment_note_summaries",
        "Return only practitioner-authored follow-up instructions/to-dos from the pinned patient's recent finalized treatment notes. Do not infer medical advice from omitted fields.",
        { limit: z.number().int().min(1).max(10).optional().default(5) },
        async (args) =>
          wrap(async () => {
            const patientId = patientIdFromContext(ctx);
            const payload = await (await configuredClient()).request<
              ClinikoPage<ClinikoTreatmentNote>
            >(`/patients/${encodeURIComponent(patientId)}/treatment_notes`, {
              query: { sort: "created_at:desc", per_page: args.limit },
            });
            return ((payload.treatment_notes ?? []) as ClinikoTreatmentNote[])
              .filter((note) => !note.draft && Boolean(note.finalized_at))
              .map(safeNote);
          }),
      ),
    );
  }

  tools.push(
    defineRuntimeTool(
      NAMESPACE,
      "get_available_times",
      "Get online-bookable Cliniko times for a specific business, practitioner, and appointment type. This reveals availability only, never another patient's appointments.",
      {
        businessId: z.string(),
        practitionerId: z.string(),
        appointmentTypeId: z.string(),
        from: z.string().describe("UTC ISO date/time or YYYY-MM-DD"),
        to: z.string().describe("UTC ISO date/time or YYYY-MM-DD"),
        limit: z.number().int().min(1).max(50).optional().default(20),
      },
      async (args) =>
        wrap(async () => {
          const path = `/businesses/${encodeURIComponent(args.businessId)}/practitioners/${encodeURIComponent(args.practitionerId)}/appointment_types/${encodeURIComponent(args.appointmentTypeId)}/available_times`;
          const payload = await (await configuredClient()).request<ClinikoPage<ClinikoAvailableTime>>(
            path,
            { query: { from: args.from, to: args.to, per_page: args.limit } },
          );
          return payload.available_times ?? [];
        }),
    ),
  );
  return tools;
}

function patientCommitTools(ctx: IntegrationContext): RuntimeTool[] {
  if (!ctx.allowWrites || !ctx.clinikoPatientId) return [];
  return [
    defineRuntimeTool(
      NAMESPACE,
      "book_my_appointment",
      "Commit an approved booking for the patient pinned to this conversation. Available only during send_draft execution.",
      {
        appointmentTypeId: z.string(),
        businessId: z.string(),
        practitionerId: z.string(),
        startsAt: z.string(),
        endsAt: z.string().optional(),
        notes: z.string().optional(),
      },
      async (args) =>
        wrap(async () =>
          (await configuredClient()).request("/individual_appointments", {
            method: "POST",
            body: {
              patient_id: patientIdFromContext(ctx),
              appointment_type_id: args.appointmentTypeId,
              business_id: args.businessId,
              practitioner_id: args.practitionerId,
              starts_at: args.startsAt,
              ends_at: args.endsAt,
              notes: args.notes,
            },
          }),
        ),
    ),
    defineRuntimeTool(
      NAMESPACE,
      "reschedule_my_appointment",
      "Commit an approved reschedule after verifying the appointment belongs to the pinned patient.",
      { appointmentId: z.string(), startsAt: z.string(), endsAt: z.string().optional() },
      async (args) =>
        wrap(async () => {
          const client = await configuredClient();
          await verifyAppointmentOwner(client, args.appointmentId, patientIdFromContext(ctx));
          return client.request(`/individual_appointments/${encodeURIComponent(args.appointmentId)}`, {
            method: "PATCH",
            body: { starts_at: args.startsAt, ends_at: args.endsAt },
          });
        }),
    ),
    defineRuntimeTool(
      NAMESPACE,
      "cancel_my_appointment",
      "Commit an approved cancellation after verifying the appointment belongs to the pinned patient.",
      {
        appointmentId: z.string(),
        reason: z.string().optional(),
        cancellationReason: cancellationReasonV,
        applyToRepeats: z.boolean().optional().default(false),
      },
      async (args) =>
        wrap(async () => {
          const client = await configuredClient();
          await verifyAppointmentOwner(client, args.appointmentId, patientIdFromContext(ctx));
          return client.request(
            `/individual_appointments/${encodeURIComponent(args.appointmentId)}/cancel`,
            {
              method: "PATCH",
              body: clinikoCancellationBody(
                args.cancellationReason,
                args.reason,
                args.applyToRepeats,
              ),
            },
          );
        }),
    ),
  ];
}

function staffTools(ctx: IntegrationContext): RuntimeTool[] {
  if (ctx.audience !== "staff") return [];
  const tools = [
    defineRuntimeTool(
      NAMESPACE,
      "find_patient",
      "Find a Cliniko patient by first/last name or exact phone. Staff only.",
      { name: z.string().optional(), phone: z.string().optional() },
      async (args) =>
        wrap(async () => {
          const client = await configuredClient();
          if (args.phone) {
            const patient = await findPatientByPhone(client, args.phone);
            return patient ? safePatient(patient) : null;
          }
          const terms = (args.name ?? "").trim().split(/\s+/).filter(Boolean);
          if (terms.length === 0) throw new Error("Provide name or phone");
          const filters = terms.length === 1
            ? [`last_name:~${terms[0]}`]
            : [`first_name:~${terms[0]}`, `last_name:~${terms.slice(1).join(" ")}`];
          const payload = await client.request<ClinikoPage<ClinikoPatient>>("/patients", {
            query: { "q[]": filters, per_page: 20 },
          });
          return ((payload.patients ?? []) as ClinikoPatient[]).map(safePatient);
        }),
    ),
    defineRuntimeTool(
      NAMESPACE,
      "get_patient",
      "Get a Cliniko patient record by id. Staff only.",
      { patientId: z.string() },
      async (args) =>
        wrap(async () =>
          (await configuredClient()).request(`/patients/${encodeURIComponent(args.patientId)}`),
        ),
    ),
    defineRuntimeTool(
      NAMESPACE,
      "list_appointments",
      "List Cliniko individual appointments using bounded date/patient filters. Staff only.",
      {
        patientId: z.string().optional(),
        startsAfter: z.string().optional(),
        startsBefore: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional().default(50),
      },
      async (args) =>
        wrap(async () => {
          const filters = [
            ...(args.patientId ? [`patient_id:=${args.patientId}`] : []),
            ...(args.startsAfter ? [`starts_at:>=${args.startsAfter}`] : []),
            ...(args.startsBefore ? [`starts_at:<${args.startsBefore}`] : []),
          ];
          if (filters.length === 0) throw new Error("Provide a patient or date window");
          return (await configuredClient()).request("/individual_appointments", {
            query: { "q[]": filters, sort: "starts_at", per_page: args.limit },
          });
        }),
    ),
    defineRuntimeTool(
      NAMESPACE,
      "get_treatment_notes",
      "Get recent Cliniko treatment notes for one patient. Staff only.",
      { patientId: z.string(), limit: z.number().int().min(1).max(50).optional().default(10) },
      async (args) =>
        wrap(async () =>
          (await configuredClient()).request(
            `/patients/${encodeURIComponent(args.patientId)}/treatment_notes`,
            { query: { sort: "created_at:desc", per_page: args.limit } },
          ),
        ),
    ),
    defineRuntimeTool(
      NAMESPACE,
      "create_patient",
      "Create a Cliniko patient. Staff only.",
      {
        firstName: z.string(),
        lastName: z.string(),
        phone: z.string().optional(),
        email: z.string().email().optional(),
      },
      async (args) =>
        wrap(async () =>
          (await configuredClient()).request("/patients", {
            method: "POST",
            body: {
              first_name: args.firstName,
              last_name: args.lastName,
              email: args.email,
              patient_phone_numbers: args.phone
                ? [{ number: args.phone, phone_type: "Mobile" }]
                : undefined,
            },
          }),
        ),
    ),
    defineRuntimeTool(
      NAMESPACE,
      "create_appointment",
      "Create an individual Cliniko appointment. Staff only; use only for an approved draft.",
      {
        patientId: z.string(),
        appointmentTypeId: z.string(),
        businessId: z.string(),
        practitionerId: z.string(),
        startsAt: z.string(),
        endsAt: z.string().optional(),
      },
      async (args) =>
        wrap(async () =>
          (await configuredClient()).request("/individual_appointments", {
            method: "POST",
            body: {
              patient_id: args.patientId,
              appointment_type_id: args.appointmentTypeId,
              business_id: args.businessId,
              practitioner_id: args.practitionerId,
              starts_at: args.startsAt,
              ends_at: args.endsAt,
            },
          }),
        ),
    ),
    defineRuntimeTool(
      NAMESPACE,
      "update_appointment",
      "Update an individual Cliniko appointment. Staff only; use only for an approved draft.",
      { appointmentId: z.string(), startsAt: z.string(), endsAt: z.string().optional() },
      async (args) =>
        wrap(async () =>
          (await configuredClient()).request(
            `/individual_appointments/${encodeURIComponent(args.appointmentId)}`,
            { method: "PATCH", body: { starts_at: args.startsAt, ends_at: args.endsAt } },
          ),
        ),
    ),
    defineRuntimeTool(
      NAMESPACE,
      "cancel_appointment",
      "Cancel an individual Cliniko appointment. Staff only; use only for an approved draft.",
      {
        appointmentId: z.string(),
        cancellationNote: z.string().optional(),
        cancellationReason: cancellationReasonV,
        applyToRepeats: z.boolean().optional().default(false),
      },
      async (args) =>
        wrap(async () =>
          (await configuredClient()).request(
            `/individual_appointments/${encodeURIComponent(args.appointmentId)}/cancel`,
            {
              method: "PATCH",
              body: clinikoCancellationBody(
                args.cancellationReason,
                args.cancellationNote,
                args.applyToRepeats,
              ),
            },
          ),
        ),
    ),
    defineRuntimeTool(
      NAMESPACE,
      "send_patient_message",
      "Send an approved clinic message to a patient and persist it in their conversation. Staff/automation only.",
      {
        phone: z.string(),
        text: z.string().min(1).max(2900),
        outreachId: z.string().optional(),
      },
      async (args) => {
        const phone = normalizeClinicPhone(args.phone);
        if (!phone) return runtimeText("Invalid patient phone number", false);
        const sent = await sendImessage(phone, args.text);
        if (!sent) return runtimeText("The patient message could not be delivered", false);
        await convex.mutation(api.messages.send, {
          conversationId: `sms:${phone}`,
          role: "assistant",
          content: args.text,
        });
        if (args.outreachId) {
          await convex.mutation(api.clinikoOutreach.setStatus, {
            outreachId: args.outreachId,
            status: "sent",
          });
        }
        return runtimeText("Patient message sent and recorded.");
      },
    ),
  ];
  if (ctx.allowWrites) return tools;
  const writeTools = new Set([
    "create_patient",
    "create_appointment",
    "update_appointment",
    "cancel_appointment",
    "send_patient_message",
  ]);
  return tools.filter((tool) => !writeTools.has(tool.name));
}

export function createClinikoTools(ctx: IntegrationContext): RuntimeTool[] {
  return [
    ...patientReadTools(ctx),
    ...patientCommitTools(ctx),
    ...staffTools(ctx),
  ];
}

export function createClinikoMcp(ctx: IntegrationContext) {
  return createClaudeMcpServer(NAMESPACE, createClinikoTools(ctx));
}

export async function clinikoBusinesses(): Promise<ClinikoBusiness[]> {
  const payload = await (await configuredClient()).request<ClinikoPage<ClinikoBusiness>>(
    "/businesses",
    { query: { per_page: 100 } },
  );
  return (payload.businesses ?? []) as ClinikoBusiness[];
}
