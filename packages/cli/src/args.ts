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
  /** Named profile from --profile; null = use the settings default. */
  profile: string | null;
  /** -p/--print one-shot mode: absent = TUI; prompt null = read stdin. */
  print: { prompt: string | null } | null;
  /** --mode for print mode's non-interactive permission story. */
  mode: string | null;
}

export type ParsedCli =
  | { kind: "run"; args: CliArgs }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string };

export function usage(defaultModel: string): string {
  return `minerva — model-agnostic code agent

Usage: minerva [command] [options]

Commands:
  (default)            Interactive terminal UI
  acp                  Host the kernel on stdio (ACP framing) for editors

Options:
  -p, --print [text]   One-shot mode: run the prompt (or stdin when piped),
                       print the reply, exit 0 on a completed turn
  --mode <id>          Session mode for -p (plan | default | acceptEdits |
                       auto); default asks nothing and denies side effects
  -c, --continue       Resume the most recent session for this directory
  -r, --resume <id>    Resume a specific session
  -m, --model <ref>    Model as [provider/]model, e.g. bailian/qwen-plus or
                       claude-opus-4-8 (default: ${defaultModel}, env: MINERVA_MODEL)
  --profile <name>     Named profile from settings (system prompt, model,
                       default mode); see the profiles section of the README
  -h, --help           Show this help
  -v, --version        Print the version and exit

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
  let profile: string | null = null;
  let print: CliArgs["print"] = null;
  let mode: string | null = null;
  let command: CliArgs["command"] = "tui";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "acp" && command === "tui") {
      command = "acp";
    } else if (arg === "--print" || arg === "-p") {
      // The prompt is optional: a following flag (or nothing) means stdin.
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        print = { prompt: next };
        i++;
      } else {
        print = { prompt: null };
      }
    } else if (arg === "--mode") {
      const value = argv[++i];
      if (!value || value.startsWith("-")) {
        return { kind: "error", message: "--mode requires a mode id" };
      }
      mode = value;
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
    } else if (arg === "--profile") {
      const value = argv[++i];
      if (!value || value.startsWith("-")) {
        return { kind: "error", message: "--profile requires a profile name" };
      }
      profile = value;
    } else if (arg === "--help" || arg === "-h") {
      return { kind: "help" };
    } else if (arg === "--version" || arg === "-v") {
      return { kind: "version" };
    } else {
      return { kind: "error", message: `unknown option: ${arg}` };
    }
  }
  // --mode exists for print mode's non-interactive permission story; the TUI
  // keeps /mode so the flag can't silently change interactive policy.
  if (mode !== null && print === null) {
    return { kind: "error", message: "--mode requires -p/--print (use /mode in the TUI)" };
  }
  if (print !== null && command === "acp") {
    return { kind: "error", message: "acp and --print are mutually exclusive" };
  }
  return { kind: "run", args: { command, model, resume, profile, print, mode } };
}
