import { formatTokens, type SessionViewModel } from "@minerva/client";

/** Status line matching the TUI footer: mode, token counts, context bar. */
export function UsageFooter({
  modeId,
  usage,
  context,
}: {
  modeId: string | undefined;
  usage: SessionViewModel["usage"];
  context: SessionViewModel["context"];
}) {
  const parts: string[] = [];
  if (modeId && modeId !== "default") parts.push(`mode ${modeId}`);
  if (usage) {
    const { lastTurn, cumulative } = usage;
    const cached =
      cumulative.cacheReadTokens && cumulative.cacheReadTokens > 0
        ? ` (${formatTokens(cumulative.cacheReadTokens)} cached)`
        : "";
    parts.push(
      "tokens",
      ...(lastTurn
        ? [
            `last ${formatTokens(lastTurn.inputTokens)} in / ${formatTokens(lastTurn.outputTokens)} out`,
          ]
        : []),
      `session ${formatTokens(cumulative.inputTokens)} in / ${formatTokens(cumulative.outputTokens)} out${cached}`,
    );
  }
  const pct = context && context.size > 0 ? Math.round((100 * context.used) / context.size) : null;
  if (pct !== null) parts.push(`ctx ${pct}%`);
  if (parts.length === 0) return null;
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>{parts.join(" · ")}</span>
      {pct !== null ? (
        <span className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
          <span
            className={`block h-full ${pct >= 80 ? "bg-red-500" : pct >= 60 ? "bg-yellow-500" : "bg-green-500"}`}
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </span>
      ) : null}
    </div>
  );
}
