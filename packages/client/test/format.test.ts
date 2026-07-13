import { describe, expect, test } from "bun:test";
import { clipLines, firstLines, formatTokens, thoughtTail } from "../src/format";

describe("clipLines", () => {
  test("keeps the first lines with a remaining-count marker", () => {
    const text = "a\nb\nc\nd\ne";
    expect(clipLines(text, 2, "first")).toBe("a\nb\n… (3 more lines)");
    expect(clipLines(text, 10, "first")).toBe(text);
  });

  test("keeps the last lines with a leading ellipsis", () => {
    const text = "a\nb\nc\nd\ne";
    expect(clipLines(text, 2, "last")).toBe("… d\ne");
    expect(clipLines(text, 10, "last")).toBe(text);
  });

  test("firstLines is the first-keeping shorthand", () => {
    expect(firstLines("a\nb\nc", 2)).toBe("a\nb\n… (1 more lines)");
  });
});

describe("thoughtTail", () => {
  test("caps a long unbroken paragraph by display width", () => {
    const paragraph = "x".repeat(5000); // no newlines: under the line cap
    const columns = 80;
    const tail = thoughtTail(paragraph, columns);
    const budget = 4 * (columns - 4);
    // Bounded to the width budget plus the "… " prefix, keeping the tail end.
    expect(tail.length).toBeLessThanOrEqual(budget + 2);
    expect(tail.startsWith("… ")).toBe(true);
    expect(paragraph.endsWith(tail.slice(2))).toBe(true);
  });

  test("leaves a short thought untouched", () => {
    expect(thoughtTail("brief thought", 80)).toBe("brief thought");
  });
});

describe("formatTokens", () => {
  test("abbreviates thousands and millions, trimming .0", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_000)).toBe("1k");
    expect(formatTokens(1_536)).toBe("1.5k");
    expect(formatTokens(2_000_000)).toBe("2M");
    expect(formatTokens(2_450_000)).toBe("2.5M");
  });
});
