import { describe, expect, it } from "vitest";
import {
  clinikoCancellationBody,
  createClinikoTools,
  treatmentNoteTodos,
} from "../server/cliniko/tools.js";
import { memoryScopesFor } from "../server/identity.js";
import { allowedDispatcherToolsForAudience } from "../server/interaction-agent.js";
import { outreachWindows } from "../server/cliniko/outreach.js";
import { draftExecutionIntegrations } from "../server/draft-tools.js";

function names(context: Parameters<typeof createClinikoTools>[0]): string[] {
  return createClinikoTools(context).map((tool) => tool.name);
}

describe("clinic audience safety", () => {
  it("exposes only patient-pinned reads before a booking draft is approved", () => {
    const patientTools = names({
      audience: "patient",
      patientPhone: "+61412345678",
      clinikoPatientId: "patient-42",
    });
    expect(patientTools).toContain("get_my_details");
    expect(patientTools).toContain("get_my_upcoming_appointments");
    expect(patientTools).not.toContain("get_patient");
    expect(patientTools).not.toContain("find_patient");
    expect(patientTools).not.toContain("create_appointment");
    expect(patientTools).not.toContain("book_my_appointment");
  });

  it("adds only pinned patient writes during approved draft execution", () => {
    const patientTools = createClinikoTools({
      audience: "patient",
      clinikoPatientId: "patient-42",
      allowWrites: true,
    });
    const patientNames = patientTools.map((tool) => tool.name);
    expect(patientNames).toContain("book_my_appointment");
    expect(patientNames).toContain("reschedule_my_appointment");
    expect(patientNames).toContain("cancel_my_appointment");
    expect(patientNames).not.toContain("create_appointment");
    const booking = patientTools.find((tool) => tool.name === "book_my_appointment");
    expect(Object.keys(booking?.inputSchema ?? {})).not.toContain("patientId");
  });

  it("reserves raw patient and appointment tools for staff", () => {
    const staffReadTools = names({ audience: "staff" });
    expect(staffReadTools).toContain("find_patient");
    expect(staffReadTools).not.toContain("create_patient");
    expect(staffReadTools).not.toContain("send_patient_message");

    const staffTools = names({ audience: "staff", allowWrites: true });
    expect(staffTools).toContain("find_patient");
    expect(staffTools).toContain("create_patient");
    expect(staffTools).toContain("create_appointment");
    expect(staffTools).toContain("send_patient_message");
  });

  it("maps cancellation drafts to Cliniko's required cancellation fields", () => {
    expect(clinikoCancellationBody("other", "Schedule conflict")).toEqual({
      cancellation_note: "Schedule conflict",
      cancellation_reason: 50,
      apply_to_repeats: false,
    });
    expect(clinikoCancellationBody("work", undefined, true)).toEqual({
      cancellation_note: null,
      cancellation_reason: 60,
      apply_to_repeats: true,
    });
  });

  it("keeps patient memories isolated while sharing clinic facts", () => {
    expect(memoryScopesFor("patient", "+61412345678")).toEqual({
      readMemoryScopes: ["patient:+61412345678", "clinic"],
      writeMemoryScope: "patient:+61412345678",
    });
    expect(memoryScopesFor("staff", "+61400000000")).toEqual({
      readMemoryScopes: ["staff", "clinic"],
      writeMemoryScope: "staff",
    });
  });

  it("does not expose self-configuration or automation tools to patients", () => {
    const patientTools = allowedDispatcherToolsForAudience("patient");
    expect(patientTools.some((name) => name.includes("boop-self"))).toBe(false);
    expect(patientTools.some((name) => name.includes("boop-automations"))).toBe(false);
    expect(patientTools).toContain("mcp__clinic-escalations__escalate_to_practitioner");
    expect(allowedDispatcherToolsForAudience("staff")).toContain(
      "mcp__clinic-escalations__answer_escalation",
    );
  });

  it("forces patient draft execution through Cliniko and rejects other patient actions", () => {
    expect(
      draftExecutionIntegrations("patient", "cliniko.reschedule", ["gmail", "browser"]),
    ).toEqual(["cliniko"]);
    expect(draftExecutionIntegrations("patient", "gmail.reply", ["gmail"])).toBeNull();
    expect(draftExecutionIntegrations("unknown", "cliniko.book", ["cliniko"])).toBeNull();
    expect(draftExecutionIntegrations("staff", "clinic.followup", ["cliniko"])).toEqual([
      "cliniko",
    ]);
  });
});

describe("clinic follow-up safety", () => {
  it("extracts documented practitioner instructions without exposing unrelated note answers", () => {
    const todos = treatmentNoteTodos({
      id: "note-1",
      content: {
        sections: [
          {
            name: "Assessment",
            questions: [
              { name: "Diagnosis", answer: "Sensitive assessment detail" },
              { name: "Home exercise plan", answer: "Walk for ten minutes daily" },
            ],
          },
        ],
      },
    });
    expect(todos).toEqual(["Walk for ten minutes daily"]);
  });

  it("uses non-overlapping reminder and delayed follow-up windows", () => {
    const now = Date.parse("2026-08-27T00:00:00.000Z");
    const windows = outreachWindows(now, 4);
    expect(windows.reminderFrom.toISOString()).toBe("2026-08-28T00:00:00.000Z");
    expect(windows.reminderTo.toISOString()).toBe("2026-08-28T01:00:00.000Z");
    expect(windows.followupFrom.toISOString()).toBe("2026-08-26T00:00:00.000Z");
    expect(windows.followupTo.toISOString()).toBe("2026-08-26T20:00:00.000Z");
  });
});
