import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendHistoryFile, loadHistoryFile } from "../src/history-file";

const tmpPath = () => join(mkdtempSync(join(tmpdir(), "minerva-hist-")), "history.jsonl");

describe("history file persistence", () => {
  test("append/load round-trip in order; missing file loads empty", () => {
    const path = tmpPath();
    expect(loadHistoryFile(path)).toEqual([]);
    appendHistoryFile(path, "first");
    appendHistoryFile(path, "second");
    expect(loadHistoryFile(path)).toEqual(["first", "second"]);
  });

  test("torn and foreign lines are skipped, the rest survives", () => {
    const path = tmpPath();
    appendHistoryFile(path, "kept");
    appendFileSync(path, '{"text": "torn\n');
    appendFileSync(path, '{"other": "shape"}\n');
    appendHistoryFile(path, "also kept");
    expect(loadHistoryFile(path)).toEqual(["kept", "also kept"]);
  });

  test("an overgrown file is compacted to the newest 500 entries on load", () => {
    const path = tmpPath();
    for (let i = 0; i < 1200; i++) {
      appendFileSync(path, `${JSON.stringify({ text: `entry-${i}`, at: "t" })}\n`);
    }
    const loaded = loadHistoryFile(path);
    expect(loaded).toHaveLength(500);
    expect(loaded[0]).toBe("entry-700");
    expect(loaded.at(-1)).toBe("entry-1199");

    // The file itself shrank (bounded startup cost and prompt retention),
    // preserving the original lines including timestamps.
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(500);
    expect(JSON.parse(lines[0] ?? "")).toEqual({ text: "entry-700", at: "t" });
    // A second load is under the threshold — no further rewrite churn.
    expect(loadHistoryFile(path)).toHaveLength(500);
  });
});
