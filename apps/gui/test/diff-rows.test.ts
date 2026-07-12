import { describe, expect, test } from "bun:test";
import type { DiffLine } from "@minerva/client";
import { alignDiffRows } from "../src/lib/diff-rows";

const del = (text: string): DiffLine => ({ kind: "del", text });
const add = (text: string): DiffLine => ({ kind: "add", text });
const ctx = (text: string): DiffLine => ({ kind: "context", text });

describe("alignDiffRows", () => {
  test("a modified line pairs del with add on one row", () => {
    expect(alignDiffRows([ctx("a"), del("b"), add("B"), ctx("c")])).toEqual([
      { kind: "pair", left: { kind: "context", text: "a" }, right: { kind: "context", text: "a" } },
      { kind: "pair", left: { kind: "del", text: "b" }, right: { kind: "add", text: "B" } },
      { kind: "pair", left: { kind: "context", text: "c" }, right: { kind: "context", text: "c" } },
    ]);
  });

  test("pure additions leave the left side empty, pure removals the right", () => {
    expect(alignDiffRows([add("new")])).toEqual([
      { kind: "pair", left: { kind: "empty", text: "" }, right: { kind: "add", text: "new" } },
    ]);
    expect(alignDiffRows([del("old")])).toEqual([
      { kind: "pair", left: { kind: "del", text: "old" }, right: { kind: "empty", text: "" } },
    ]);
  });

  test("unequal runs finish against blanks", () => {
    const rows = alignDiffRows([del("1"), del("2"), del("3"), add("x")]);
    expect(rows).toEqual([
      { kind: "pair", left: { kind: "del", text: "1" }, right: { kind: "add", text: "x" } },
      { kind: "pair", left: { kind: "del", text: "2" }, right: { kind: "empty", text: "" } },
      { kind: "pair", left: { kind: "del", text: "3" }, right: { kind: "empty", text: "" } },
    ]);
  });

  test("interleaved del/add runs still pair index-wise until context", () => {
    const rows = alignDiffRows([del("a"), add("A"), del("b"), add("B"), ctx("end")]);
    expect(rows).toEqual([
      { kind: "pair", left: { kind: "del", text: "a" }, right: { kind: "add", text: "A" } },
      { kind: "pair", left: { kind: "del", text: "b" }, right: { kind: "add", text: "B" } },
      {
        kind: "pair",
        left: { kind: "context", text: "end" },
        right: { kind: "context", text: "end" },
      },
    ]);
  });

  test("gap and note lines become full-width bands and split runs", () => {
    const rows = alignDiffRows([
      del("x"),
      { kind: "gap", text: "… 3 unchanged lines" },
      add("y"),
      { kind: "note", text: "\\ new file has no trailing newline" },
    ]);
    expect(rows).toEqual([
      { kind: "pair", left: { kind: "del", text: "x" }, right: { kind: "empty", text: "" } },
      { kind: "band", text: "… 3 unchanged lines" },
      { kind: "pair", left: { kind: "empty", text: "" }, right: { kind: "add", text: "y" } },
      { kind: "band", text: "\\ new file has no trailing newline" },
    ]);
  });

  test("empty input yields no rows", () => {
    expect(alignDiffRows([])).toEqual([]);
  });
});
