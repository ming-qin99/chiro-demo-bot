import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { getClinicSettings } from "./clinic-config.js";
import { sendImessage } from "./sendblue.js";

export async function tickEscalations(now = Date.now()): Promise<void> {
  const clinic = await getClinicSettings();
  if (clinic.staffPhoneNumbers.length === 0) return;
  const reminderMs = clinic.escalationReminderHours * 60 * 60 * 1_000;
  const due = await convex.query(api.escalations.dueForReminder, {
    createdBefore: now - reminderMs,
    remindedBefore: now - reminderMs,
    limit: 50,
  });
  for (const row of due) {
    const text = `Reminder: ${row.patientName ?? "A patient"} is still waiting for an answer to: ${row.question} [${row.escalationId}]`;
    let sent = false;
    for (const staffPhone of clinic.staffPhoneNumbers) {
      const delivered = await sendImessage(staffPhone, text);
      sent = delivered || sent;
      if (delivered) {
        await convex.mutation(api.messages.send, {
          conversationId: `sms:${staffPhone}`,
          role: "assistant",
          content: text,
        });
      }
    }
    if (sent) {
      await convex.mutation(api.escalations.updateStatus, {
        escalationId: row.escalationId,
        status: "pending",
        remindedAt: now,
      });
    }
  }
}

export function startEscalationLoop(intervalMs = 15 * 60 * 1_000): () => void {
  const timer = setInterval(() => {
    tickEscalations().catch((err) => console.error("[escalations] tick failed", err));
  }, intervalMs);
  return () => clearInterval(timer);
}
