import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Input-history persistence: one JSONL file of `{"text","at"}` lines in the
 * data dir. Frontend-local state (like Ink itself), so it lives beside the
 * entrypoint rather than behind the protocol. Everything here is
 * best-effort — history is a convenience and must never break input.
 */

/** In-memory recall cap, and the size the file is compacted down to. */
const HISTORY_CAP = 500;

/** Compact when the file grows past this many lines: appends stay the cheap
 * common path, and the file (startup cost, prompt retention) stays bounded. */
const COMPACT_THRESHOLD = 1000;

/** Load the newest entries (oldest first), compacting an overgrown file. */
export function loadHistoryFile(path: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter(Boolean);
  const valid = lines.filter((line) => typeof parseEntry(line) === "string");
  if (lines.length > COMPACT_THRESHOLD) {
    // Atomic rewrite of the newest entries, preserving the original lines
    // (incl. timestamps) — same temp+rename pattern as the settings writer.
    try {
      const tmp = `${path}.${randomUUID()}.tmp`;
      writeFileSync(tmp, `${valid.slice(-HISTORY_CAP).join("\n")}\n`, { mode: 0o600 });
      renameSync(tmp, path);
    } catch {
      // Compaction is opportunistic; the loaded history is unaffected.
    }
  }
  return valid
    .slice(-HISTORY_CAP)
    .map(parseEntry)
    .filter((text): text is string => typeof text === "string");
}

/** Fire-and-forget append of one submitted input. */
export function appendHistoryFile(path: string, text: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ text, at: new Date().toISOString() })}\n`, {
      mode: 0o600,
    });
  } catch {
    // Never let persistence failures break input.
  }
}

/** The entry's text, or undefined for torn/foreign lines (skipped). */
function parseEntry(line: string): string | undefined {
  try {
    const parsed = JSON.parse(line) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : undefined;
  } catch {
    return undefined;
  }
}
