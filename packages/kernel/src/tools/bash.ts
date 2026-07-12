import type { KernelTool } from "./types";
import { asRecord, requireString } from "./types";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 30_000;

export const bashTool: KernelTool = {
  name: "bash",
  description:
    "Run a shell command in the working directory (bash -c). Returns stdout, " +
    "stderr, and the exit code. Default timeout 120s, maximum 600s. By " +
    "default there is no TTY (pipes) — set pty: true when the command needs " +
    "a terminal (colors, TTY-gated tools, watch modes rendered until the " +
    "timeout); under a PTY stdout and stderr are merged and ANSI escapes are " +
    "stripped. POSIX only; elsewhere it falls back to pipes. Interactive " +
    "stdin is never available.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to run" },
      timeout_ms: { type: "number", description: "Timeout in milliseconds (max 600000)" },
      pty: {
        type: "boolean",
        description:
          "Run under a pseudo-terminal so the command sees a TTY; merges stderr into stdout",
      },
    },
    required: ["command"],
  },
  kind: "execute",
  readOnly: false,
  title(input) {
    return requireString(asRecord(input), "command");
  },
  async execute(input, context) {
    const record = asRecord(input);
    const command = requireString(record, "command");
    // 0, negative, and NaN would arm an instant kill timer — fall back to
    // the default instead of trusting the model's arithmetic.
    const requested = record.timeout_ms;
    const timeoutMs =
      typeof requested === "number" && Number.isFinite(requested) && requested > 0
        ? Math.min(requested, MAX_TIMEOUT_MS)
        : DEFAULT_TIMEOUT_MS;
    // Opt-in, not default: a PTY merges stderr into stdout, and silently
    // dropping the [stderr] attribution would change what the model sees on
    // every ordinary command. Permission rules are unaffected — they match
    // the command string, which pty doesn't alter.
    const pty = record.pty === true;

    const execOptions = { cwd: context.cwd, timeoutMs, signal: context.signal };
    const result = pty
      ? await context.runtime.execPty(command, execOptions)
      : await context.runtime.exec(command, execOptions);

    const stdout = pty ? normalizePtyOutput(result.stdout) : result.stdout;
    const parts: string[] = [];
    if (stdout) parts.push(truncate(stdout));
    if (result.stderr) parts.push(`[stderr]\n${truncate(result.stderr)}`);
    if (pty && result.ptyFallback) {
      parts.push("[pty unavailable on this platform — ran with pipes]");
    }
    if (result.aborted) parts.push("[command cancelled by user]");
    else if (result.timedOut) parts.push(`[command timed out after ${timeoutMs}ms]`);
    if (result.exitCode !== 0) parts.push(`[exit code: ${result.exitCode}]`);
    return {
      output: parts.join("\n") || "(no output)",
      isError: result.exitCode !== 0 || result.timedOut || result.aborted,
    };
  },
};

/**
 * Make raw PTY output readable as plain text: CRLF newlines, ANSI color/
 * cursor/title sequences, backspace erasure (macOS script echoes ^D + BS on
 * stdin EOF), and \r progress-bar overwrites all resolve to the final
 * visible state. Deliberately conservative — only well-formed escape
 * sequences are stripped, so unusual-but-legitimate output survives.
 */
export function normalizePtyOutput(text: string): string {
  let out = text.replace(/\r\n/g, "\n");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escapes requires matching them
  out = out.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ""); // OSC (titles)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escapes requires matching them
  out = out.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ""); // CSI (colors, cursor)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escapes requires matching them
  out = out.replace(/\x1b[()][A-Za-z0-9]/g, "").replace(/\x1b[=>]/g, ""); // charset/keypad
  // Backspace erasure, innermost first ("abc\b\b" leaves "a").
  // biome-ignore lint/suspicious/noControlCharactersInRegex: backspace handling requires matching \x08
  while (/[^\n\x08]\x08/.test(out)) out = out.replace(/[^\n\x08]\x08/g, "");
  // A \r-rewritten line keeps only its final state (progress bars).
  out = out
    .split("\n")
    .map((line) => line.split("\r").pop() ?? "")
    .join("\n");
  // Stray control characters (the EOT echo, orphaned BS/ESC); \n and \t stay.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping stray control characters is the point
  out = out.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  return out;
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n[truncated: output is ${text.length} characters]`;
}
