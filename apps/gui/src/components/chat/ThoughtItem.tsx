import { formatTokens, thoughtTail, type ViewItem } from "@minerva/client";

/** Character-budget width for the streaming tail — the GUI has no terminal
 * columns, so use a fixed width comparable to an editor pane. */
const TAIL_COLUMNS = 100;

/**
 * Model reasoning: a rolling tail while it streams (full thoughts run to
 * thousands of chars), then a collapsed summary the reader can expand —
 * the GUI upgrade over the TUI's summary-only line.
 */
export function ThoughtItem({ item }: { item: Extract<ViewItem, { kind: "thought" }> }) {
  if (item.streaming) {
    return (
      <div className="text-sm whitespace-pre-wrap text-muted-foreground italic">
        ✻ {thoughtTail(item.text, TAIL_COLUMNS)}
      </div>
    );
  }
  return (
    <details className="text-sm text-muted-foreground">
      <summary className="cursor-pointer select-none italic">
        ✻ thought · {formatTokens(item.text.length)} chars
      </summary>
      <div className="mt-1 ml-5 whitespace-pre-wrap italic">{item.text}</div>
    </details>
  );
}
