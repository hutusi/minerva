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

Or install a released build — each release ships per-platform tarballs
(linux-x86_64, darwin-arm64) containing the `minerva` binary and its `rg`
sidecar, which must stay side by side:

```sh
gh release download --pattern "minerva-*-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m).tar.gz" --dir /tmp/minerva-dl
mkdir -p ~/.local/lib/minerva && tar -xzf /tmp/minerva-dl/minerva-*.tar.gz -C ~/.local/lib/minerva
ln -sf ~/.local/lib/minerva/minerva ~/.local/bin/minerva
```

(The repo is private, so downloads go through an authenticated `gh`.)

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
  -p, --print [text]   One-shot mode: run the prompt (or stdin when piped),
                       print the reply, exit 0 on a completed turn
  --mode <id>          Session mode for -p (plan | default | acceptEdits | auto)
  -c, --continue       Resume the most recent session for this directory
  -r, --resume <id>    Resume a specific session
  -m, --model <ref>    Model as [provider/]model, e.g. openai/gpt-5.2 or
                       claude-opus-4-8 (bare ids default to Anthropic)
  --profile <name>     Named profile from settings (system prompt, model, mode)
  -h, --help           Show help
```

One-shot print mode composes with pipes — only the model's reply lands on
stdout (tool progress and diagnostics go to stderr):

```sh
minerva -p "explain this repo" --mode auto
git diff | minerva -p              # prompt read from stdin
minerva -c -p "and now add tests"  # continue the latest session
```

Print mode always runs in an **explicit** mode — `default` unless `--mode`
says otherwise — overriding the session's or settings' mode, so a session
left in `auto` (or a `defaultMode: "auto"` in settings) can never execute
tools silently in a headless run. In `default` mode every permission request
is **auto-denied** (there is nobody to ask); the model is told and continues.
Use `--mode acceptEdits` or `--mode auto` to let tools run unattended.

Inside the TUI:

| Command | Effect |
|---|---|
| `/help` | List commands |
| `/config` | Choose provider, API key, and model — applies to the next prompt, no restart |
| `/mode [id]` | Show or set the session mode (`plan` \| `default` \| `acceptEdits` \| `auto`) |
| `/compact` | Summarize the conversation and reset the model context |
| `/profile [name]` | List profiles, switch persona (`none` clears) |
| `/sessions`, `/resume` | Pick a recent session and switch to it in place |
| `/new` | Start a fresh session |
| `/exit` | Quit |

The composer recalls input history with ↑/↓ (persisted across runs) and
autocompletes `/commands` and skills with tab/enter. `esc` cancels the running
turn — including while a permission prompt is open. Permission prompts show
what the call will do (command, file diff, URL), navigate with ↑/↓ + enter,
and keep the `y` / `a` (allow always — persisted as a project rule) / `n`
hotkeys; `esc` cancels the turn.

## Providers

Model references are `provider/model`. Keys resolve as **env var → key stored
in global settings** (set either via `/config`):

| Provider | Example ref | Key |
|---|---|---|
| Anthropic (default) | `claude-opus-4-8` or `anthropic/claude-opus-4-8` | `ANTHROPIC_API_KEY` |
| OpenAI | `openai/gpt-5.2` | `OPENAI_API_KEY` |
| Alibaba Bailian (DashScope) | `bailian/qwen-plus`, `bailian/glm-5.2` | `DASHSCOPE_API_KEY` |
| Ollama (local) | `ollama/llama3.3` | none (`OLLAMA_API_KEY` if your server wants one) |

Bailian uses the China endpoint by default; for the international one,
override its `baseUrl` in settings (see below). Bailian hosts third-party
models too (e.g. Zhipu's GLM) — the `/config` panel lists the known ids to
pick from at the model step, with an `other…` row for any id it doesn't know.
Ollama is keyless and points at `http://localhost:11434/v1`; override its
`baseUrl` in settings for a remote host, and set its `contextWindow` to match
the model you pulled if you want auto-compaction (unset, it never compacts).
Any other OpenAI-compatible endpoint (DeepSeek, llama.cpp, a proxy…) can be
added as a custom provider — via `/config` → `custom…`, or directly in
settings.

## Configuration

Settings merge from `~/.minerva/settings.json` (global; override the root with
`MINERVA_DATA_DIR`) and `<project>/.minerva/settings.json` (project). Example:

```json
{
  "model": "bailian/qwen-plus",
  "providers": {
    "bailian": {
      "apiKey": "sk-...",
      "baseUrl": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      "thinking": true
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
    "calc": { "command": "bun", "args": ["run", "./tools/mcp-calc.ts"] },
    "remote": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ..." }
    }
  },
  "profiles": {
    "writer": {
      "systemPrompt": "You are a technical writing assistant. ...",
      "model": "bailian/qwen-plus",
      "defaultMode": "plan"
    }
  },
  "profile": "writer"
}
```

`model` picks the default model ref (`--model` and `MINERVA_MODEL` override
it). `providers` overrides a built-in (e.g. Bailian's endpoint) or defines a
new OpenAI-compatible one — a new name needs `baseUrl`, and its key env var
defaults to `<NAME>_API_KEY`. Keyless endpoints (e.g. a local Ollama) set
`"requiresApiKey": false` so startup doesn't demand a key — the `/config`
panel writes this automatically when you save a custom provider without one.
**API keys are honored from the global file only** (never the shareable
project file), and any file that may hold keys is written with mode `0600`.

`profiles` defines named personas: `systemPrompt` **replaces** the base
coding-agent prompt (AGENTS.md instructions still append after it), `model`
is the model the profile prefers (used at startup unless `--model` /
`MINERVA_MODEL` override it), and `defaultMode` sets the session's initial
mode. `profile` names the one applied by default; `--profile <name>` picks
one per run, and `/profile` lists or switches mid-session (from the next
message). Per-name entries merge project-over-global like `providers`.

`"contextWindow"` (tokens, per provider) drives auto-compaction: when the
previous prompt's context crosses 80% of the window, the next prompt runs a
summarization turn first and continues from the summary (the transcript keeps
the full history). Built-ins carry defaults (anthropic/openai 200k, bailian
128k); override per provider — e.g.
`"bailian": { "contextWindow": 1000000 }` for a long-context model — and
custom providers without one never auto-compact.

`"thinking"` asks the model to reason before answering: `true` sends
`enable_thinking: true` to the endpoint (needed by Qwen models, which default
it off), `false` suppresses it (GLM models think by default), unset sends
nothing. A single boolean applies to every model on the provider; when one
provider hosts model families with opposite defaults — Bailian serves both
Qwen and GLM — use a per-model map whose keys are model-id patterns with `*`
wildcards (most specific match wins):

```json
"bailian": { "thinking": { "qwen-*": true, "glm-*": false } }
```

OpenAI-compatible providers only — setting it on `anthropic`/`openai` is
rejected at startup (Anthropic extended thinking needs reasoning replayed into
tool loops, which Minerva doesn't do yet). Reasoning the model streams is shown
dimmed while it thinks and collapses to a one-line summary once the answer
starts; either way it is display-only and never re-sent to the model.

`mcpServers` entries are stdio by default (`command` + optional `args`/`env`,
launched in the project directory); `"type": "http"` entries connect to a
remote server over Streamable HTTP (with an SSE fallback for older servers)
and may carry extra request `headers`. Header values often hold tokens —
unlike provider API keys they are honored from both settings layers, so keep
tokened servers in the **global** file, not a shared project one. A server
that fails to connect degrades to a startup warning; the session still opens.

Permission rules are `tool` or `tool(pattern)` where `*` matches any run of
characters, `?` one character, and `\*` a literal asterisk. Precedence:
**deny** → **ask** → read-only auto-allow → **plan mode deny** → **allow** →
mode default. Rules match the bash command string, the URL for fetch-shaped
tools (`web_fetch(https://example.com/*)`), or the file path; MCP tools are
named `mcp__<server>__<tool>` and are never auto-allowed.

> **Bash rules are advisory, not a sandbox.** They match the raw command
> string, not a parsed argv, so a `bash(rm -rf *)` deny is evaded by
> `command rm -rf …`, `/bin/rm …`, or an equivalent `python -c …`, and a
> wildcard allow can match a compound `cmd; <anything>`. Treat them as friction
> that catches honest mistakes; use OS-level sandboxing for real isolation, and
> avoid `auto` mode with untrusted input.

> **web_fetch is permission-gated, not network-sandboxed.** It is never
> auto-allowed (network egress can exfiltrate context via the URL), so default
> mode always shows the exact URL before fetching, and `deny` rules can block
> URL ranges. Hosts that are — or resolve to — private/loopback addresses
> (cloud metadata endpoints, router admin pages, localhost) are refused by
> default, on the initial URL and on every redirect hop; set
> `"webFetch": { "allowPrivate": true }` in settings when developing against
> local servers. This is friction against accidental SSRF-shaped fetches, not
> a sandbox (DNS re-resolution between check and connect is not closed) —
> same posture as the bash rules above.

> **Opening a third-party repository activates its configuration.** The
> project's `AGENTS.md` enters the system prompt, `.minerva/skills/` becomes
> invocable instructions, and `.minerva/settings.json` contributes permission
> allow rules and MCP server definitions the moment a session starts. Project
> files that resolve outside the workspace (symlinks) are refused, and project
> API keys are never honored — but prompt-shaping text is trusted by design.
> Skim those files before working in an unfamiliar repo, and prefer `default`
> or `plan` mode over `acceptEdits`/`auto` there.

Every session is an append-only JSONL event log under
`~/.minerva/projects/<project>/` — the audit trail and the source of truth for
`--resume`.

## Subagents

The model can delegate a self-contained side quest — a broad search, an
isolated analysis — to a subagent via the `task` tool: a child agent with the
same tools (minus `task` and `todo_write`) and the same system prompt, whose
transcript stays out of the main conversation; only its final report returns.
The CLI shows a collapsed progress line under the task
(`↳ 3 tool calls · grep "handleAuth"`).

Subagents change nothing about trust: every child tool call is judged by the
parent session's permission rules and mode — plan mode still blocks writes,
default mode still prompts (marked "from subagent"), and an "allow always"
covers the rest of the task and the session. `esc` cancels the task with the
turn. Child token spend rolls into the session totals. Each child's full
transcript is persisted as its own session log (excluded from `/sessions`)
next to the parent's, for auditing. Tasks run sequentially, cannot spawn
further tasks, and are capped at 10 per prompt — spawning itself is
auto-allowed (only the child's actions are gated), so the budget is what
bounds unapproved spend.

## Project instructions (AGENTS.md)

Put per-project guidance in an `AGENTS.md` at the project root (the
[agents.md](https://agents.md) convention) and per-user guidance in
`~/.minerva/AGENTS.md`; both are appended to the system prompt — global
first, then project — when a session starts, and the CLI notes which files
loaded. Only those two locations are read (no per-subdirectory files), each
capped at 24k characters, and edits take effect on the next new or resumed
session.

## Skills

Skills are reusable instructions the agent can pull in on demand: a
`SKILL.md` per skill under `.minerva/skills/<name>/` (project) or
`~/.minerva/skills/<name>/` (global), with frontmatter naming and describing
it:

```markdown
---
name: release-checklist
description: Steps for cutting a release safely
---

1. Run the full verify gate.
2. Tag with the CHANGELOG version.
...
```

Two ways in: the model sees every skill's name and description through a
read-only `skill` tool and loads the full instructions when one matches the
task (only names and descriptions ride in each request — bodies stay on disk
until invoked), and you can invoke one directly as `/release-checklist <args>`
— the transcript keeps what you typed while the model receives the skill body.
`/help` lists the available skills; project skills override same-named global
ones, and built-in commands always beat a same-named skill. Frontmatter is
parsed as simple `key: value` lines (no multiline YAML). A `deny: ["skill"]`
permission rule blocks skills for the model **and** for `/name` invocations;
ask rules don't apply to `/name` — typing the command is consent.

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
(`packages/cli/test/acp.test.ts`), and live Zed interop is validated against
the compiled binary: streaming replies, the permission round-trip, and
subagent `task` calls (shown as a plain tool call — Zed doesn't consume the
`minerva/session/task_update` extension) all work.

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
bun run build:release   # dist/{minerva, rg}: compiled binary + ripgrep sidecar
```

The release is a **pair**: the compiled `minerva` and a `rg` sidecar it resolves
at runtime for the glob/grep tools. Because `@vscode/ripgrep` ships only the host
platform's `rg`, cross-compiling with `--target` for a different OS/arch is
rejected (it would pair the binary with the wrong `rg`); build on the target
platform to produce a native pair.

> **Resolved (macOS arm64):** Bun 1.3.12 emitted binaries with a truncated
> code signature that the kernel SIGKILLed on launch
> ([oven-sh/bun#29270](https://github.com/oven-sh/bun/issues/29270), fixed in
> 1.3.13; this repo pins 1.3.14). `build:release` now ad-hoc re-signs on
> macOS and self-checks the artifact — it runs the built binary and verifies
> its signature — so a recurrence fails the build instead of shipping.
