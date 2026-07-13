import type { MinervaClient, SessionStore } from "@minerva/client";
import type {
  ConfigSetModelParams,
  ConfigStateResult,
  SessionModeState,
  SessionSummary,
  SkillInfo,
} from "@minerva/protocol";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ConfigDialog } from "./components/ConfigDialog";
import { Transcript } from "./components/chat/Transcript";
import { UsageFooter } from "./components/chat/UsageFooter";
import { HeaderBar } from "./components/HeaderBar";
import { PermissionDialog } from "./components/PermissionDialog";
import { ProjectTabs } from "./components/ProjectTabs";
import { SessionBrowser } from "./components/SessionBrowser";
import { useSessionStore } from "./hooks/use-session-store";
import { createKernelManager, type KernelManager } from "./lib/kernel-manager";
import { notify, pickFolder } from "./lib/native";
import { decideNotification } from "./lib/notify";
import { createSessionSlots } from "./lib/session-slots";
import { createTauriSidecarBridge, fetchDefaultCwd } from "./lib/sidecar-bridge";
import { ensureTabSession, isStaleSessionError } from "./lib/tab-session";
import { deserializeTabs, EMPTY_TABS, serializeTabs, type Tab, tabsReducer } from "./lib/tabs";

const TABS_KEY = "minerva.tabs.v1";
const NOTIFY_MUTED_KEY = "minerva.notifyMuted.v1";

interface Session {
  id: string;
  store: SessionStore;
  cwd: string;
  modes: SessionModeState | null;
  profile: string | null;
  skills: SkillInfo[];
  profiles: string[];
}

// The manager lives outside React: StrictMode double-effects and HMR reloads
// must attach to the running kernel, not respawn it.
let managerSingleton: KernelManager | null = null;
function getManager(): KernelManager {
  managerSingleton ??= createKernelManager(createTauriSidecarBridge());
  managerSingleton.start();
  return managerSingleton;
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

async function resumeSession(
  client: MinervaClient,
  sessionId: string,
  cwd: string,
): Promise<Session> {
  const result = await client.loadSession(sessionId, cwd);
  return {
    id: result.sessionId,
    store: result.store,
    cwd,
    modes: result.modes ?? null,
    profile: result.profile ?? null,
    ...(await fetchExtras(client, cwd)),
  };
}

export function App() {
  const manager = useMemo(getManager, []);
  const kernel = useSyncExternalStore(
    useCallback((listener: () => void) => manager.subscribe(listener), [manager]),
    () => manager.snapshot,
  );
  const [tabs, dispatch] = useReducer(
    tabsReducer,
    undefined,
    () => deserializeTabs(localStorage.getItem(TABS_KEY)) ?? EMPTY_TABS,
  );
  const [sessions, setSessions] = useState<ReadonlyMap<string, Session>>(new Map());
  const [configState, setConfigState] = useState<ConfigStateResult | null>(null);
  const [configDone, setConfigDone] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const ensuring = useRef(new Set<string>());
  // Unsent composer drafts survive tab switches (Chat remounts per tab).
  const drafts = useRef(new Map<string, string>());
  // Async install results commit only while their token is current — a newer
  // switch, a closed tab, or a replaced client makes them stale (discarded
  // AND closed, so no invisible client registration survives).
  const slots = useRef(createSessionSlots());
  // Authoritative sessions map, updated synchronously at commit time; React
  // state mirrors it for rendering. Completion handlers must never read the
  // render-closure `sessions` — it can lag behind a just-committed install.
  const sessionsRef = useRef<ReadonlyMap<string, Session>>(new Map());

  // Stable (touches only refs + the stable state setter) so effects can
  // depend on it without re-running.
  const commitSession = useCallback(
    (tabId: string, session: Session, activeClient: MinervaClient) => {
      const previous = sessionsRef.current.get(tabId);
      if (previous && previous.id !== session.id) {
        if (previous.store.snapshot.busy) activeClient.cancel(previous.id);
        activeClient.closeSession(previous.id);
      }
      const next = new Map(sessionsRef.current).set(tabId, session);
      sessionsRef.current = next;
      setSessions(next);
    },
    [],
  );

  const removeSession = (tabId: string) => {
    const next = new Map(sessionsRef.current);
    next.delete(tabId);
    sessionsRef.current = next;
    setSessions(next);
  };

  /** The single write path for in-place session patches (profile switches,
   * future metadata edits): applies only while the SAME session is still
   * installed in the tab — a delayed response after a switch must not
   * reinstall a detached store — and keeps sessionsRef and React state in
   * lockstep so later commits can't rebuild from a stale reference. */
  const updateSession = useCallback(
    (tabId: string, sessionId: string, patch: Partial<Session>): boolean => {
      const current = sessionsRef.current.get(tabId);
      if (!current || current.id !== sessionId) return false;
      const next = new Map(sessionsRef.current).set(tabId, { ...current, ...patch });
      sessionsRef.current = next;
      setSessions(next);
      return true;
    },
    [],
  );

  const client = kernel.phase === "ready" ? kernel.client : null;
  // Gate sessions on configuration: first run must store a key first.
  const configReady = client !== null && (!kernel.config?.needsApiKey || configDone);
  const activeTab = tabs.tabs.find((tab) => tab.id === tabs.activeTabId) ?? null;
  const activeSession = activeTab ? (sessions.get(activeTab.id) ?? null) : null;

  // A restart hands out a FRESH client; every store from the old one is dead,
  // and any in-flight install against it must fail its token check.
  // biome-ignore lint/correctness/useExhaustiveDependencies: client identity IS the trigger
  useEffect(() => {
    sessionsRef.current = new Map();
    setSessions(sessionsRef.current);
    ensuring.current.clear();
    slots.current.invalidateAll();
  }, [client]);

  useEffect(() => {
    localStorage.setItem(TABS_KEY, serializeTabs(tabs));
  }, [tabs]);

  // First-run config dialog, once per app life.
  useEffect(() => {
    if (kernel.phase === "ready" && kernel.config?.needsApiKey && !configDone) {
      setConfigState(kernel.config);
    }
  }, [kernel.phase, kernel.config, configDone]);

  // Always have at least one tab (home directory until a folder is picked).
  useEffect(() => {
    if (kernel.phase !== "ready" || tabs.tabs.length > 0) return;
    fetchDefaultCwd().then(
      (cwd) => dispatch({ type: "open", tabId: crypto.randomUUID(), cwd }),
      (cause: unknown) => setNotice(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [kernel.phase, tabs.tabs.length]);

  // Materialize the active tab's session lazily: resume its persisted id, or
  // fall back to (then record) a fresh one. Background tabs load on activation.
  useEffect(() => {
    if (!configReady || !client || !activeTab) return;
    if (sessions.has(activeTab.id) || ensuring.current.has(activeTab.id)) return;
    ensuring.current.add(activeTab.id);
    const tab = activeTab;
    const token = slots.current.begin(tab.id);
    ensureTabSession(
      {
        load: (sessionId, cwd) => resumeSession(client, sessionId, cwd),
        create: (cwd) => createSession(client, cwd),
      },
      tab,
      isStaleSessionError,
    ).then(
      ({ session }) => {
        ensuring.current.delete(tab.id);
        // Superseded (tab closed, user switched, client replaced): the tab
        // moved on — detach the orphan instead of installing it invisibly.
        if (!slots.current.isCurrent(tab.id, token)) {
          client.closeSession(session.id);
          return;
        }
        commitSession(tab.id, session, client);
        if (session.id !== tab.sessionId) {
          dispatch({ type: "attach-session", tabId: tab.id, sessionId: session.id });
        }
      },
      (cause: unknown) => {
        ensuring.current.delete(tab.id);
        if (!slots.current.isCurrent(tab.id, token)) return; // nobody's waiting
        // A rejection caused by the kernel dying mid-load beats the [client]
        // effect that would invalidate this token (microtask vs render). The
        // crash banner + auto-restart own that story — a "couldn't open"
        // notice here would be both wrong and permanent.
        if (manager.snapshot.client !== client) return;
        const folder = tab.cwd.split("/").filter(Boolean).at(-1) ?? tab.cwd;
        const message = cause instanceof Error ? cause.message : String(cause);
        setNotice(
          `Couldn't open the session in ${folder}: ${message} — switch away and back to retry.`,
        );
      },
    );
  }, [configReady, client, activeTab, sessions, commitSession, manager]);

  const reportError = (cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (activeSession) activeSession.store.addError(message);
    else setNotice(message);
  };

  /** Same-target dedup for switches: a double-click on a session row must
   * not fire a second loadSession while the first replays — the client
   * rejects duplicate registrations ("already open in this client"). */
  const switching = useRef(new Map<string, string>());

  /** Replace the active tab's session (browser pick / new session). Rapid
   * switches resolve in USER order, not completion order: each begins a
   * token, and a superseded result is closed instead of committed. The
   * `next` work is deferred behind the dedup check so a deduped click never
   * even starts a load. */
  const switchWithinTab = (tab: Tab, target: string, next: () => Promise<Session>) => {
    if (switching.current.get(tab.id) === target) return;
    switching.current.set(tab.id, target);
    const settle = () => {
      if (switching.current.get(tab.id) === target) switching.current.delete(tab.id);
    };
    const activeClient = client;
    const token = slots.current.begin(tab.id);
    next()
      .finally(settle)
      .then(
        (session) => {
          setBrowserOpen(false);
          if (!slots.current.isCurrent(tab.id, token)) {
            activeClient?.closeSession(session.id);
            return;
          }
          if (activeClient) commitSession(tab.id, session, activeClient);
          dispatch({ type: "attach-session", tabId: tab.id, sessionId: session.id });
        },
        (cause: unknown) => {
          setBrowserOpen(false);
          if (slots.current.isCurrent(tab.id, token)) reportError(cause);
        },
      );
  };

  const addTab = () => {
    pickFolder().then((path) => {
      if (path) dispatch({ type: "open", tabId: crypto.randomUUID(), cwd: path });
    }, reportError);
  };

  const closeTab = (tabId: string) => {
    // Outstanding installs for this tab are stale from here on.
    slots.current.invalidate(tabId);
    const session = sessionsRef.current.get(tabId);
    if (session && client) {
      if (session.store.snapshot.busy) client.cancel(session.id);
      client.closeSession(session.id);
    }
    removeSession(tabId);
    dispatch({ type: "close", tabId });
  };

  const applyConfig = async (params: ConfigSetModelParams) => {
    if (!client) throw new Error("kernel is not connected");
    await client.setModel(params);
    setConfigDone(true);
    setConfigState(null);
  };

  const stores = useMemo(() => {
    const map = new Map<string, SessionStore>();
    for (const [tabId, session] of sessions) map.set(tabId, session.store);
    return map;
  }, [sessions]);

  return (
    <div className="flex h-screen flex-col">
      {kernel.phase !== "ready" ? (
        <KernelBanner
          phase={kernel.phase}
          exitCode={kernel.exitCode}
          error={kernel.error}
          onRetry={() => manager.start()}
        />
      ) : null}
      {notice ? (
        <div className="flex items-center justify-between bg-destructive/10 px-4 py-1 text-xs text-destructive">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="px-1">
            ×
          </button>
        </div>
      ) : null}
      <ProjectTabs
        tabs={tabs.tabs}
        activeTabId={tabs.activeTabId}
        stores={stores}
        onActivate={(tabId) => dispatch({ type: "activate", tabId })}
        onCloseTab={closeTab}
        onAddTab={addTab}
      />
      {activeSession && activeTab && client ? (
        <Chat
          // Keyed by SESSION: a within-tab switch must also remount (fresh
          // initial-scroll, fresh per-session UI state). Drafts stay per-TAB
          // via the drafts map, so they survive the remount.
          key={activeSession.id}
          client={client}
          session={activeSession}
          initialDraft={drafts.current.get(activeTab.id) ?? ""}
          onDraftChange={(text) => drafts.current.set(activeTab.id, text)}
          onOpenConfig={() => client.getConfigState().then(setConfigState, reportError)}
          onOpenFolder={addTab}
          onOpenSessions={() => setBrowserOpen(true)}
          onNewSession={() => {
            if (activeTab) {
              // Unique target per click: two "New"s are two sessions (the
              // second supersedes via its token), never a dedup.
              switchWithinTab(activeTab, `new:${crypto.randomUUID()}`, () =>
                createSession(client, activeTab.cwd, activeSession.profile ?? undefined),
              );
            }
          }}
          onSetProfile={(profile) => {
            const tabId = activeTab.id;
            const sessionId = activeSession.id;
            client.setProfile(sessionId, profile).then(
              () => {
                // Only lands while this exact session is still installed; a
                // superseded response must not resurrect a detached store.
                if (updateSession(tabId, sessionId, { profile })) {
                  sessionsRef.current.get(tabId)?.store.addInfo(`profile → ${profile ?? "(none)"}`);
                }
              },
              (cause: unknown) => {
                if (sessionsRef.current.get(tabId)?.id === sessionId) reportError(cause);
              },
            );
          }}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">
            {kernel.phase !== "ready"
              ? "Waiting for the kernel…"
              : configState && !configDone
                ? "Configure a model to get started."
                : "Opening session…"}
          </p>
        </div>
      )}
      {browserOpen && activeTab && activeSession && client ? (
        <SessionBrowser
          client={client}
          cwd={activeTab.cwd}
          currentId={activeSession.id}
          onPick={(summary: SessionSummary) => {
            // If it's already open in another tab, go there instead.
            const existing = tabs.tabs.find((tab) => tab.sessionId === summary.sessionId);
            if (existing && existing.id !== activeTab.id) {
              dispatch({ type: "activate", tabId: existing.id });
              setBrowserOpen(false);
              return;
            }
            switchWithinTab(activeTab, `resume:${summary.sessionId}`, () =>
              resumeSession(client, summary.sessionId, summary.cwd),
            );
          }}
          onClose={() => setBrowserOpen(false)}
        />
      ) : null}
      {configState && client ? (
        <ConfigDialog
          state={configState}
          onSubmit={applyConfig}
          onClose={
            configDone || !kernel.config?.needsApiKey ? () => setConfigState(null) : undefined
          }
        />
      ) : null}
      <PermissionDialog queue={manager.permissions} />
    </div>
  );
}

function KernelBanner({
  phase,
  exitCode,
  error,
  onRetry,
}: {
  phase: "starting" | "restarting" | "down";
  exitCode: number | null;
  error: string | null;
  onRetry: () => void;
}) {
  const text =
    phase === "starting"
      ? "Starting kernel…"
      : phase === "restarting"
        ? `Kernel exited${exitCode !== null ? ` (code ${exitCode})` : ""} — restarting…`
        : `Kernel is down${exitCode !== null ? ` (exit code ${exitCode})` : ""}${error ? `: ${error}` : ""}`;
  return (
    <div
      className={`flex items-center justify-between px-4 py-1.5 text-xs ${
        phase === "down"
          ? "bg-destructive/15 text-destructive"
          : "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400"
      }`}
    >
      <span>{text}</span>
      {phase === "down" ? (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border px-2 py-0.5 hover:bg-secondary"
        >
          Restart kernel
        </button>
      ) : null}
    </div>
  );
}

function Chat({
  client,
  session,
  initialDraft,
  onDraftChange,
  onOpenConfig,
  onOpenFolder,
  onOpenSessions,
  onNewSession,
  onSetProfile,
}: {
  client: MinervaClient;
  session: Session;
  initialDraft: string;
  onDraftChange: (text: string) => void;
  onOpenConfig: () => void;
  onOpenFolder: () => void;
  onOpenSessions: () => void;
  onNewSession: () => void;
  onSetProfile: (profile: string | null) => void;
}) {
  const vm = useSessionStore(session.store);
  const [draft, setDraftState] = useState(initialDraft);
  const setDraft = (text: string) => {
    setDraftState(text);
    onDraftChange(text);
  };
  const [notifyMuted, setNotifyMuted] = useState(
    () => localStorage.getItem(NOTIFY_MUTED_KEY) === "1",
  );
  const scrollRef = useRef<HTMLElement>(null);
  const didInitialScroll = useRef(false);

  // Stick-to-bottom: follow streaming output unless the reader scrolled up.
  // Items identity changes on every applied update, so it is the right trigger.
  // The first paint with content (resume replay, tab switch) always jumps to
  // the latest message — a fresh scroll container starts at the top.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || vm.items.length === 0) return;
    if (!didInitialScroll.current) {
      didInitialScroll.current = true;
      el.scrollTop = el.scrollHeight;
      return;
    }
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
    const startedAt = performance.now();
    client.prompt(session.id, text).then((stopReason) => {
      const decision = decideNotification({
        stopReason,
        focused: document.hasFocus(),
        durationMs: performance.now() - startedAt,
        muted: notifyMuted,
        project: session.cwd.split("/").filter(Boolean).at(-1) ?? session.cwd,
      });
      if (decision) void notify(decision.title, decision.body);
    }, reportError);
  };

  // Skill autocomplete: assistive only — any text, /-prefixed or not, goes to
  // the kernel verbatim (it expands known /skills into their instructions).
  const skillMatches =
    draft.startsWith("/") && !draft.includes(" ")
      ? session.skills.filter((skill) => skill.name.startsWith(draft.slice(1)))
      : [];

  return (
    <>
      <HeaderBar
        cwd={session.cwd}
        modes={session.modes}
        currentModeId={vm.currentModeId}
        profiles={session.profiles}
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
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  const next = !notifyMuted;
                  localStorage.setItem(NOTIFY_MUTED_KEY, next ? "1" : "0");
                  setNotifyMuted(next);
                }}
                title={
                  notifyMuted
                    ? "Notifications muted — click to enable"
                    : "Notify when a long turn finishes in the background"
                }
                className="rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-secondary"
              >
                {notifyMuted ? "🔕" : "🔔"}
              </button>
              <button
                type="button"
                onClick={onOpenConfig}
                title="Model & provider settings"
                className="rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-secondary"
              >
                ⚙ model
              </button>
            </div>
          </div>
        </div>
      </footer>
    </>
  );
}
