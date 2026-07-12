import type { MinervaClient, SessionStore } from "@minerva/client";
import type {
  ConfigSetModelParams,
  ConfigStateResult,
  SessionModeState,
  SessionSummary,
  SkillInfo,
} from "@minerva/protocol";
import { useEffect, useRef, useState } from "react";
import { ConfigDialog } from "./components/ConfigDialog";
import { Transcript } from "./components/chat/Transcript";
import { UsageFooter } from "./components/chat/UsageFooter";
import { HeaderBar } from "./components/HeaderBar";
import { PermissionDialog } from "./components/PermissionDialog";
import { SessionBrowser } from "./components/SessionBrowser";
import { useSessionStore } from "./hooks/use-session-store";
import { connectKernel } from "./lib/kernel-connection";
import { pickFolder } from "./lib/native";
import { createPermissionQueue, type PermissionQueue } from "./lib/permission-queue";
import { createTauriSidecarBridge, fetchDefaultCwd } from "./lib/sidecar-bridge";

interface Session {
  id: string;
  store: SessionStore;
  cwd: string;
  modes: SessionModeState | null;
  profile: string | null;
  skills: SkillInfo[];
  profiles: string[];
}

interface Boot {
  client: MinervaClient;
  permissions: PermissionQueue;
  config: ConfigStateResult;
}

// Connection lives outside React: StrictMode double-effects and HMR reloads
// re-enter boot(), which must attach to the running kernel, not respawn it.
// The session is created separately — first run configures a model first.
let bootPromise: Promise<Boot> | null = null;
let sessionPromise: Promise<Session> | null = null;

function boot(): Promise<Boot> {
  bootPromise ??= (async () => {
    const bridge = createTauriSidecarBridge();
    const permissions = createPermissionQueue();
    const client = await connectKernel(bridge, { onPermissionRequest: permissions.handler });
    const config = await client.getConfigState();
    return { client, permissions, config };
  })();
  return bootPromise;
}

/** Skills and profiles are assistive; a project without them must not block
 * the session. Both are cwd-scoped (project settings layer). */
async function fetchExtras(
  client: MinervaClient,
  cwd: string,
): Promise<{ skills: SkillInfo[]; profiles: string[] }> {
  const [skills, profiles] = await Promise.all([
    client.listSkills(cwd).catch(() => []),
    client
      .listProfiles(cwd)
      .then((result) => result.profiles.map((p) => p.name))
      .catch(() => []),
  ]);
  return { skills, profiles };
}

async function createSession(
  client: MinervaClient,
  cwd: string,
  profile?: string,
): Promise<Session> {
  const result = await client.newSession(cwd, profile !== undefined ? { profile } : {});
  return {
    id: result.sessionId,
    store: result.store,
    cwd,
    modes: result.modes ?? null,
    profile: result.profile ?? null,
    ...(await fetchExtras(client, cwd)),
  };
}

async function resumeSession(client: MinervaClient, summary: SessionSummary): Promise<Session> {
  const result = await client.loadSession(summary.sessionId, summary.cwd);
  return {
    id: result.sessionId,
    store: result.store,
    cwd: summary.cwd,
    modes: result.modes ?? null,
    profile: result.profile ?? null,
    ...(await fetchExtras(client, summary.cwd)),
  };
}

function openInitialSession(client: MinervaClient): Promise<Session> {
  sessionPromise ??= (async () => createSession(client, await fetchDefaultCwd()))();
  return sessionPromise;
}

export function App() {
  const [ready, setReady] = useState<Boot | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [configState, setConfigState] = useState<ConfigStateResult | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fail = (cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    };
    boot().then((value) => {
      if (cancelled) return;
      setReady(value);
      if (value.config.needsApiKey) {
        // First run: no usable key — configure before any session exists.
        setConfigState(value.config);
      } else {
        openInitialSession(value.client).then((s) => !cancelled && setSession(s), fail);
      }
    }, fail);
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
  const client = ready.client;

  const reportError = (cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (session) session.store.addError(message);
    else setError(message);
  };

  /** Swap the active session: cancel a running turn, detach the old store. */
  const switchTo = (next: Promise<Session>) => {
    sessionPromise = next;
    const previous = session;
    next.then((value) => {
      if (previous && previous.id !== value.id) {
        if (previous.store.snapshot.busy) client.cancel(previous.id);
        client.closeSession(previous.id);
      }
      setSession(value);
      setBrowserOpen(false);
    }, reportError);
  };

  const applyConfig = async (params: ConfigSetModelParams) => {
    await client.setModel(params);
    setConfigState(null);
    if (!session) switchTo(openInitialSession(client));
  };

  const openConfig = () => {
    client.getConfigState().then(setConfigState, reportError);
  };

  return (
    <>
      {session ? (
        <Chat
          client={client}
          session={session}
          profiles={session.profiles}
          onOpenConfig={openConfig}
          onOpenFolder={() => {
            pickFolder().then((path) => {
              if (path) switchTo(createSession(client, path));
            }, reportError);
          }}
          onOpenSessions={() => setBrowserOpen(true)}
          onNewSession={() =>
            switchTo(createSession(client, session.cwd, session.profile ?? undefined))
          }
          onSetProfile={(profile) => {
            client.setProfile(session.id, profile).then(() => {
              setSession({ ...session, profile });
              session.store.addInfo(`profile → ${profile ?? "(none)"}`);
            }, reportError);
          }}
        />
      ) : (
        <Centered>
          <p className="text-sm text-muted-foreground">
            {configState ? "Configure a model to get started." : "Opening session…"}
          </p>
        </Centered>
      )}
      {browserOpen && session ? (
        <SessionBrowser
          client={client}
          cwd={session.cwd}
          currentId={session.id}
          onPick={(summary) => switchTo(resumeSession(client, summary))}
          onClose={() => setBrowserOpen(false)}
        />
      ) : null}
      {configState ? (
        <ConfigDialog
          state={configState}
          onSubmit={applyConfig}
          onClose={session ? () => setConfigState(null) : undefined}
        />
      ) : null}
      <PermissionDialog queue={ready.permissions} />
    </>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-screen items-center justify-center">{children}</div>;
}

function Chat({
  client,
  session,
  profiles,
  onOpenConfig,
  onOpenFolder,
  onOpenSessions,
  onNewSession,
  onSetProfile,
}: {
  client: MinervaClient;
  session: Session;
  profiles: string[];
  onOpenConfig: () => void;
  onOpenFolder: () => void;
  onOpenSessions: () => void;
  onNewSession: () => void;
  onSetProfile: (profile: string | null) => void;
}) {
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

  const reportError = (cause: unknown) => {
    session.store.addError(cause instanceof Error ? cause.message : String(cause));
  };

  const submit = () => {
    const text = draft.trim();
    if (!text || vm.busy) return;
    setDraft("");
    client.prompt(session.id, text).catch(reportError);
  };

  // Skill autocomplete: assistive only — any text, /-prefixed or not, goes to
  // the kernel verbatim (it expands known /skills into their instructions).
  const skillMatches =
    draft.startsWith("/") && !draft.includes(" ")
      ? session.skills.filter((skill) => skill.name.startsWith(draft.slice(1)))
      : [];

  return (
    <div className="flex h-screen flex-col">
      <HeaderBar
        cwd={session.cwd}
        modes={session.modes}
        currentModeId={vm.currentModeId}
        profiles={profiles}
        profile={session.profile}
        busy={vm.busy}
        onOpenFolder={onOpenFolder}
        onOpenSessions={onOpenSessions}
        onNewSession={onNewSession}
        onSetMode={(modeId) => {
          client.setMode(session.id, modeId).then(() => session.store.setMode(modeId), reportError);
        }}
        onSetProfile={onSetProfile}
        onCompact={() => {
          client
            .compact(session.id)
            .then(() => session.store.addInfo("context compacted"), reportError);
        }}
      />
      <main ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto flex max-w-3xl flex-col">
          <Transcript items={vm.items} />
          {vm.busy && <p className="mt-3 text-sm text-muted-foreground">Working… (Esc cancels)</p>}
        </div>
      </main>
      <footer className="border-t px-6 py-3">
        <div className="mx-auto flex max-w-3xl flex-col gap-2">
          {skillMatches.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {skillMatches.map((skill) => (
                <button
                  key={skill.name}
                  type="button"
                  onClick={() => setDraft(`/${skill.name} `)}
                  title={skill.description}
                  className="rounded-md border px-2 py-0.5 text-xs text-muted-foreground hover:bg-secondary"
                >
                  /{skill.name}
                </button>
              ))}
            </div>
          ) : null}
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
          <div className="flex items-center justify-between">
            <UsageFooter modeId={vm.currentModeId} usage={vm.usage} context={vm.context} />
            <button
              type="button"
              onClick={onOpenConfig}
              title="Model & provider settings"
              className="ml-auto rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-secondary"
            >
              ⚙ model
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
