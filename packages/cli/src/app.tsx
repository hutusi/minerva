import type { MinervaClient, SessionStore, SessionViewModel, ViewItem } from "@minerva/client";
import type { InstructionsInfo, SkillInfo } from "@minerva/protocol";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { ConfigPanel, type ConfigResult, type ProviderChoice } from "./config-panel";
import type { PendingPermission, PermissionBridge } from "./permission-bridge";
import { resolveSlashInput, skillsHelp } from "./slash";

interface AppProps {
  client: MinervaClient;
  bridge: PermissionBridge;
  model: string;
  cwd: string;
  /** null = new session; "latest" = most recent for cwd; else a session id. */
  resume: string | null;
  /** Rows for the /config panel's provider selector. */
  providers: ProviderChoice[];
  /** No usable API key at startup — open the config panel instead of exiting. */
  needsConfig: boolean;
}

export function App({ client, bridge, model, cwd, resume, providers, needsConfig }: AppProps) {
  const [session, setSession] = useState<{ id: string; store: SessionStore } | null>(null);
  const [pending, setPending] = useState<PendingPermission | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Header model ref; updated live when /config swaps the provider.
  const [modelRef, setModelRef] = useState(model);
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
      if (resume === "latest") {
        const sessions = await client.listSessions(cwd);
        const latest = sessions[0];
        if (!latest) throw new Error(`no previous sessions for ${cwd}`);
        return client.loadSession(latest.sessionId, cwd);
      }
      if (resume) return client.loadSession(resume, cwd);
      return client.newSession(cwd);
    };
    establish()
      .then(({ sessionId, store, instructions }) => {
        announceInstructions(store, instructions);
        setSession({ id: sessionId, store });
        refreshSkills();
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    return () => {
      bridge.handler = null;
    };
  }, [client, bridge, cwd, resume, refreshSkills]);

  if (error) {
    return <Text color="red">Failed to start session: {error}</Text>;
  }
  if (!session) {
    return <Text dimColor>Starting Minerva…</Text>;
  }
  const startNewSession = () => {
    client
      .newSession(cwd)
      .then(({ sessionId, store, instructions }) => {
        announceInstructions(store, instructions);
        setSession({ id: sessionId, store });
        // The project may have gained/lost skills since the last session.
        refreshSkills();
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  };
  return (
    <Box flexDirection="column">
      <Text dimColor>
        Minerva · {modelRef} · {cwd} · /help for commands, esc to cancel
      </Text>
      <Chat
        client={client}
        session={session}
        pending={pending}
        cwd={cwd}
        skills={skills}
        onNewSession={startNewSession}
        providers={providers}
        model={modelRef}
        onModelChanged={setModelRef}
        initialConfigOpen={needsConfig}
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
  "/sessions          list recent sessions for this directory",
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
  providers,
  model,
  onModelChanged,
  initialConfigOpen,
}: {
  client: MinervaClient;
  session: { id: string; store: SessionStore };
  pending: PendingPermission | null;
  cwd: string;
  skills: SkillInfo[];
  onNewSession: () => void;
  providers: ProviderChoice[];
  model: string;
  onModelChanged: (providerId: string) => void;
  initialConfigOpen: boolean;
}) {
  const subscribe = useCallback(
    (listener: () => void) => session.store.subscribe(listener),
    [session.store],
  );
  const viewModel = useSyncExternalStore(subscribe, () => session.store.snapshot);
  const [draft, setDraft] = useState("");
  const [configOpen, setConfigOpen] = useState(initialConfigOpen);
  // The provider snapshot and first-run flag start from the startup values but
  // must reflect a successful /config, or the panel keeps showing a
  // just-configured provider as "no key" and re-renders the first-run banner.
  const [providerChoices, setProviderChoices] = useState(providers);
  const [firstRun, setFirstRun] = useState(initialConfigOpen);
  const { exit } = useApp();

  useInput((_input, key) => {
    if (key.escape && viewModel.busy) client.cancel(session.id);
  });

  const info = (text: string) => session.store.addInfo(text);
  const reportError = (cause: unknown) =>
    info(`error: ${cause instanceof Error ? cause.message : String(cause)}`);

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
        client
          .listSessions(cwd)
          .then((sessions) => {
            if (sessions.length === 0) {
              info("no sessions for this directory yet");
              return;
            }
            info(
              sessions
                .map((entry) => `${entry.sessionId}  ${entry.preview ?? "(no messages)"}`)
                .join("\n"),
            );
          })
          .catch(reportError);
        break;
      case "new":
        onNewSession();
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
      ) : configOpen ? (
        <ConfigPanel
          providers={providerChoices}
          currentModel={model}
          firstRun={firstRun}
          onSubmit={applyConfig}
          onCancel={cancelConfig}
        />
      ) : viewModel.busy ? (
        <Text color="yellow">✳ working… (esc to cancel)</Text>
      ) : (
        <Box>
          {viewModel.currentModeId && viewModel.currentModeId !== "default" ? (
            <Text color="magenta">[{viewModel.currentModeId}] </Text>
          ) : null}
          <Text color="cyan">{"> "}</Text>
          <TextInput value={draft} onChange={setDraft} onSubmit={submit} />
        </Box>
      )}
      {viewModel.usage ? <UsageFooter usage={viewModel.usage} /> : null}
    </Box>
  );
}

function UsageFooter({ usage }: { usage: NonNullable<SessionViewModel["usage"]> }) {
  const { lastTurn, cumulative } = usage;
  const cached =
    cumulative.cacheReadTokens && cumulative.cacheReadTokens > 0
      ? ` (${formatTokens(cumulative.cacheReadTokens)} cached)`
      : "";
  const parts = [
    ...(lastTurn
      ? [
          `last ${formatTokens(lastTurn.inputTokens)} in / ${formatTokens(lastTurn.outputTokens)} out`,
        ]
      : []),
    `session ${formatTokens(cumulative.inputTokens)} in / ${formatTokens(cumulative.outputTokens)} out${cached}`,
  ];
  return <Text dimColor>tokens · {parts.join(" · ")}</Text>;
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
      return (
        <Box marginTop={1}>
          <Text>{item.text}</Text>
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
  }
}

const STATUS_COLOR = {
  pending: "yellow",
  in_progress: "yellow",
  completed: "green",
  failed: "red",
} as const;

function ToolView({ item }: { item: Extract<ViewItem, { kind: "tool" }> }) {
  const preview = item.output ? firstLines(item.output, 4) : null;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={STATUS_COLOR[item.status]}>⏺ </Text>
        <Text bold>{item.title}</Text>
        <Text dimColor> [{item.status}]</Text>
      </Text>
      {preview ? (
        <Box marginLeft={2}>
          <Text dimColor>{preview}</Text>
        </Box>
      ) : null}
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

function PermissionPrompt({ pending }: { pending: PendingPermission }) {
  useInput((input, key) => {
    const answer = input.toLowerCase();
    if (answer === "y") {
      pending.resolve({ outcome: { outcome: "selected", optionId: "allow" } });
    } else if (answer === "a") {
      pending.resolve({ outcome: { outcome: "selected", optionId: "allow_always" } });
    } else if (answer === "n") {
      pending.resolve({ outcome: { outcome: "selected", optionId: "reject" } });
    } else if (key.escape) {
      // ACP cancelled outcome: abandon the whole turn, not just this call.
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
  });
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow" bold>
        Permission required
      </Text>
      <Text>{pending.request.toolCall.title}</Text>
      <Text dimColor>y allow · a always allow · n reject · esc cancel turn</Text>
    </Box>
  );
}
