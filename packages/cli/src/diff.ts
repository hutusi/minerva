/**
 * Line diff for the TUI: the kernel ships full before/after file contents
 * (ACP diff semantics) and the frontend chooses how to present them. Pure
 * and Ink-free so it is unit-testable and reusable by other frontends.
 */

export interface DiffLine {
  kind: "add" | "del" | "context" | "gap";
  text: string;
}

/** Beyond this LCS table size the quadratic DP isn't worth it. */
const LCS_LIMIT = 250_000;

export function diffLines(oldText: string | null, newText: string): DiffLine[] {
  const oldLines = splitLines(oldText ?? "");
  const newLines = splitLines(newText);
  if (oldText === null) {
    return newLines.map((text) => ({ kind: "add", text }) as const);
  }

  // Trim the common prefix/suffix first: real edits touch a few lines of a
  // large file, so this collapses the DP to the changed region.
  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  ) {
    start++;
  }
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  const context = (text: string): DiffLine => ({ kind: "context", text });
  const removed = oldLines.slice(start, oldEnd);
  const added = newLines.slice(start, newEnd);
  const middle =
    removed.length * added.length > LCS_LIMIT
      ? [
          ...removed.map((text) => ({ kind: "del", text }) as const),
          ...added.map((text) => ({ kind: "add", text }) as const),
        ]
      : lcsDiff(removed, added);
  return [
    ...oldLines.slice(0, start).map(context),
    ...middle,
    ...oldLines.slice(oldEnd).map(context),
  ];
}

/**
 * Keep changed lines plus two context lines around each change, collapsing
 * longer unchanged runs into a dim gap marker; then cap the whole thing at
 * `max` rendered lines. Bounds what a huge diff paints into the transcript.
 */
export function clipDiff(lines: DiffLine[], max: number): DiffLine[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.kind === "context") continue;
    for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) {
      keep[j] = true;
    }
  }
  const gap = (count: number): DiffLine => ({
    kind: "gap",
    text: `… ${count} unchanged line${count === 1 ? "" : "s"}`,
  });
  const clipped: DiffLine[] = [];
  let skipped = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (!keep[i]) {
      skipped++;
      continue;
    }
    if (skipped > 0) {
      clipped.push(gap(skipped));
      skipped = 0;
    }
    clipped.push(line);
  }
  if (skipped > 0) clipped.push(gap(skipped));
  if (clipped.length <= max) return clipped;
  const head = clipped.slice(0, Math.max(1, max - 1));
  return [...head, { kind: "gap", text: `… ${clipped.length - head.length} more lines` }];
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  // A trailing newline is a line terminator, not an extra empty line.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Standard LCS DP over the (already trimmed) changed region. */
function lcsDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const rows = oldLines.length;
  const cols = newLines.length;
  // Flat row-major table; lcs(i, j) = LCS length of oldLines[i..] vs newLines[j..].
  const width = cols + 1;
  const table = new Array<number>((rows + 1) * width).fill(0);
  const lcs = (i: number, j: number): number => table[i * width + j] ?? 0;
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      table[i * width + j] =
        oldLines[i] === newLines[j]
          ? lcs(i + 1, j + 1) + 1
          : Math.max(lcs(i + 1, j), lcs(i, j + 1));
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (oldLines[i] === newLines[j]) {
      out.push({ kind: "context", text: oldLines[i] ?? "" });
      i++;
      j++;
    } else if (lcs(i + 1, j) >= lcs(i, j + 1)) {
      out.push({ kind: "del", text: oldLines[i] ?? "" });
      i++;
    } else {
      out.push({ kind: "add", text: newLines[j] ?? "" });
      j++;
    }
  }
  while (i < rows) out.push({ kind: "del", text: oldLines[i++] ?? "" });
  while (j < cols) out.push({ kind: "add", text: newLines[j++] ?? "" });
  return out;
}
