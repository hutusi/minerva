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
}

export function App({ client, bridge, model, cwd }: AppProps) {
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
    client
      .initialize()
      .then(() => client.newSession(cwd))
      .then(({ sessionId, store }) => setSession({ id: sessionId, store }))
      .catch((cause) => setError(String(cause)));
    return () => {
      bridge.handler = null;
    };
  }, [client, bridge, cwd]);

  if (error) {
    return <Text color="red">Failed to start session: {error}</Text>;
  }
  if (!session) {
    return <Text dimColor>Starting Minerva…</Text>;
  }
  return (
    <Box flexDirection="column">
      <Text dimColor>
        Minerva · {model} · {cwd} · /exit to quit, esc to cancel
      </Text>
      <Chat client={client} session={session} pending={pending} />
    </Box>
  );
}

function Chat({
  client,
  session,
  pending,
}: {
  client: MinervaClient;
  session: { id: string; store: SessionStore };
  pending: PendingPermission | null;
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

  const submit = (value: string) => {
    const text = value.trim();
    if (!text) return;
    setDraft("");
    if (text === "/exit" || text === "/quit") {
      exit();
      return;
    }
    client.prompt(session.id, text).catch((cause) => {
      session.store.addInfo(`error: ${String(cause)}`);
    });
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
          <Text color="cyan">{"> "}</Text>
          <TextInput value={draft} onChange={setDraft} onSubmit={submit} />
        </Box>
      )}
    </Box>
  );
}

function itemKey(item: ViewItem, index: number): string {
  return item.kind === "tool" ? `tool-${item.toolCallId}` : `${item.kind}-${index}`;
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

function PermissionPrompt({ pending }: { pending: PendingPermission }) {
  useInput((input) => {
    const answer = input.toLowerCase();
    if (answer === "y") {
      pending.resolve({ outcome: { outcome: "selected", optionId: "allow" } });
    } else if (answer === "n") {
      pending.resolve({ outcome: { outcome: "selected", optionId: "reject" } });
    }
  });
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow" bold>
        Permission required
      </Text>
      <Text>{pending.request.toolCall.title}</Text>
      <Text dimColor>allow? (y/n)</Text>
    </Box>
  );
}
