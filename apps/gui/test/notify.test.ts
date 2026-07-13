import { describe, expect, test } from "bun:test";
import { decideNotification, NOTIFY_MIN_TURN_MS } from "../src/lib/notify";

const BASE = {
  stopReason: "end_turn" as const,
  focused: false,
  durationMs: NOTIFY_MIN_TURN_MS + 1,
  muted: false,
  project: "minerva",
};

describe("decideNotification", () => {
  test("a long unfocused completed turn notifies with the project name", () => {
    expect(decideNotification(BASE)).toEqual({
      title: "Minerva finished a turn",
      body: "minerva — The reply is ready.",
    });
  });

  test("suppressed when focused, muted, quick, or user-cancelled", () => {
    expect(decideNotification({ ...BASE, focused: true })).toBeNull();
    expect(decideNotification({ ...BASE, muted: true })).toBeNull();
    expect(decideNotification({ ...BASE, durationMs: NOTIFY_MIN_TURN_MS - 1 })).toBeNull();
    expect(decideNotification({ ...BASE, stopReason: "cancelled" })).toBeNull();
  });

  test("abnormal stops escalate the title", () => {
    for (const stopReason of ["max_tokens", "max_turn_requests", "refusal"] as const) {
      const result = decideNotification({ ...BASE, stopReason });
      expect(result?.title).toBe("Minerva needs attention");
    }
    expect(decideNotification({ ...BASE, stopReason: "max_tokens" })?.body).toContain(
      "output-token limit",
    );
  });
});
