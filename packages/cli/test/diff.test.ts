import { describe, expect, test } from "bun:test";
import { clipDiff, type DiffLine, diffLines } from "../src/diff";

const render = (lines: DiffLine[]): string[] =>
  lines.map((line) => {
    const mark =
      line.kind === "add" ? "+" : line.kind === "del" ? "-" : line.kind === "gap" ? "…" : " ";
    return `${mark}${line.text}`;
  });

describe("diffLines", () => {
  test("a single changed line keeps surrounding context", () => {
    expect(render(diffLines("a\nb\nc\n", "a\nB\nc\n"))).toEqual([" a", "-b", "+B", " c"]);
  });

  test("null oldText means a new file — all lines added", () => {
    expect(render(diffLines(null, "one\ntwo\n"))).toEqual(["+one", "+two"]);
  });

  test("deleting to empty removes every line", () => {
    expect(render(diffLines("one\ntwo\n", ""))).toEqual(["-one", "-two"]);
  });

  test("LCS interleaves changes instead of del-all/add-all", () => {
    // "b" survives between two independent changes.
    expect(render(diffLines("a\nb\nc\n", "x\nb\ny\n"))).toEqual(["-a", "+x", " b", "-c", "+y"]);
  });

  test("an insertion into identical surroundings is a pure add", () => {
    expect(render(diffLines("a\nc\n", "a\nb\nc\n"))).toEqual([" a", "+b", " c"]);
  });

  test("identical texts produce only context", () => {
    const lines = diffLines("same\nlines\n", "same\nlines\n");
    expect(lines.every((line) => line.kind === "context")).toBe(true);
  });

  test("oversized middle falls back to whole-block del/add", () => {
    // 501 × 501 > 250 000 forces the fallback; changed lines share no order.
    const oldText = Array.from({ length: 501 }, (_, i) => `old-${i}`).join("\n");
    const newText = Array.from({ length: 501 }, (_, i) => `new-${i}`).join("\n");
    const lines = diffLines(oldText, newText);
    expect(lines.slice(0, 501).every((line) => line.kind === "del")).toBe(true);
    expect(lines.slice(501).every((line) => line.kind === "add")).toBe(true);
  });
});

describe("clipDiff", () => {
  const context = (text: string): DiffLine => ({ kind: "context", text });

  test("collapses unchanged runs beyond two context lines into a gap", () => {
    const lines: DiffLine[] = [
      { kind: "del", text: "start" },
      ...Array.from({ length: 10 }, (_, i) => context(`mid-${i}`)),
      { kind: "add", text: "end" },
    ];
    const clipped = clipDiff(lines, 20);
    expect(render(clipped)).toEqual([
      "-start",
      " mid-0",
      " mid-1",
      "…… 6 unchanged lines",
      " mid-8",
      " mid-9",
      "+end",
    ]);
  });

  test("caps the total and reports what was cut", () => {
    const lines: DiffLine[] = Array.from({ length: 30 }, (_, i) => ({
      kind: "add",
      text: `line-${i}`,
    }));
    const clipped = clipDiff(lines, 5);
    expect(clipped).toHaveLength(5);
    expect(clipped.at(-1)).toEqual({ kind: "gap", text: "… 26 more lines" });
  });

  test("small diffs pass through untouched", () => {
    const lines = diffLines("a\nb\n", "a\nc\n");
    expect(clipDiff(lines, 20)).toEqual(lines);
  });
});
