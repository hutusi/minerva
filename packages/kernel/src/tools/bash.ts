import type { KernelTool } from "./types";
import { asRecord, requireString } from "./types";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 30_000;

export const bashTool: KernelTool = {
  name: "bash",
  description:
    "Run a shell command in the working directory (bash -c, pipes only — no TTY, so " +
    "avoid interactive commands). Returns stdout, stderr, and the exit code. " +
    "Default timeout 120s, maximum 600s.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to run" },
      timeout_ms: { type: "number", description: "Timeout in milliseconds (max 600000)" },
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

    const result = await context.runtime.exec(command, {
      cwd: context.cwd,
      timeoutMs,
      signal: context.signal,
    });

    const parts: string[] = [];
    if (result.stdout) parts.push(truncate(result.stdout));
    if (result.stderr) parts.push(`[stderr]\n${truncate(result.stderr)}`);
    if (result.aborted) parts.push("[command cancelled by user]");
    else if (result.timedOut) parts.push(`[command timed out after ${timeoutMs}ms]`);
    if (result.exitCode !== 0) parts.push(`[exit code: ${result.exitCode}]`);
    return {
      output: parts.join("\n") || "(no output)",
      isError: result.exitCode !== 0 || result.timedOut || result.aborted,
    };
  },
};

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n[truncated: output is ${text.length} characters]`;
}
