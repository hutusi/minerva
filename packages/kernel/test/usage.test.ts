import { describe, expect, test } from "bun:test";
import { addUsage, hasUsage } from "../src";

describe("addUsage", () => {
  test("sums all fields", () => {
    expect(
      addUsage(
        { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 2 },
        { inputTokens: 20, outputTokens: 8, cacheReadTokens: 50, cacheWriteTokens: 1 },
      ),
    ).toEqual({ inputTokens: 30, outputTokens: 13, cacheReadTokens: 150, cacheWriteTokens: 3 });
  });

  test("treats an undefined field as zero when the other side has a number", () => {
    expect(addUsage({ inputTokens: 10 }, { inputTokens: undefined, outputTokens: 5 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    });
  });

  test("keeps a field absent when absent on both sides", () => {
    const sum = addUsage({}, {});
    expect(sum.inputTokens).toBeUndefined();
    expect(sum.cacheReadTokens).toBeUndefined();
  });

  test("returns the total unchanged when the turn reported nothing", () => {
    const total = { inputTokens: 10, outputTokens: 5 };
    expect(addUsage(total, undefined)).toBe(total);
  });
});

describe("hasUsage", () => {
  test("false for undefined or all-absent reports", () => {
    expect(hasUsage(undefined)).toBe(false);
    expect(hasUsage({})).toBe(false);
    expect(hasUsage({ inputTokens: undefined, outputTokens: undefined })).toBe(false);
  });

  test("true when any field carries a number, including zero", () => {
    expect(hasUsage({ inputTokens: 0 })).toBe(true);
    expect(hasUsage({ cacheWriteTokens: 3 })).toBe(true);
  });
});
