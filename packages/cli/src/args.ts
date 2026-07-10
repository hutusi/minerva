/**
 * Pure argv parsing, extracted from the entrypoint so it is unit-testable —
 * top-level script code with process.exit calls can't be exercised by tests.
 */

interface CliArgs {
  command: "tui" | "acp";
  /** Model ref from -m/--model; null when the flag was not given, so the
   *  entrypoint can fall back to MINERVA_MODEL and then settings. */
  model: string | null;
  resume: string | null;
}

export type ParsedCli =
  | { kind: "run"; args: CliArgs }
  | { kind: "help" }
  | { kind: "error"; message: string };

export function usage(defaultModel: string): string {
  return `minerva — model-agnostic code agent

Usage: minerva [command] [options]

Commands:
  (default)            Interactive terminal UI
  acp                  Host the kernel on stdio (ACP framing) for editors

Options:
  -c, --continue       Resume the most recent session for this directory
  -r, --resume <id>    Resume a specific session
  -m, --model <ref>    Model as [provider/]model, e.g. bailian/qwen-plus or
                       claude-opus-4-8 (default: ${defaultModel}, env: MINERVA_MODEL)
  -h, --help           Show this help

Environment:
  ANTHROPIC_API_KEY    Key for anthropic/* models
  OPENAI_API_KEY       Key for openai/* models
  DASHSCOPE_API_KEY    Key for bailian/* models (Alibaba Bailian)
  MINERVA_DATA_DIR     Session/config root (default: ~/.minerva)

Model, provider, and API-key configuration can also live in settings
(~/.minerva/settings.json) — run the TUI and use /config to set it up.`;
}

export function parseCliArgs(argv: string[]): ParsedCli {
  let model: string | null = null;
  let resume: string | null = null;
  let command: CliArgs["command"] = "tui";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "acp" && command === "tui") {
      command = "acp";
    } else if (arg === "--continue" || arg === "-c") {
      resume = "latest";
    } else if (arg === "--resume" || arg === "-r") {
      const value = argv[++i];
      if (!value || value.startsWith("-")) {
        return { kind: "error", message: "--resume requires a session id" };
      }
      resume = value;
    } else if (arg === "--model" || arg === "-m") {
      const value = argv[++i];
      if (!value || value.startsWith("-")) {
        return { kind: "error", message: "--model requires a model id" };
      }
      model = value;
    } else if (arg === "--help" || arg === "-h") {
      return { kind: "help" };
    } else {
      return { kind: "error", message: `unknown option: ${arg}` };
    }
  }
  return { kind: "run", args: { command, model, resume } };
}
