import { z } from "zod";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { getClinicSettings } from "./clinic-config.js";
import type { Audience } from "./identity.js";
import { defineRuntimeTool } from "./runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "./runtimes/types.js";
import { sendImessage } from "./sendblue.js";

const NAMESPACE = "clinic-escalations";

function randomId(): string {
  return `esc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface EscalationToolContext {
  audience: Audience;
  conversationId: string;
  patientPhone?: string;
  displayName?: string;
}

export function createEscalationTools(context: EscalationToolContext): RuntimeTool[] {
  if (context.audience === "staff") {
    return [
      defineRuntimeTool(
        NAMESPACE,
        "list_escalations",
        "List patient questions waiting for a practitioner answer. Check this first when a staff text may answer a pending escalation.",
        { pendingOnly: z.boolean().optional().default(true) },
        async (args) => {
          const rows = await convex.query(api.escalations.list, {
            status: args.pendingOnly ? "pending" : undefined,
            limit: 50,
          });
          if (rows.length === 0) return runtimeText("No matching escalations.");
          return runtimeText(
            rows
              .map(
                (row) =>
                  `• [${row.escalationId}] ${row.patientName ?? "Patient"}: ${row.question}${row.context ? `\n  Context: ${row.context}` : ""}`,
              )
              .join("\n"),
          );
        },
      ),
      defineRuntimeTool(
        NAMESPACE,
        "answer_escalation",
        "Relay a practitioner's approved answer to the patient and close the escalation.",
        { escalationId: z.string(), answer: z.string().min(1).max(2500) },
        async (args) => {
          const row = await convex.query(api.escalations.get, {
            escalationId: args.escalationId,
          });
          if (!row || row.status !== "pending") {
            return runtimeText("Escalation not found or already resolved.", false);
          }
          await convex.mutation(api.escalations.updateStatus, {
            escalationId: args.escalationId,
            status: "answered",
            answer: args.answer,
          });
          const clinic = await getClinicSettings();
          const text = `${clinic.practitionerName} got back to me: ${args.answer}`;
          const sent = await sendImessage(row.patientPhone, text);
          if (!sent) {
            await convex.mutation(api.escalations.updateStatus, {
              escalationId: args.escalationId,
              status: "pending",
              answer: args.answer,
            });
            return runtimeText(
              "The answer was saved, but the patient message could not be delivered. The escalation remains pending for retry.",
              false,
            );
          }
          await convex.mutation(api.messages.send, {
            conversationId: row.patientConversationId,
            role: "assistant",
            content: text,
          });
          await convex.mutation(api.escalations.updateStatus, {
            escalationId: args.escalationId,
            status: "relayed",
            answer: args.answer,
          });
          return runtimeText("Answer relayed to the patient and escalation closed.");
        },
      ),
    ];
  }

  if (!context.patientPhone) return [];
  const patientPhone = context.patientPhone;
  return [
    defineRuntimeTool(
      NAMESPACE,
      "escalate_to_practitioner",
      "Ask the clinic practitioner a patient question you cannot safely answer. Use this for clinical uncertainty, undocumented advice, or requests outside front-desk scope.",
      {
        question: z.string().min(1).max(1500),
        context: z.string().max(1500).optional(),
      },
      async (args) => {
        const clinic = await getClinicSettings();
        if (clinic.staffPhoneNumbers.length === 0) {
          return runtimeText(
            "No staff phone is configured. Tell the patient the clinic will need to follow up, without pretending an escalation was sent.",
            false,
          );
        }
        const escalationId = randomId();
        await convex.mutation(api.escalations.create, {
          escalationId,
          patientConversationId: context.conversationId,
          patientPhone,
          patientName: context.displayName,
          question: args.question,
          context: args.context,
        });
        const staffText = `❓ ${context.displayName ?? "A patient"} asked: ${args.question}${args.context ? `\nContext: ${args.context}` : ""}\n[${escalationId}]`;
        let delivered = false;
        for (const staffPhone of clinic.staffPhoneNumbers) {
          if (await sendImessage(staffPhone, staffText)) {
            delivered = true;
            await convex.mutation(api.messages.send, {
              conversationId: `sms:${staffPhone}`,
              role: "assistant",
              content: staffText,
            });
          }
        }
        if (!delivered) {
          return runtimeText(
            `Escalation ${escalationId} was recorded, but staff delivery failed.`,
            false,
          );
        }
        return runtimeText(
          `Escalation ${escalationId} sent. Tell the patient you've asked ${clinic.practitionerName} and will text them when you hear back.`,
        );
      },
    ),
  ];
}
