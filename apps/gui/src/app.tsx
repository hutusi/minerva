import type { MinervaClient, SessionStore } from "@minerva/client";
import { useEffect, useRef, useState } from "react";
import { Transcript } from "./components/chat/Transcript";
import { UsageFooter } from "./components/chat/UsageFooter";
import { PermissionDialog } from "./components/PermissionDialog";
import { useSessionStore } from "./hooks/use-session-store";
import { connectKernel } from "./lib/kernel-connection";
import { createPermissionQueue, type PermissionQueue } from "./lib/permission-queue";
import { createTauriSidecarBridge, fetchDefaultCwd } from "./lib/sidecar-bridge";

interface Session {
  id: string;
  store: SessionStore;
}

interface Ready {
  client: MinervaClient;
  session: Session;
  permissions: PermissionQueue;
}

// Connection lives outside React: StrictMode double-effects and HMR reloads
// re-enter setup(), which must attach to the running kernel, not respawn it.
let setupPromise: Promise<Ready> | null = null;

function setup(): Promise<Ready> {
  setupPromise ??= (async () => {
    const bridge = createTauriSidecarBridge();
    const permissions = createPermissionQueue();
    const client = await connectKernel(bridge, { onPermissionRequest: permissions.handler });
    const cwd = await fetchDefaultCwd();
    const { sessionId, store } = await client.newSession(cwd);
    return { client, session: { id: sessionId, store }, permissions };
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
  return (
    <>
      <Chat client={ready.client} session={ready.session} />
      <PermissionDialog queue={ready.permissions} />
    </>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-screen items-center justify-center">{children}</div>;
}

function Chat({ client, session }: { client: MinervaClient; session: Session }) {
  const vm = useSessionStore(session.store);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLElement>(null);

  // Stick-to-bottom: follow streaming output unless the reader scrolled up.
  // Items identity changes on every applied update, so it is the right trigger.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || vm.items.length === 0) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [vm.items]);

  // Esc cancels the running turn, same key as the TUI.
  useEffect(() => {
    if (!vm.busy) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") client.cancel(session.id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [vm.busy, client, session.id]);

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
      <main ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto flex max-w-3xl flex-col">
          <Transcript items={vm.items} />
          {vm.busy && <p className="mt-3 text-sm text-muted-foreground">Working… (Esc cancels)</p>}
        </div>
      </main>
      <footer className="border-t px-6 py-3">
        <div className="mx-auto flex max-w-3xl flex-col gap-2">
          <div className="flex items-end gap-2">
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
          <UsageFooter modeId={vm.currentModeId} usage={vm.usage} context={vm.context} />
        </div>
      </footer>
    </div>
  );
}
