import { describe, expect, it } from "vitest";
import {
  matchesClinicalQuestionDemoPrompt,
  matchesDemoSlotChoice,
  matchesRescheduleDemoPrompt,
} from "../server/scripted-demo-replies.js";

describe("scripted demo replies", () => {
  it("matches appointment reschedule requests with normal texting punctuation", () => {
    expect(matchesRescheduleDemoPrompt("Can I move my Thursday appointment?")).toBe(true);
    expect(matchesRescheduleDemoPrompt("  reschedule   my appt!!! ")).toBe(true);
  });

  it("does not intercept unrelated messages", () => {
    expect(matchesRescheduleDemoPrompt("What are your hours?")).toBe(false);
    expect(matchesRescheduleDemoPrompt("My shoulder feels sore")).toBe(false);
  });

  it("matches clinical questions that should escalate", () => {
    expect(matchesClinicalQuestionDemoPrompt("Should I keep exercising if the pain is worse?")).toBe(true);
    expect(matchesClinicalQuestionDemoPrompt("Is it normal to feel sore after today?")).toBe(true);
  });

  it("does not treat front-desk questions as clinical escalations", () => {
    expect(matchesClinicalQuestionDemoPrompt("Can I move my appointment?")).toBe(false);
    expect(matchesClinicalQuestionDemoPrompt("What are your opening hours?")).toBe(false);
  });

  it("normalizes the two scripted slot choices", () => {
    expect(matchesDemoSlotChoice("Tuesday at 3 please")).toBe("Tuesday 3pm");
    expect(matchesDemoSlotChoice("Wed 10:30 works")).toBe("Wednesday 10:30am");
  });
});
