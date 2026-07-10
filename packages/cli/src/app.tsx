import type { MinervaClient, SessionStore, ViewItem } from "@minerva/client";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { PendingPermission, PermissionBridge } from "./permission-bridge";

interface AppProps {
  client: MinervaClient;
  bridge: PermissionBridge;
  model: string;
  cwd: string;
  /** null = new session; "latest" = most recent for cwd; else a session id. */
  resume: string | null;
}

export function App({ client, bridge, model, cwd, resume }: AppProps) {
  const [session, setSession] = useState<{ id: string; store: SessionStore } | null>(null);
  const [pending, setPending] = useState<PendingPermission | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      .then(({ sessionId, store }) => setSession({ id: sessionId, store }))
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    return () => {
      bridge.handler = null;
    };
  }, [client, bridge, cwd, resume]);

  if (error) {
    return <Text color="red">Failed to start session: {error}</Text>;
  }
  if (!session) {
    return <Text dimColor>Starting Minerva…</Text>;
  }
  const startNewSession = () => {
    client
      .newSession(cwd)
      .then(({ sessionId, store }) => setSession({ id: sessionId, store }))
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  };
  return (
    <Box flexDirection="column">
      <Text dimColor>
        Minerva · {model} · {cwd} · /help for commands, esc to cancel
      </Text>
      <Chat
        client={client}
        session={session}
        pending={pending}
        cwd={cwd}
        onNewSession={startNewSession}
      />
    </Box>
  );
}

const HELP_TEXT = [
  "/help              show this help",
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
  onNewSession,
}: {
  client: MinervaClient;
  session: { id: string; store: SessionStore };
  pending: PendingPermission | null;
  cwd: string;
  onNewSession: () => void;
}) {
  const subscribe = useCallback(
    (listener: () => void) => session.store.subscribe(listener),
    [session.store],
  );
  const viewModel = useSyncExternalStore(subscribe, () => session.store.snapshot);
  const [draft, setDraft] = useState("");
  const { exit } = useApp();

  useInput((_input, key) => {
    if (key.escape && viewModel.busy) client.cancel(session.id);
  });

  const info = (text: string) => session.store.addInfo(text);
  const reportError = (cause: unknown) =>
    info(`error: ${cause instanceof Error ? cause.message : String(cause)}`);

  const runCommand = (input: string) => {
    const [command = "", ...rest] = input.slice(1).split(/\s+/);
    const argument = rest.join(" ");
    switch (command) {
      case "exit":
      case "quit":
        exit();
        break;
      case "help":
        info(HELP_TEXT);
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

  return (
    <Box flexDirection="column">
      {viewModel.items.map((item, index) => (
        <ItemView key={itemKey(item, index)} item={item} />
      ))}
      {pending ? (
        <PermissionPrompt pending={pending} />
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
    </Box>
  );
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

function firstLines(text: string, count: number): string {
  const lines = text.trimEnd().split("\n");
  if (lines.length <= count) return lines.join("\n");
  return `${lines.slice(0, count).join("\n")}\n… (${lines.length - count} more lines)`;
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
