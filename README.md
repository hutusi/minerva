# Minerva

[![CI](https://github.com/hutusi/minerva/actions/workflows/ci.yml/badge.svg)](https://github.com/hutusi/minerva/actions/workflows/ci.yml)

A cross-platform, model-agnostic code agent — a headless kernel with multiple
frontends (CLI now, GUI later).

- **Architecture**: protocol everywhere ([ACP](https://agentclientprotocol.com)
  core + `minerva/*` extensions), one kernel, swappable transports (in-process,
  stdio; WebSocket planned).
- **Stack**: TypeScript, Bun, Vercel AI SDK, Ink (CLI), Tauri 2 (GUI, planned).

Docs: [design record](docs/DESIGN.md) · [wire protocol](docs/PROTOCOL.md) ·
[contributing](CONTRIBUTING.md) · [changelog](CHANGELOG.md)

## Quick start

```sh
bun install
bun run --cwd packages/cli dev
```

On first run with no API key configured, the TUI opens an interactive setup
panel: pick a provider, paste a key, confirm a model. Keys can also come from
the environment (`export ANTHROPIC_API_KEY="sk-ant-..."`), which always takes
precedence over stored ones.

## Usage

```
minerva [command] [options]

Commands:
  (default)            Interactive terminal UI
  acp                  Host the kernel on stdio (ACP framing) for editors

Options:
  -c, --continue       Resume the most recent session for this directory
  -r, --resume <id>    Resume a specific session
  -m, --model <ref>    Model as [provider/]model, e.g. openai/gpt-5.2 or
                       claude-opus-4-8 (bare ids default to Anthropic)
  -h, --help           Show help
```

Inside the TUI:

| Command | Effect |
|---|---|
| `/help` | List commands |
| `/config` | Choose provider, API key, and model — applies to the next prompt, no restart |
| `/mode [id]` | Show or set the session mode (`plan` \| `default` \| `acceptEdits` \| `auto`) |
| `/compact` | Summarize the conversation and reset the model context |
| `/sessions` | List recent sessions for this directory |
| `/new` | Start a fresh session |
| `/exit` | Quit |

`esc` cancels the running turn — including while a permission prompt is open.
Permission prompts accept `y` (allow once), `a` (allow always — persisted as a
project rule), `n` (reject), `esc` (cancel the turn).

## Providers

Model references are `provider/model`. Keys resolve as **env var → key stored
in global settings** (set either via `/config`):

| Provider | Example ref | Key |
|---|---|---|
| Anthropic (default) | `claude-opus-4-8` or `anthropic/claude-opus-4-8` | `ANTHROPIC_API_KEY` |
| OpenAI | `openai/gpt-5.2` | `OPENAI_API_KEY` |
| Alibaba Bailian (DashScope) | `bailian/qwen-plus`, `bailian/glm-5.2` | `DASHSCOPE_API_KEY` |

Bailian uses the China endpoint by default; for the international one,
override its `baseUrl` in settings (see below). Bailian hosts third-party
models too (e.g. Zhipu's GLM) — the `/config` panel cycles the known ids with
↑/↓ at the model step, and any id it doesn't know can simply be typed. Any
other OpenAI-compatible endpoint (DeepSeek, Ollama, a proxy…) can be added as
a custom provider — via `/config` → `custom…`, or directly in settings.

## Configuration

Settings merge from `~/.minerva/settings.json` (global; override the root with
`MINERVA_DATA_DIR`) and `<project>/.minerva/settings.json` (project). Example:

```json
{
  "model": "bailian/qwen-plus",
  "providers": {
    "bailian": {
      "apiKey": "sk-...",
      "baseUrl": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
    },
    "deepseek": {
      "baseUrl": "https://api.deepseek.com/v1",
      "defaultModel": "deepseek-chat"
    }
  },
  "defaultMode": "default",
  "permissions": {
    "allow": ["bash(git status)", "bash(bun test*)"],
    "deny": ["read_file(secrets/*)", "bash(rm -rf *)"],
    "ask": ["bash(git push*)"]
  },
  "mcpServers": {
    "calc": { "command": "bun", "args": ["run", "./tools/mcp-calc.ts"] }
  }
}
```

`model` picks the default model ref (`--model` and `MINERVA_MODEL` override
it). `providers` overrides a built-in (e.g. Bailian's endpoint) or defines a
new OpenAI-compatible one — a new name needs `baseUrl`, and its key env var
defaults to `<NAME>_API_KEY`. **API keys are honored from the global file
only** (never the shareable project file), and any file that may hold keys is
written with mode `0600`.

Permission rules are `tool` or `tool(pattern)` where `*` matches any run of
characters, `?` one character, and `\*` a literal asterisk. Precedence:
**deny** → **ask** → read-only auto-allow → **plan mode deny** → **allow** →
mode default. Rules match the bash command string or the file path; MCP tools
are named `mcp__<server>__<tool>` and are never auto-allowed.

Every session is an append-only JSONL event log under
`~/.minerva/projects/<project>/` — the audit trail and the source of truth for
`--resume`.

## Editors (ACP)

`minerva acp` hosts the kernel on stdio with ACP framing. For Zed, add an
agent server along these lines:

```json
{
  "agent_servers": {
    "Minerva": {
      "command": "bun",
      "args": ["run", "/path/to/minerva/packages/cli/src/index.tsx", "acp"]
    }
  }
}
```

The stdio wire contract is covered by an automated harness
(`packages/cli/test/acp.test.ts`); live Zed interop has not been validated yet.

## Development

```sh
bun run verify        # typecheck + lint + all tests
bun test packages/kernel
```

The repo is a Bun workspace: `packages/protocol` (JSON-RPC + ACP types +
transports), `packages/kernel` (agent loop, sessions, tools, permissions,
MCP), `packages/providers` (model adapters), `packages/client` (shared
frontend core), `packages/cli` (Ink UI + acp host), `apps/gui` (planned).

## Release build

```sh
bun run build:release   # dist/minerva, single-file executable
```

Cross-compile with `--target` (e.g. `bun-linux-x64`, `bun-windows-x64`).

> **Known issue (macOS arm64):** with Bun 1.3.12 the compiled binary comes out
> unsigned; the kernel kills unsigned arm64 binaries (SIGKILL on launch) and
> `codesign` rejects the file format for re-signing. Until this is resolved
> (try a newer Bun), run the CLI via `bun run packages/cli/src/index.tsx`.
