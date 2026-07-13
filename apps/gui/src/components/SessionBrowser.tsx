import type { MinervaClient } from "@minerva/client";
import type { SessionSummary } from "@minerva/protocol";
import { useEffect, useState } from "react";

/** Pick a persisted session for a project — reads the kernel's JSONL index
 * via minerva/sessions/list, so TUI-created sessions appear too. */
export function SessionBrowser({
  client,
  cwd,
  currentId,
  onPick,
  onClose,
}: {
  client: MinervaClient;
  cwd: string;
  currentId: string | null;
  onPick: (summary: SessionSummary) => void;
  onClose: () => void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client.listSessions(cwd).then(
      (list) => {
        // The kernel already returns newest-first (capped at 20).
        if (!cancelled) setSessions(list);
      },
      (cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, cwd]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
      <div className="flex max-h-[70vh] w-full max-w-lg flex-col rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-sm font-semibold">Sessions</span>
          <span className="truncate pl-4 text-xs text-muted-foreground">{cwd}</span>
        </div>
        <div className="flex-1 overflow-y-auto">
          {error ? <div className="text-sm text-destructive">✖ {error}</div> : null}
          {sessions === null && !error ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : null}
          {sessions?.length === 0 ? (
            <div className="text-sm text-muted-foreground">No sessions for this project yet.</div>
          ) : null}
          {sessions?.map((summary) => (
            <button
              key={summary.sessionId}
              type="button"
              disabled={summary.sessionId === currentId}
              onClick={() => onPick(summary)}
              className="block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-secondary disabled:opacity-50"
            >
              <span className="block truncate">{summary.preview ?? "(no preview)"}</span>
              <span className="text-xs text-muted-foreground">
                {new Date(summary.createdAt).toLocaleString()} · {summary.sessionId.slice(0, 12)}
                {summary.sessionId === currentId ? " · current" : ""}
              </span>
            </button>
          ))}
        </div>
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-3 py-1.5 text-sm text-muted-foreground hover:bg-secondary"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
