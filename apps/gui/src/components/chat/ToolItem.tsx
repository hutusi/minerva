import { firstLines, type ViewItem } from "@minerva/client";
import { DiffView } from "./DiffView";

type ToolViewItem = Extract<ViewItem, { kind: "tool" }>;

const STATUS_DOT: Record<ToolViewItem["status"], string> = {
  pending: "text-yellow-500",
  in_progress: "text-yellow-500 animate-pulse",
  completed: "text-green-500",
  failed: "text-red-500",
};

const PREVIEW_LINES = 4;

export function ToolItem({ item }: { item: ToolViewItem }) {
  const preview = item.output ? firstLines(item.output, PREVIEW_LINES) : null;
  const outputLines = item.output ? item.output.trimEnd().split("\n").length : 0;
  return (
    <div className="text-sm">
      <div className="flex items-baseline gap-2">
        <span className={STATUS_DOT[item.status]}>●</span>
        <span className="font-medium">{item.title}</span>
        <span className="text-xs text-muted-foreground">[{item.status}]</span>
      </div>
      {item.task ? (
        <div className="ml-5 text-xs text-muted-foreground">
          ↳ {item.task.toolCalls} tool call{item.task.toolCalls === 1 ? "" : "s"}
          {item.task.failed > 0 ? ` (${item.task.failed} failed)` : ""}
          {item.task.lastActivity ? ` · ${item.task.lastActivity}` : ""}
        </div>
      ) : null}
      {item.diff ? (
        <div className="ml-5">
          <DiffView diff={item.diff} />
        </div>
      ) : preview ? (
        <div className="ml-5">
          <pre className="mt-1 overflow-x-auto rounded-md bg-muted/30 px-2 py-1 font-mono text-xs text-muted-foreground">
            {preview}
          </pre>
          {outputLines > PREVIEW_LINES && item.output ? (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none">show all {outputLines} lines</summary>
              <pre className="mt-1 overflow-x-auto rounded-md bg-muted/30 px-2 py-1 font-mono">
                {item.output}
              </pre>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
