import type { MinervaClient, SessionStore, ViewItem } from "@minerva/client";
import { useEffect, useRef, useState } from "react";
import { useSessionStore } from "./hooks/use-session-store";
import { connectKernel } from "./lib/kernel-connection";
import { createTauriSidecarBridge, fetchDefaultCwd } from "./lib/sidecar-bridge";

interface Session {
  id: string;
  store: SessionStore;
}

interface Ready {
  client: MinervaClient;
  session: Session;
}

// Connection lives outside React: StrictMode double-effects and HMR reloads
// re-enter setup(), which must attach to the running kernel, not respawn it.
let setupPromise: Promise<Ready> | null = null;

function setup(): Promise<Ready> {
  setupPromise ??= (async () => {
    const bridge = createTauriSidecarBridge();
    const client = await connectKernel(bridge);
    const cwd = await fetchDefaultCwd();
    const { sessionId, store } = await client.newSession(cwd);
    return { client, session: { id: sessionId, store } };
  })();
  return setupPromise;
}

export function App() {
  const [ready, setReady] = useState<Ready | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setup().then(
      (value) => {
        if (!cancelled) setReady(value);
      },
      (cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <Centered>
        <p className="text-sm text-destructive">Failed to start the kernel: {error}</p>
      </Centered>
    );
  }
  if (!ready) {
    return (
      <Centered>
        <p className="text-sm text-muted-foreground">Starting kernel…</p>
      </Centered>
    );
  }
  return <Chat client={ready.client} session={ready.session} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-screen items-center justify-center">{children}</div>;
}

function Chat({ client, session }: { client: MinervaClient; session: Session }) {
  const vm = useSessionStore(session.store);
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (vm.items.length > 0) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [vm.items.length]);

  const submit = () => {
    const text = draft.trim();
    if (!text || vm.busy) return;
    setDraft("");
    client.prompt(session.id, text).catch((cause: unknown) => {
      session.store.addError(cause instanceof Error ? cause.message : String(cause));
    });
  };

  return (
    <div className="flex h-screen flex-col">
      <main className="flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {vm.items.map((item, index) => (
            <TranscriptItem key={itemKey(item, index)} item={item} />
          ))}
          {vm.busy && <p className="text-sm text-muted-foreground">Working…</p>}
          <div ref={bottomRef} />
        </div>
      </main>
      <footer className="border-t px-6 py-3">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            rows={2}
            placeholder="Prompt the kernel… (Enter to send, Shift+Enter for a newline)"
            className="flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          {vm.busy ? (
            <button
              type="button"
              onClick={() => client.cancel(session.id)}
              className="rounded-md border px-3 py-2 text-sm text-muted-foreground hover:bg-secondary"
            >
              Cancel
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!draft.trim()}
              className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
            >
              Send
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

/** Stable-enough keys for the tracer bullet: tool items have real ids, and
 * non-tool items only ever append or mutate in place (index is positional). */
function itemKey(item: ViewItem, index: number): string {
  return item.kind === "tool" ? `tool-${item.toolCallId}` : `${item.kind}-${index}`;
}

function TranscriptItem({ item }: { item: ViewItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="self-end rounded-lg bg-secondary px-3 py-2 text-sm whitespace-pre-wrap">
          {item.text}
        </div>
      );
    case "assistant":
      return <div className="text-sm whitespace-pre-wrap">{item.text}</div>;
    case "thought":
      return (
        <div className="text-sm whitespace-pre-wrap text-muted-foreground italic">{item.text}</div>
      );
    case "tool":
      return (
        <div className="rounded-md border px-3 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{item.title}</span> — {item.status}
        </div>
      );
    case "plan":
      return (
        <div className="rounded-md border px-3 py-2 text-xs text-muted-foreground">
          plan: {item.entries.length} step{item.entries.length === 1 ? "" : "s"}
        </div>
      );
    case "info":
      return <div className="text-xs text-muted-foreground">{item.text}</div>;
    case "error":
      return <div className="text-sm text-destructive">{item.text}</div>;
  }
}
