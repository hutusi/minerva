import { firstLines } from "@minerva/client";
import type {
  PermissionOptionKind,
  RequestPermissionParams,
  RequestPermissionResult,
} from "@minerva/protocol";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { PermissionQueue } from "../lib/permission-queue";
import { DiffView } from "./chat/DiffView";

/** Same hotkeys as the TUI, keyed by option KIND so the kernel can rename
 * or reorder options without breaking muscle memory. */
const HOTKEYS: Record<string, PermissionOptionKind> = {
  y: "allow_once",
  a: "allow_always",
  n: "reject_once",
};

function hotkeyFor(kind: PermissionOptionKind): string | undefined {
  return Object.entries(HOTKEYS).find(([, k]) => k === kind)?.[0];
}

const OPTION_STYLE: Record<PermissionOptionKind, string> = {
  allow_once: "bg-primary text-primary-foreground hover:opacity-90",
  allow_always: "border hover:bg-secondary",
  reject_once: "border text-destructive hover:bg-destructive/10",
  reject_always: "border text-destructive hover:bg-destructive/10",
};

export function PermissionDialog({ queue }: { queue: PermissionQueue }) {
  const subscribe = useCallback((listener: () => void) => queue.subscribe(listener), [queue]);
  const { current, depth } = useSyncExternalStore(subscribe, () => queue.snapshot);

  const respond = useCallback(
    (result: RequestPermissionResult) => current?.resolve(result),
    [current],
  );

  useEffect(() => {
    if (!current) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // ACP cancelled outcome: abandon the whole turn, not just this call.
        respond({ outcome: { outcome: "cancelled" } });
        event.stopPropagation();
        return;
      }
      const kind = HOTKEYS[event.key.toLowerCase()];
      const option = kind && current.request.options.find((o) => o.kind === kind);
      if (option) respond({ outcome: { outcome: "selected", optionId: option.optionId } });
    };
    // Capture phase so the chat's own Esc-cancels-turn handler never races.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [current, respond]);

  if (!current) return null;
  const { toolCall, options, taskToolCallId } = current.request;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
      <div className="w-full max-w-lg rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg">
        <div className="text-sm font-semibold text-yellow-600 dark:text-yellow-400">
          Permission required{taskToolCallId ? " (from subagent)" : ""}
          {depth > 1 ? ` · ${depth - 1} more waiting` : ""}
        </div>
        <div className="mt-1 text-sm font-medium">{toolCall.title}</div>
        <PermissionPreview toolCall={toolCall} />
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {options.map((option) => {
            const hotkey = hotkeyFor(option.kind);
            return (
              <button
                key={option.optionId}
                type="button"
                onClick={() =>
                  respond({ outcome: { outcome: "selected", optionId: option.optionId } })
                }
                className={`rounded-md px-3 py-1.5 text-sm ${OPTION_STYLE[option.kind]}`}
              >
                {option.name}
                {hotkey ? <span className="ml-1 opacity-60">({hotkey})</span> : null}
              </button>
            );
          })}
        </div>
        <div className="mt-2 text-right text-xs text-muted-foreground">esc cancels the turn</div>
      </div>
    </div>
  );
}

/**
 * What the call will actually do, from rawInput: the command for execute,
 * the line diff for edits, the full (all-added) content for new files, the
 * URL for fetches. Field-sniffed rather than tool-name-matched so MCP tools
 * with the same shapes get previews for free (same rule as the TUI).
 */
function PermissionPreview({ toolCall }: { toolCall: RequestPermissionParams["toolCall"] }) {
  const raw = toolCall.rawInput;
  if (typeof raw !== "object" || raw === null) return null;
  const input = raw as Record<string, unknown>;
  if (typeof input.command === "string") {
    return (
      <pre className="mt-2 overflow-x-auto rounded-md bg-muted/30 px-2 py-1 font-mono text-xs text-muted-foreground">
        {firstLines(input.command, 20)}
      </pre>
    );
  }
  if (typeof input.old_string === "string" && typeof input.new_string === "string") {
    return <DiffView diff={{ oldText: input.old_string, newText: input.new_string }} />;
  }
  if (toolCall.kind === "edit" && typeof input.content === "string") {
    return <DiffView diff={{ oldText: null, newText: input.content }} />;
  }
  if (typeof input.url === "string") {
    return <div className="mt-2 truncate text-xs text-muted-foreground">{input.url}</div>;
  }
  return null;
}
