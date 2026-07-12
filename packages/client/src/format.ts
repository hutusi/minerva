/**
 * Display formatting shared by frontends (design decision #8): pure text
 * helpers with no UI imports, so the Ink CLI and the GUI render identical
 * token counts, output previews, and streaming-thought tails.
 */

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${trimDecimal(count / 1_000_000)}M`;
  if (count >= 1_000) return `${trimDecimal(count / 1_000)}k`;
  return String(count);
}

function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

/** Keep the first or last `count` lines, marking the truncation. */
export function clipLines(text: string, count: number, keep: "first" | "last"): string {
  const lines = text.trimEnd().split("\n");
  if (lines.length <= count) return lines.join("\n");
  return keep === "first"
    ? `${lines.slice(0, count).join("\n")}\n… (${lines.length - count} more lines)`
    : `… ${lines.slice(-count).join("\n")}`;
}

export const firstLines = (text: string, count: number): string => clipLines(text, count, "first");

/**
 * Rolling tail for a streaming thought: the last few lines, but also capped by
 * a character budget from the display width — a long reasoning paragraph with
 * no newlines (routine for Qwen/Chinese reasoning) is under the line cap yet
 * would still flood the live region.
 */
export function thoughtTail(text: string, columns: number): string {
  const clipped = clipLines(text, 4, "last");
  const budget = 4 * Math.max(20, columns - 4);
  if (clipped.length <= budget) return clipped;
  // Strip any leading ellipsis clipLines added so we don't double it.
  const body = clipped.startsWith("… ") ? clipped.slice(2) : clipped;
  return `… ${body.slice(-budget)}`;
}
