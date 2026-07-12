import type { ViewItem } from "@minerva/client";
import { Markdown } from "./Markdown";
import { PlanItem } from "./PlanItem";
import { ThoughtItem } from "./ThoughtItem";
import { ToolItem } from "./ToolItem";

export function Transcript({ items }: { items: ViewItem[] }) {
  return (
    <div className="flex flex-col gap-3">
      {items.map((item, index) => (
        <TranscriptItem key={itemKey(item, index)} item={item} />
      ))}
    </div>
  );
}

/** Tool items key by their real id; the plan list is a singleton; the rest
 * only ever append or mutate in place, so the index is positional truth. */
function itemKey(item: ViewItem, index: number): string {
  if (item.kind === "tool") return `tool-${item.toolCallId}`;
  if (item.kind === "plan") return "plan";
  return `${item.kind}-${index}`;
}

function TranscriptItem({ item }: { item: ViewItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="max-w-[85%] self-end rounded-lg bg-secondary px-3 py-2 text-sm whitespace-pre-wrap">
          {item.text}
        </div>
      );
    case "assistant":
      return <Markdown text={item.text} />;
    case "thought":
      return <ThoughtItem item={item} />;
    case "tool":
      return <ToolItem item={item} />;
    case "plan":
      return <PlanItem entries={item.entries} />;
    case "info":
      return <div className="text-xs whitespace-pre-wrap text-muted-foreground">{item.text}</div>;
    case "error":
      return <div className="text-sm text-destructive">✖ {item.text}</div>;
  }
}
