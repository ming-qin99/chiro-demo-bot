import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { broadcast } from "./broadcast.js";
import { getClinicSettings } from "./clinic-config.js";
import { redactPhoneNumbers } from "./privacy.js";

const DEMO_MODE_SETTING_KEY = "debug_demo_mode";

type RescheduleState = { stage: "slot" | "confirm"; slot?: string };
const rescheduleStates = new Map<string, RescheduleState>();
const pendingClinicalQuestions = new Map<
  string,
  {
    patientPhone: string;
    patientConversationId: string;
    question: string;
    practitionerName: string;
  }
>();

function normalizeDemoPrompt(content: string): string {
  return content
    .trim()
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .replace(/[?.!]+$/g, "");
}

export function matchesRescheduleDemoPrompt(content: string): boolean {
  const prompt = normalizeDemoPrompt(content);
  return (
    /\b(move|change|reschedule)\b.*\b(appt|appointment|session|booking)\b/.test(prompt) ||
    /\b(appt|appointment|session|booking)\b.*\b(move|change|reschedule)\b/.test(prompt)
  );
}

export function matchesClinicalQuestionDemoPrompt(content: string): boolean {
  const prompt = normalizeDemoPrompt(content);
  return (
    /\b(should i|is it normal|what should i do|can i)\b.*\b(pain|sore|swelling|numb|exercise|stretch|headache|worse)\b/.test(
      prompt,
    ) || /\b(pain|sore|swelling|numbness|headache)\b.*\b(after|since|today|worse)\b/.test(prompt)
  );
}

export function matchesDemoSlotChoice(content: string): "Tuesday 3pm" | "Wednesday 10:30am" | null {
  const prompt = normalizeDemoPrompt(content);
  if (/\b(tue|tues|tuesday)\b.*\b3(?::00)?\s*(?:pm)?\b/.test(prompt)) return "Tuesday 3pm";
  if (/\b(wed|weds|wednesday)\b.*\b10(?::30)?\b/.test(prompt)) return "Wednesday 10:30am";
  return null;
}

function isConfirmation(content: string): boolean {
  return /^(yes|yep|yeah|confirm|go ahead|do it|please do|sounds good|perfect)$/i.test(
    normalizeDemoPrompt(content),
  );
}

function randomDemoTurnId(): string {
  return `demo_turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function demoModeEnabled(): Promise<boolean> {
  try {
    const value = await convex.query(api.settings.get, { key: DEMO_MODE_SETTING_KEY });
    return value === "true";
  } catch (err) {
    console.error("[demo-script] failed to read demo mode setting", err);
    return false;
  }
}

type ScriptedDemoReplyDeps = {
  sendImessage: (toNumber: string, text: string) => Promise<void | boolean>;
  sendTypingIndicator: (toNumber: string) => Promise<void>;
};

type ScriptedDemoReplyOpts = {
  conversationId: string;
  content: string;
  fromNumber: string;
  turnTag: string;
};

async function persistMessage(
  conversationId: string,
  role: "user" | "assistant",
  content: string,
  turnId: string,
): Promise<void> {
  await convex.mutation(api.messages.send, { conversationId, role, content, turnId });
  broadcast(role === "user" ? "user_message" : "assistant_message", {
    conversationId,
    content,
  });
}

export async function maybeHandleScriptedDemoReply(
  opts: ScriptedDemoReplyOpts,
  deps: ScriptedDemoReplyDeps,
): Promise<boolean> {
  const reschedule = rescheduleStates.get(opts.fromNumber);
  const staffAnswer = pendingClinicalQuestions.get(opts.fromNumber);
  const firstReschedule = matchesRescheduleDemoPrompt(opts.content);
  const firstClinical = matchesClinicalQuestionDemoPrompt(opts.content);
  if (!reschedule && !staffAnswer && !firstReschedule && !firstClinical) return false;
  if (!(await demoModeEnabled())) {
    rescheduleStates.delete(opts.fromNumber);
    pendingClinicalQuestions.delete(opts.fromNumber);
    return false;
  }

  const turnId = randomDemoTurnId();
  const log = (message: string) => console.log(`[turn ${opts.turnTag}] [demo-script] ${message}`);
  await persistMessage(opts.conversationId, "user", opts.content, turnId);

  const sendTo = async (phone: string, conversationId: string, content: string): Promise<void> => {
    const text = redactPhoneNumbers(content.trim());
    if (!text) return;
    await deps.sendImessage(phone, text);
    await persistMessage(conversationId, "assistant", text, turnId);
    log(`→ ${JSON.stringify(text)}`);
  };

  if (staffAnswer) {
    pendingClinicalQuestions.delete(opts.fromNumber);
    await deps.sendTypingIndicator(staffAnswer.patientPhone);
    await wait(500);
    await sendTo(
      staffAnswer.patientPhone,
      staffAnswer.patientConversationId,
      `${staffAnswer.practitionerName} got back to me: ${opts.content}`,
    );
    await sendTo(opts.fromNumber, opts.conversationId, "Thanks — I’ve passed that on to the patient.");
    return true;
  }

  if (reschedule?.stage === "slot") {
    const slot = matchesDemoSlotChoice(opts.content);
    if (!slot) {
      await sendTo(
        opts.fromNumber,
        opts.conversationId,
        "I can hold Tuesday at 3pm or Wednesday at 10:30am. Which suits you?",
      );
      return true;
    }
    rescheduleStates.set(opts.fromNumber, { stage: "confirm", slot });
    await deps.sendTypingIndicator(opts.fromNumber);
    await wait(400);
    await sendTo(
      opts.fromNumber,
      opts.conversationId,
      `I can move you to ${slot}. Reply yes to confirm the change.`,
    );
    return true;
  }

  if (reschedule?.stage === "confirm") {
    if (!isConfirmation(opts.content)) {
      await sendTo(
        opts.fromNumber,
        opts.conversationId,
        `No problem — I’m still holding ${reschedule.slot}. Reply yes to confirm, or tell me another time.`,
      );
      return true;
    }
    rescheduleStates.delete(opts.fromNumber);
    await deps.sendTypingIndicator(opts.fromNumber);
    await wait(650);
    await sendTo(
      opts.fromNumber,
      opts.conversationId,
      `Done — your appointment is now ${reschedule.slot}. I’ve sent an updated confirmation.`,
    );
    return true;
  }

  if (firstReschedule) {
    rescheduleStates.set(opts.fromNumber, { stage: "slot" });
    await deps.sendTypingIndicator(opts.fromNumber);
    await wait(500);
    await sendTo(
      opts.fromNumber,
      opts.conversationId,
      "Absolutely — I can offer Tuesday at 3pm or Wednesday at 10:30am. Which works better?",
    );
    return true;
  }

  const clinic = await getClinicSettings();
  const staffPhone = clinic.demoStaffPhone ?? clinic.staffPhoneNumbers[0];
  await deps.sendTypingIndicator(opts.fromNumber);
  await wait(350);
  await sendTo(
    opts.fromNumber,
    opts.conversationId,
    `I don’t want to guess about that. I’ll check with ${clinic.practitionerName} and text you as soon as I hear back.`,
  );
  if (staffPhone && staffPhone !== opts.fromNumber) {
    pendingClinicalQuestions.set(staffPhone, {
      patientPhone: opts.fromNumber,
      patientConversationId: opts.conversationId,
      question: opts.content,
      practitionerName: clinic.practitionerName,
    });
    await sendTo(
      staffPhone,
      `sms:${staffPhone}`,
      `❓ Demo patient asked: ${opts.content}\nReply here and I’ll relay your answer.`,
    );
  }
  return true;
}
