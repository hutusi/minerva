import type { MinervaClient, SessionStore, SessionViewModel, ViewItem } from "@minerva/client";
import type {
  InstructionsInfo,
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionParams,
  SessionSummary,
  SkillInfo,
} from "@minerva/protocol";
import { Box, Text, useApp, useInput, useStderr, useStdout } from "ink";
import TextInput from "ink-text-input";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ConfigPanel, type ConfigResult, type ProviderChoice } from "./config-panel";
import { clipDiff, type DiffLine, diffLines } from "./diff";
import { establishSession } from "./establish";
import { InputHistory } from "./history";
import { Markdown } from "./markdown";
import type { PendingPermission, PermissionBridge } from "./permission-bridge";
import { SessionPicker } from "./session-picker";
import { resolveSlashInput, skillsHelp } from "./slash";
import { slashSuggestions } from "./suggest";

interface AppProps {
  client: MinervaClient;
  bridge: PermissionBridge;
  model: string;
  cwd: string;
  /** null = new session; "latest" = most recent for cwd; else a session id. */
  resume: string | null;
  /** Profile requested via --profile; null lets the kernel apply the settings
   * default. The header reflects whatever the kernel reports back. */
  profile?: string | null | undefined;
  /** Rows for the /config panel's provider selector. */
  providers: ProviderChoice[];
  /** No usable API key at startup — open the config panel instead of exiting. */
  needsConfig: boolean;
  /** Prior inputs (oldest first) seeding up-arrow recall. */
  initialHistory?: string[] | undefined;
  /** Fire-and-forget persistence hook for each submitted input. */
  onHistoryAppend?: ((text: string) => void) | undefined;
}

export function App({
  client,
  bridge,
  model,
  cwd,
  resume,
  profile,
  providers,
  needsConfig,
  initialHistory,
  onHistoryAppend,
}: AppProps) {
  const [session, setSession] = useState<{ id: string; store: SessionStore } | null>(null);
  const [pending, setPending] = useState<PendingPermission | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Header model ref; updated live when /config swaps the provider.
  const [modelRef, setModelRef] = useState(model);
  // Active profile as the kernel reports it (create/load result, /profile).
  const [activeProfile, setActiveProfile] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  // A skills outage must not break the TUI — degrade to "no skills".
  const refreshSkills = useCallback(() => {
    client
      .listSkills(cwd)
      .then(setSkills)
      .catch(() => setSkills([]));
  }, [client, cwd]);

  useEffect(() => {
    bridge.handler = (request) =>
      new Promise((resolve) => {
        setPending({
          request,
          resolve: (result) => {
            setPending(null);
            resolve(result);
          },
        });
      });
    const establish = async () => {
      await client.initialize();
      return establishSession(client, cwd, { resume, profile });
    };
    establish()
      .then(({ sessionId, store, instructions, profile: established }) => {
        announceInstructions(store, instructions);
        setSession({ id: sessionId, store });
        setActiveProfile(established ?? null);
        refreshSkills();
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    return () => {
      bridge.handler = null;
    };
  }, [client, bridge, cwd, resume, profile, refreshSkills]);

  if (error) {
    return <Text color="red">Failed to start session: {error}</Text>;
  }
  if (!session) {
    return <Text dimColor>Starting Minerva…</Text>;
  }
  const startNewSession = () => {
    client
      .newSession(cwd, activeProfile ? { profile: activeProfile } : {})
      .then(({ sessionId, store, instructions, profile: established }) => {
        announceInstructions(store, instructions);
        setSession({ id: sessionId, store });
        setActiveProfile(established ?? null);
        // The project may have gained/lost skills since the last session.
        refreshSkills();
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  };
  const loadExistingSession = (sessionId: string) => {
    if (sessionId === session.id) return;
    // Clear any registration left from an earlier switch away — loadSession
    // refuses to overwrite a live store, and switching never unregisters.
    client.closeSession(sessionId);
    client
      .loadSession(sessionId, cwd)
      .then(({ store, instructions, profile: established }) => {
        announceInstructions(store, instructions);
        setSession({ id: sessionId, store });
        setActiveProfile(established ?? null);
        refreshSkills();
      })
      // A failed switch keeps the current session usable — never setError,
      // which unmounts the whole app.
      .catch((cause) =>
        session.store.addError(
          `could not load session: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      );
  };
  return (
    <Box flexDirection="column">
      <Text dimColor>
        Minerva · {modelRef}
        {activeProfile ? ` · profile ${activeProfile}` : ""} · {cwd} · /help for commands, esc to
        cancel
      </Text>
      <Chat
        client={client}
        session={session}
        pending={pending}
        cwd={cwd}
        skills={skills}
        onNewSession={startNewSession}
        onLoadSession={loadExistingSession}
        providers={providers}
        model={modelRef}
        onModelChanged={setModelRef}
        activeProfile={activeProfile}
        onProfileChanged={setActiveProfile}
        initialConfigOpen={needsConfig}
        initialHistory={initialHistory ?? []}
        onHistoryAppend={onHistoryAppend}
      />
    </Box>
  );
}

function announceInstructions(store: SessionStore, instructions?: InstructionsInfo) {
  if (!instructions || instructions.files.length === 0) return;
  store.addInfo(
    `project instructions loaded: ${instructions.files.map((file) => file.path).join(", ")}`,
  );
}

const HELP_TEXT = [
  "/help              show this help",
  "/config            choose provider, API key, and model",
  "/mode [id]         show or set the session mode (plan | default | acceptEdits | auto)",
  "/compact           summarize the conversation and reset the model context",
  "/profile [name]    list profiles, or switch persona (none clears)",
  "/sessions          pick a recent session for this directory",
  "/resume            same as /sessions",
  "/new               start a fresh session",
  "/exit              quit",
].join("\n");

function Chat({
  client,
  session,
  pending,
  cwd,
  skills,
  onNewSession,
  onLoadSession,
  providers,
  model,
  onModelChanged,
  activeProfile,
  onProfileChanged,
  initialConfigOpen,
  initialHistory,
  onHistoryAppend,
}: {
  client: MinervaClient;
  session: { id: string; store: SessionStore };
  pending: PendingPermission | null;
  cwd: string;
  skills: SkillInfo[];
  onNewSession: () => void;
  onLoadSession: (sessionId: string) => void;
  providers: ProviderChoice[];
  model: string;
  onModelChanged: (providerId: string) => void;
  activeProfile: string | null;
  onProfileChanged: (profile: string | null) => void;
  initialConfigOpen: boolean;
  initialHistory: string[];
  onHistoryAppend: ((text: string) => void) | undefined;
}) {
  const subscribe = useCallback(
    (listener: () => void) => session.store.subscribe(listener),
    [session.store],
  );
  const viewModel = useSyncExternalStore(subscribe, () => session.store.snapshot);
  const [draft, setDraft] = useState("");
  // One history for the whole run — it survives session switches on purpose.
  const [history] = useState(() => new InputHistory(initialHistory));
  const [configOpen, setConfigOpen] = useState(initialConfigOpen);
  /** Rows for the session picker; null = closed. */
  const [pickerSessions, setPickerSessions] = useState<SessionSummary[] | null>(null);
  // The provider snapshot and first-run flag start from the startup values but
  // must reflect a successful /config, or the panel keeps showing a
  // just-configured provider as "no key" and re-renders the first-run banner.
  const [providerChoices, setProviderChoices] = useState(providers);
  const [firstRun, setFirstRun] = useState(initialConfigOpen);
  const { exit } = useApp();

  useInput((_input, key) => {
    // While a permission prompt is open, ITS escape handler owns turn
    // cancellation (ACP cancelled outcome) — Ink dispatches keys to every
    // hook, so without the gate one Escape would fire both cancel paths.
    if (key.escape && viewModel.busy && !pending) client.cancel(session.id);
  });

  const info = (text: string) => session.store.addInfo(text);
  const reportError = (cause: unknown) =>
    session.store.addError(cause instanceof Error ? cause.message : String(cause));

  const runCommand = (input: string) => {
    const resolved = resolveSlashInput(input, skills);
    if (resolved.kind === "skill") {
      // The raw /name line goes to the kernel, which expands it into the
      // skill's instructions for the model; the transcript keeps the literal.
      client.prompt(session.id, input).catch(reportError);
      return;
    }
    if (resolved.kind === "unknown") {
      info(`unknown command: /${resolved.command} — try /help`);
      return;
    }
    const { command, argument } = resolved;
    switch (command) {
      case "exit":
      case "quit":
        exit();
        break;
      case "help":
        info(HELP_TEXT + skillsHelp(skills));
        break;
      case "config":
        setConfigOpen(true);
        break;
      case "mode":
        if (!argument) {
          info(
            `mode: ${viewModel.currentModeId ?? "default"} — /mode plan | default | acceptEdits | auto`,
          );
          break;
        }
        client.setMode(session.id, argument).catch(reportError);
        break;
      case "compact":
        client
          .compact(session.id)
          .then((summary) => info(`context compacted — summary:\n${firstLines(summary, 8)}`))
          .catch(reportError);
        break;
      case "sessions":
      case "resume":
        if (viewModel.busy) {
          session.store.addError("finish or cancel the current turn first");
          break;
        }
        client
          .listSessions(cwd)
          .then((sessions) => {
            if (sessions.length === 0) {
              info("no sessions for this directory yet");
              return;
            }
            setPickerSessions(sessions);
          })
          .catch(reportError);
        break;
      case "new":
        onNewSession();
        break;
      case "profile":
        if (!argument) {
          client
            .listProfiles(cwd)
            .then(({ profiles, default: fallback }) => {
              if (profiles.length === 0) {
                info(
                  'no profiles defined — add {"profiles": {"<name>": {"systemPrompt": "…"}}} to settings.json',
                );
                return;
              }
              const width = Math.max(...profiles.map((entry) => entry.name.length)) + 2;
              info(
                [
                  "profiles (/profile <name> to switch, /profile none to clear):",
                  ...profiles.map((entry) => {
                    const traits = [
                      entry.hasSystemPrompt ? "system prompt" : "",
                      entry.model ? `model ${entry.model}` : "",
                      entry.defaultMode ? `mode ${entry.defaultMode}` : "",
                    ]
                      .filter(Boolean)
                      .join(" · ");
                    const active = entry.name === activeProfile ? " (active)" : "";
                    const isDefault = entry.name === fallback ? " (default)" : "";
                    return `  ${entry.name.padEnd(width)}${traits}${active}${isDefault}`;
                  }),
                ].join("\n"),
              );
            })
            .catch(reportError);
          break;
        }
        if (argument === "none") {
          client
            .setProfile(session.id, null)
            .then(() => {
              onProfileChanged(null);
              info("profile cleared — the base prompt applies from the next message");
            })
            .catch(reportError);
          break;
        }
        client
          .setProfile(session.id, argument)
          .then(async () => {
            onProfileChanged(argument);
            info(`profile ${argument} active from the next message`);
            // The profile may prefer a different model; switching models
            // persists global settings, so it stays the user's call.
            const { profiles } = await client.listProfiles(cwd);
            const chosen = profiles.find((entry) => entry.name === argument);
            if (chosen?.model && chosen.model !== model) {
              info(
                `note: this profile prefers ${chosen.model} (current: ${model}) — /config to switch`,
              );
            }
          })
          .catch(reportError);
        break;
      default:
        // Unreachable: resolveSlashInput only returns builtin for the cases
        // above; keep a fallback so a drifted command list still responds.
        info(`unknown command: /${command} — try /help`);
    }
  };

  const submit = (value: string) => {
    const text = value.trim();
    if (!text) return;
    setDraft("");
    history.push(text);
    onHistoryAppend?.(text);
    if (text.startsWith("/")) {
      runCommand(text);
      return;
    }
    client.prompt(session.id, text).catch(reportError);
  };

  const applyConfig = async (result: ConfigResult) => {
    const providerId = await client.setModel({
      modelRef: result.modelRef,
      ...(result.provider ? { provider: result.provider } : {}),
      ...(result.apiKey ? { apiKey: result.apiKey } : {}),
    });
    onModelChanged(providerId);
    setConfigOpen(false);
    // Reflect the just-saved config: setup is done, and the provider now has a
    // stored key, so reopening /config won't mislabel it "no key" — and a
    // newly defined custom provider becomes selectable without a restart.
    setFirstRun(false);
    const configured = result.provider?.name ?? providerId.split("/")[0] ?? providerId;
    setProviderChoices((choices) => {
      if (choices.some((choice) => choice.name === configured)) {
        return result.apiKey
          ? choices.map((choice) =>
              choice.name === configured ? { ...choice, keySource: "settings" } : choice,
            )
          : choices;
      }
      if (!result.provider) return choices; // built-in ref we don't know — leave it
      const slash = result.modelRef.indexOf("/");
      const defaultModel = slash === -1 ? undefined : result.modelRef.slice(slash + 1);
      return [
        ...choices,
        {
          name: configured,
          keyVar: `${configured.toUpperCase().replaceAll("-", "_")}_API_KEY`,
          keySource: result.apiKey ? "settings" : "none",
          ...(result.provider.baseUrl ? { baseUrl: result.provider.baseUrl } : {}),
          ...(result.provider.requiresApiKey !== undefined
            ? { requiresApiKey: result.provider.requiresApiKey }
            : {}),
          ...(defaultModel ? { defaultModel } : {}),
        },
      ];
    });
    info(`model set to ${providerId} (saved to global settings)`);
  };

  const cancelConfig = () => {
    setConfigOpen(false);
    if (firstRun) {
      info("no API key configured — prompts will fail until you run /config");
    }
  };

  return (
    <Box flexDirection="column">
      {viewModel.items.map((item, index) => (
        <ItemView key={itemKey(item, index)} item={item} />
      ))}
      {pending ? (
        <PermissionPrompt pending={pending} />
      ) : pickerSessions ? (
        <SessionPicker
          sessions={pickerSessions}
          currentId={session.id}
          onSelect={(sessionId) => {
            setPickerSessions(null);
            onLoadSession(sessionId);
          }}
          onCancel={() => setPickerSessions(null)}
        />
      ) : configOpen ? (
        <ConfigPanel
          providers={providerChoices}
          currentModel={model}
          firstRun={firstRun}
          onSubmit={applyConfig}
          onCancel={cancelConfig}
        />
      ) : viewModel.busy ? (
        <BusyIndicator />
      ) : (
        <Composer
          draft={draft}
          setDraft={setDraft}
          onSubmit={submit}
          skills={skills}
          history={history}
          modeId={viewModel.currentModeId}
        />
      )}
      <StatusFooter
        modeId={viewModel.currentModeId}
        usage={viewModel.usage}
        context={viewModel.context}
      />
    </Box>
  );
}

/**
 * The input line plus history recall and slash autocomplete. Mounted only
 * while the composer slot is visible, so its useInput never competes with
 * the permission prompt or config panel.
 */
function Composer({
  draft,
  setDraft,
  onSubmit,
  skills,
  history,
  modeId,
}: {
  draft: string;
  setDraft: (value: string) => void;
  onSubmit: (value: string) => void;
  skills: SkillInfo[];
  history: InputHistory;
  modeId: string | undefined;
}) {
  const suggestions = slashSuggestions(draft, skills);
  const [suggestIndex, setSuggestIndex] = useState(0);
  // Ref mirror of suggestIndex (config-panel pattern): a ↓+enter arriving in
  // one input batch must complete the row the user saw highlighted.
  const suggestIndexRef = useRef(0);

  const changeDraft = (value: string) => {
    suggestIndexRef.current = 0;
    setSuggestIndex(0);
    setDraft(value);
  };

  useInput((_input, key) => {
    if (suggestions.length > 0) {
      if (key.upArrow || key.downArrow) {
        const delta = key.upArrow ? -1 : 1;
        suggestIndexRef.current =
          (suggestIndexRef.current + suggestions.length + delta) % suggestions.length;
        setSuggestIndex(suggestIndexRef.current);
      } else if (key.tab) {
        const chosen = suggestions[suggestIndexRef.current];
        if (chosen) changeDraft(`/${chosen.name} `);
      }
      return;
    }
    if (key.upArrow) {
      const entry = history.prev(draft);
      if (entry !== null) setDraft(entry);
    } else if (key.downArrow) {
      const entry = history.next();
      if (entry !== null) setDraft(entry);
    }
  });

  const handleSubmit = (value: string) => {
    // Enter while the dropdown is open completes instead of submitting.
    // Handled HERE, not in a second useInput: TextInput fires onSubmit AND
    // lets `return` reach parent hooks, so a key handler would double-fire.
    // Recomputed from `value` so a same-batch edit can't leave a stale list.
    const open = slashSuggestions(value, skills);
    if (open.length > 0) {
      const chosen = open[Math.min(suggestIndexRef.current, open.length - 1)];
      if (chosen && value.trim() !== `/${chosen.name}`) {
        changeDraft(`/${chosen.name} `);
        return;
      }
    }
    onSubmit(value);
  };

  return (
    <Box flexDirection="column">
      <Box>
        {modeId && modeId !== "default" ? <Text color="magenta">[{modeId}] </Text> : null}
        <Text color="cyan">{"> "}</Text>
        <TextInput value={draft} onChange={changeDraft} onSubmit={handleSubmit} />
      </Box>
      {suggestions.map((suggestion, i) => (
        <Text key={suggestion.name} {...(i === suggestIndex ? { color: "cyan" } : {})}>
          {i === suggestIndex ? "❯ " : "  "}/{suggestion.name.padEnd(10)}
          <Text dimColor> {suggestion.description}</Text>
        </Text>
      ))}
      {suggestions.length > 0 ? <Text dimColor>↑/↓ select · tab or enter complete</Text> : null}
    </Box>
  );
}

/** Braille spinner + elapsed seconds while a prompt runs. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function BusyIndicator() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((current) => current + 1), 100);
    return () => clearInterval(timer);
  }, []);
  return (
    <Text color="yellow">
      {SPINNER_FRAMES[tick % SPINNER_FRAMES.length]} working… {Math.floor(tick / 10)}s (esc to
      cancel)
    </Text>
  );
}

/** Session status line: mode (when not default), token usage, and context. */
function StatusFooter({
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
  if (context && context.size > 0) {
    parts.push(`ctx ${Math.round((100 * context.used) / context.size)}%`);
  }
  if (parts.length === 0) return null;
  return <Text dimColor>{parts.join(" · ")}</Text>;
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${trimDecimal(count / 1_000_000)}M`;
  if (count >= 1_000) return `${trimDecimal(count / 1_000)}k`;
  return String(count);
}

function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

function itemKey(item: ViewItem, index: number): string {
  if (item.kind === "tool") return `tool-${item.toolCallId}`;
  if (item.kind === "plan") return "plan";
  return `${item.kind}-${index}`;
}

function ItemView({ item }: { item: ViewItem }) {
  switch (item.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text color="cyan">{"> "}</Text>
          <Text>{item.text}</Text>
        </Box>
      );
    case "assistant":
      // Markdown is for model output only: info/user/tool text stays plain,
      // so /help output and command echoes are never reinterpreted.
      return (
        <Box marginTop={1}>
          <Markdown text={item.text} />
        </Box>
      );
    case "thought":
      return <ThoughtView item={item} />;
    case "tool":
      return <ToolView item={item} />;
    case "plan":
      return <PlanView entries={item.entries} />;
    case "info":
      return (
        <Box marginTop={1}>
          <Text dimColor>{item.text}</Text>
        </Box>
      );
    case "error":
      return (
        <Box marginTop={1}>
          <Text color="red">✖ {item.text}</Text>
        </Box>
      );
  }
}

const STATUS_COLOR = {
  pending: "yellow",
  in_progress: "yellow",
  completed: "green",
  failed: "red",
} as const;

/** Cap on rendered diff lines — transcripts and prompts share it. */
const DIFF_LINE_CAP = 20;

function ToolView({ item }: { item: Extract<ViewItem, { kind: "tool" }> }) {
  const preview = item.output ? firstLines(item.output, 4) : null;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={STATUS_COLOR[item.status]}>⏺ </Text>
        <Text bold>{item.title}</Text>
        <Text dimColor> [{item.status}]</Text>
      </Text>
      {item.task ? (
        <Box marginLeft={2}>
          <Text dimColor>
            ↳ {item.task.toolCalls} tool call{item.task.toolCalls === 1 ? "" : "s"}
            {item.task.failed > 0 ? ` (${item.task.failed} failed)` : ""}
            {item.task.lastActivity ? ` · ${item.task.lastActivity}` : ""}
          </Text>
        </Box>
      ) : null}
      {item.diff ? (
        <DiffView
          lines={clipDiff(diffLines(item.diff.oldText, item.diff.newText), DIFF_LINE_CAP)}
        />
      ) : preview ? (
        <Box marginLeft={2}>
          <Text dimColor>{preview}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function DiffView({ lines }: { lines: DiffLine[] }) {
  let offset = 0;
  return (
    <Box flexDirection="column" marginLeft={2}>
      {lines.map((line) => {
        const key = `${offset}:${line.kind}`;
        offset += line.text.length + 1;
        switch (line.kind) {
          case "add":
            return (
              <Text key={key} color="green">
                + {line.text}
              </Text>
            );
          case "del":
            return (
              <Text key={key} color="red">
                - {line.text}
              </Text>
            );
          case "gap":
          case "note":
            return (
              <Text key={key} dimColor>
                {line.text}
              </Text>
            );
          default:
            return (
              <Text key={key} dimColor>
                {"  "}
                {line.text}
              </Text>
            );
        }
      })}
    </Box>
  );
}

/**
 * Model reasoning: a rolling tail while it streams (full thoughts run to
 * thousands of chars and would flood the live region), one dim summary
 * line once the answer starts.
 */
function ThoughtView({ item }: { item: Extract<ViewItem, { kind: "thought" }> }) {
  const { stdout } = useStdout();
  if (!item.streaming) {
    return (
      <Box marginTop={1}>
        <Text dimColor>✻ thought · {formatTokens(item.text.length)} chars</Text>
      </Box>
    );
  }
  return (
    <Box marginTop={1}>
      <Text dimColor>✻ {thoughtTail(item.text, stdout?.columns ?? 80)}</Text>
    </Box>
  );
}

/** Keep the first or last `count` lines, marking the truncation. */
export function clipLines(text: string, count: number, keep: "first" | "last"): string {
  const lines = text.trimEnd().split("\n");
  if (lines.length <= count) return lines.join("\n");
  return keep === "first"
    ? `${lines.slice(0, count).join("\n")}\n… (${lines.length - count} more lines)`
    : `… ${lines.slice(-count).join("\n")}`;
}

const firstLines = (text: string, count: number) => clipLines(text, count, "first");

/**
 * Rolling tail for a streaming thought: the last few lines, but also capped by
 * a character budget from the terminal width — a long reasoning paragraph with
 * no newlines (routine for Qwen/Chinese reasoning) is under the line cap yet
 * would still flood the live region.
 */
export function thoughtTail(text: string, columns: number): string {
  const clipped = clipLines(text, 4, "last");
  const budget = 4 * Math.max(20, columns - 4);
  if (clipped.length <= budget) return clipped;
  // Strip any leading ellipsis clipLines added so we don't double it.
  const body = clipped.startsWith("… ") ? clipped.slice(2) : clipped;
  return `… ${body.slice(-budget)}`;
}

function PlanView({ entries }: { entries: Extract<ViewItem, { kind: "plan" }>["entries"] }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Todos</Text>
      {withUniqueKeys(entries).map(({ entry, key }) => (
        <Text
          key={key}
          {...(entry.status === "in_progress" ? { color: "yellow" } : {})}
          dimColor={entry.status === "completed"}
        >
          {entry.status === "completed" ? "☑" : entry.status === "in_progress" ? "◐" : "☐"}{" "}
          {entry.content}
        </Text>
      ))}
    </Box>
  );
}

/** Stable-ish keys from content, disambiguating duplicate entries. */
function withUniqueKeys<T extends { content: string }>(
  entries: T[],
): Array<{ entry: T; key: string }> {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const count = seen.get(entry.content) ?? 0;
    seen.set(entry.content, count + 1);
    return { entry, key: count === 0 ? entry.content : `${entry.content}#${count}` };
  });
}

/** Hotkeys keyed by option KIND, so the kernel can rename/reorder options. */
const PERMISSION_HOTKEYS: Record<string, PermissionOptionKind> = {
  y: "allow_once",
  a: "allow_always",
  n: "reject_once",
};

function permissionHotkey(kind: PermissionOptionKind): string | undefined {
  return Object.entries(PERMISSION_HOTKEYS).find(([, k]) => k === kind)?.[0];
}

function PermissionPrompt({ pending }: { pending: PendingPermission }) {
  const options = pending.request.options;
  const { stderr } = useStderr();
  const toolCallId = pending.request.toolCall.toolCallId;
  // Terminal bell once per request: the user may have tabbed away while the
  // model worked, and an unanswered prompt stalls the whole turn. Rung on
  // stderr — same terminal, but it can never interleave with Ink's frame
  // painting on stdout.
  useEffect(() => {
    void toolCallId; // read in the effect so the dependency is genuine
    stderr?.write("\u0007");
  }, [stderr, toolCallId]);
  const [index, setIndex] = useState(0);
  // Ref mirror of `index`, current within a single input batch (the
  // config-panel pattern): rapid ↓+enter must select the row the user saw.
  const indexRef = useRef(0);
  const select = (option: PermissionOption | undefined) => {
    if (option) pending.resolve({ outcome: { outcome: "selected", optionId: option.optionId } });
  };
  useInput((input, key) => {
    if (key.upArrow || key.downArrow) {
      const delta = key.upArrow ? -1 : 1;
      indexRef.current = (indexRef.current + options.length + delta) % options.length;
      setIndex(indexRef.current);
    } else if (key.return) {
      select(options[indexRef.current]);
    } else if (key.escape) {
      // ACP cancelled outcome: abandon the whole turn, not just this call.
      pending.resolve({ outcome: { outcome: "cancelled" } });
    } else {
      const kind = PERMISSION_HOTKEYS[input.toLowerCase()];
      if (kind) select(options.find((option) => option.kind === kind));
    }
  });
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow" bold>
        Permission required{pending.request.taskToolCallId ? " (from subagent)" : ""}
      </Text>
      <Text>{pending.request.toolCall.title}</Text>
      <PermissionPreview toolCall={pending.request.toolCall} />
      {options.map((option, i) => {
        const hotkey = permissionHotkey(option.kind);
        return (
          <Text key={option.optionId} {...(i === index ? { color: "cyan" } : {})}>
            {i === index ? "❯ " : "  "}
            {option.name}
            {hotkey ? <Text dimColor> ({hotkey})</Text> : null}
          </Text>
        );
      })}
      <Text dimColor>↑/↓ select · enter confirm · esc cancel turn</Text>
    </Box>
  );
}

/**
 * What the call will actually do, from rawInput: the command for execute,
 * the line diff for edits, the full (all-added) content for new files, the
 * URL for fetches. Field-sniffed rather than tool-name-matched so MCP tools
 * with the same shapes get previews for free.
 */
function PermissionPreview({ toolCall }: { toolCall: RequestPermissionParams["toolCall"] }) {
  const raw = toolCall.rawInput;
  if (typeof raw !== "object" || raw === null) return null;
  const input = raw as Record<string, unknown>;
  if (typeof input.command === "string") {
    return (
      <Box marginLeft={2}>
        <Text dimColor>{firstLines(input.command, DIFF_LINE_CAP)}</Text>
      </Box>
    );
  }
  if (typeof input.old_string === "string" && typeof input.new_string === "string") {
    return (
      <DiffView lines={clipDiff(diffLines(input.old_string, input.new_string), DIFF_LINE_CAP)} />
    );
  }
  if (toolCall.kind === "edit" && typeof input.content === "string") {
    return <DiffView lines={clipDiff(diffLines(null, input.content), DIFF_LINE_CAP)} />;
  }
  if (typeof input.url === "string") {
    return (
      <Box marginLeft={2}>
        <Text dimColor>{input.url}</Text>
      </Box>
    );
  }
  return null;
}
