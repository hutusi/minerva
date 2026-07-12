import type { SessionSummary } from "@minerva/protocol";
import { Box, Text, useInput, useStdout } from "ink";
import { useRef, useState } from "react";

/**
 * Arrow-key list over minerva/sessions/list rows, opened by /sessions and
 * /resume. Same inline-replacement pattern as ConfigPanel: it occupies the
 * composer slot, and a permission prompt always outranks it.
 */

/** Coarse "how long ago" for the picker rows. Exported for unit tests. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function SessionPicker({
  sessions,
  currentId,
  onSelect,
  onCancel,
}: {
  sessions: SessionSummary[];
  currentId: string;
  onSelect: (sessionId: string) => void;
  onCancel: () => void;
}) {
  const { stdout } = useStdout();
  const [index, setIndex] = useState(0);
  // Ref mirror of `index` (config-panel pattern): a ↓+enter arriving in one
  // input batch must select the row the user saw highlighted.
  const indexRef = useRef(0);
  useInput((input, key) => {
    if (key.upArrow || key.downArrow || input === "k" || input === "j") {
      const delta = key.upArrow || input === "k" ? -1 : 1;
      indexRef.current = (indexRef.current + sessions.length + delta) % sessions.length;
      setIndex(indexRef.current);
    } else if (key.return) {
      const chosen = sessions[indexRef.current];
      if (chosen) onSelect(chosen.sessionId);
    } else if (key.escape) {
      onCancel();
    }
  });
  // Row budget: time column + markers eat ~20 columns; the preview gets the rest.
  const previewWidth = Math.max(20, (stdout?.columns ?? 80) - 20);
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>
        Sessions
      </Text>
      {sessions.map((session, i) => (
        <Text key={session.sessionId} {...(i === index ? { color: "cyan" } : {})}>
          {i === index ? "❯ " : "  "}
          {relativeTime(session.createdAt).padEnd(12)}
          {clip(session.preview ?? "(no messages)", previewWidth)}
          {session.sessionId === currentId ? <Text dimColor> (current)</Text> : null}
        </Text>
      ))}
      <Text dimColor>↑/↓ select · enter resume · esc cancel</Text>
    </Box>
  );
}

function clip(text: string, width: number): string {
  const flat = text.replaceAll("\n", " ");
  return flat.length <= width ? flat : `${flat.slice(0, Math.max(1, width - 1))}…`;
}
