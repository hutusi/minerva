import { describe, expect, test } from "bun:test";
import { createSessionSlots } from "../src/lib/session-slots";

describe("createSessionSlots", () => {
  test("a newer begin supersedes the older in-flight install", () => {
    const slots = createSessionSlots();
    const first = slots.begin("tab");
    const second = slots.begin("tab");
    // Completion order no longer matters: only the latest may commit.
    expect(slots.isCurrent("tab", first)).toBe(false);
    expect(slots.isCurrent("tab", second)).toBe(true);
  });

  test("tabs are independent", () => {
    const slots = createSessionSlots();
    const a = slots.begin("a");
    const b = slots.begin("b");
    expect(slots.isCurrent("a", a)).toBe(true);
    expect(slots.isCurrent("b", b)).toBe(true);
    slots.begin("a");
    expect(slots.isCurrent("a", a)).toBe(false);
    expect(slots.isCurrent("b", b)).toBe(true);
  });

  test("closing a tab invalidates its outstanding install", () => {
    const slots = createSessionSlots();
    const token = slots.begin("tab");
    slots.invalidate("tab");
    expect(slots.isCurrent("tab", token)).toBe(false);
  });

  test("a client swap invalidates everything, and old tokens never resurrect", () => {
    const slots = createSessionSlots();
    const a = slots.begin("a");
    const b = slots.begin("b");
    slots.invalidateAll();
    expect(slots.isCurrent("a", a)).toBe(false);
    expect(slots.isCurrent("b", b)).toBe(false);
    // The counter is global and monotonic: post-clear begins can never hand
    // out a number an outstanding pre-clear completion still holds.
    const fresh = slots.begin("a");
    expect(fresh).toBeGreaterThan(a);
    expect(fresh).toBeGreaterThan(b);
    expect(slots.isCurrent("a", a)).toBe(false);
    expect(slots.isCurrent("a", fresh)).toBe(true);
  });
});
