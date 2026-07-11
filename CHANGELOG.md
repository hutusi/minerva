# Changelog

All notable changes to Minerva are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/) once tagged.

## [Unreleased]

### Added
- AGENTS.md project instructions: a project-root `AGENTS.md` (and a global
  `~/.minerva/AGENTS.md`) is appended to the system prompt at session
  establish, so per-project guidance no longer requires forking the host's
  system prompt. `session/new`/`session/load` report which files loaded via a
  new optional `instructions` result field (generic ACP clients ignore it),
  and the CLI prints a dimmed "project instructions loaded" line. Root +
  global only, 24k chars per file with a truncation marker; instructions are
  never persisted to the transcript, so resumed sessions pick up edits.
- Remote MCP servers over Streamable HTTP: an `mcpServers` entry with
  `"type": "http"` and a `url` (plus optional `headers` for bearer tokens)
  connects to a hosted server, falling back to SSE once for pre-2025-03
  servers; entries with a `command` remain stdio, so existing configs are
  untouched. Remote tools flow through the same `mcp__server__tool`
  permission gating, and an unreachable server still degrades to a startup
  warning instead of failing the session.
- Streamed model reasoning end-to-end: `agent_thought_chunk` (reserved since
  v0.1) is now emitted live and on `session/load` replay, backed by a new
  `assistant.thought` session event; the CLI shows the thought dimmed while
  it streams and collapses it to a one-line summary when the answer starts.
  A `thinking` setting sends `enable_thinking` to OpenAI-compatible endpoints
  (`true` for Qwen-style opt-in, `false` to suppress GLM's default thinking);
  it accepts either a boolean or a per-model map of `*`-wildcard patterns
  (e.g. `{ "qwen-*": true, "glm-*": false }`) so one provider can host model
  families with opposite defaults. Anthropic extended thinking is deliberately
  deferred — it requires replaying signature-carrying reasoning into tool
  loops — and the registry rejects the toggle on non-compatible providers at
  startup. `/compact` suppresses thinking for its summarization turn. Thoughts
  are display-only and never re-sent to the model.
- Token usage telemetry end-to-end: new `minerva/session/usage` notification
  carrying last-turn and session-cumulative token counts (including cache
  read/write tokens, now captured from the AI SDK), session totals rebuilt
  from the event log on resume, and a dim usage footer in the CLI. Tokens
  only — cost/pricing is deliberately deferred (see `docs/PROTOCOL.md`).
- Alibaba Bailian (DashScope) provider preset (`bailian/qwen-plus`,
  `DASHSCOPE_API_KEY`) and settings-defined custom OpenAI-compatible
  providers (any name + `baseUrl`), via `@ai-sdk/openai-compatible`. Keyless
  endpoints (e.g. local servers) persist `requiresApiKey: false`, so startup
  and `minerva acp` don't demand a key they don't need.
- Known-models lists on providers (`models` in the registry and settings):
  the bailian preset ships qwen-plus/-max/-turbo and GLM-5.2, offered as a
  select list at the `/config` panel's model step, with an `other…` row for
  free-text ids.
- Interactive `/config` panel in the TUI: pick a provider, enter an API key
  (masked), choose a model. Runs automatically on first launch when no key is
  found — replacing the old print-error-and-exit behavior — and applies live
  to the next prompt via the new `minerva/config/set_model` extension method.
- Settings: `model` (default model ref) and per-provider `providers` entries;
  API keys are honored from the global file only, always written mode `0600`.
- CI (GitHub Actions): verify matrix on ubuntu/macOS, per-file coverage
  thresholds, knip, PTY smoke + e2e for the TUI, compiled-binary smoke, and a
  secret-gated live-model smoke on main pushes; Dependabot.
- Ink UI test suite (ink-testing-library) and PTY e2e scripts in `scripts/`.
- `CONTRIBUTING.md`, `docs/PROTOCOL.md`, this changelog.

### Fixed
- `turn.completed` events now record usage summed across every model turn of
  a prompt; previously only the final model turn's tokens were persisted, so
  tool-call round-trips went uncounted (and `max_turn_requests` exits dropped
  usage entirely).
- The client store's `setBusy` no longer drops status state (`currentModeId`,
  usage) that was set while a prompt was running or during a `session/load`
  replay.
- Reasoning streaming now preserves what the user watched on every turn-loop
  exit: a thought that streams after the answer text is logged (and replayed)
  after it rather than before; a mid-stream provider error or thrown exception
  persists the partial answer and thought instead of dropping them, resolving
  any dangling tool calls so the history stays well-formed; and a thought-only
  turn records an assistant message so the provider history keeps alternating
  roles (strict endpoints rejected the consecutive user messages otherwise).
- Consecutive reasoning blocks are separated by a blank line instead of
  concatenating into one run-on thought.
- The streaming thought tail is capped by terminal width, so a long reasoning
  paragraph with no line breaks no longer floods the live region.
- `enable_thinking` providerOptions are keyed by the camelCased provider name,
  silencing the AI SDK deprecation warning (which corrupted the TUI) that dash-
  named custom providers triggered on every model call.

### Changed
- Upgraded Ink to v7 (`@minerva/cli`). Requires Node ≥22 and React ≥19.2, both
  already satisfied; no source changes were needed.
- Migrated to AI SDK 7 (`ai` v7, `@ai-sdk/anthropic`/`@ai-sdk/openai` v4) in
  `@minerva/providers`. Moved the adapter off the v6-compat shims: `streamText`
  result `fullStream` → `stream` and the `system` option → `instructions`; the
  test mock tracks the new provider spec (`MockLanguageModelV4`).
- Stricter static analysis: `exactOptionalPropertyTypes`, `noImplicitOverride`,
  Biome `noExplicitAny` at error level, knip in the gate.
- `PermissionBridge` is a factory function instead of a class.

## [0.1.0] — 2026-07-10

Initial version: the headless kernel + CLI milestone (PR #1).

### Added
- **Protocol** (`@minerva/protocol`): bidirectional JSON-RPC 2.0 with
  ACP-shaped methods, in-process and stdio (newline-delimited) transports,
  `minerva/*` extension namespace. See `docs/PROTOCOL.md`.
- **Kernel** (`@minerva/kernel`): streaming agent loop; append-only JSONL
  event-sourced sessions with resume (`session/load` replay, kill-9 safe) and
  audit trail; permission rule engine (`bash(git *)` patterns) with session
  modes (`plan`/`default`/`acceptEdits`/`auto`) and always-allow persistence;
  built-in tools (read/write/edit files, glob, grep, bash, todo) with
  workspace confinement; MCP client (stdio servers from settings, tools
  permission-gated as `mcp__server__tool`); manual `/compact`.
- **Providers** (`@minerva/providers`): kernel-owned `ModelProvider` boundary
  over the Vercel AI SDK; Anthropic (default `claude-opus-4-8`) and OpenAI via
  `provider/model` references.
- **Client** (`@minerva/client`): frontend-agnostic protocol client + session
  view-model store shared by the CLI and the planned GUI.
- **CLI** (`@minerva/cli`): Ink terminal UI with streaming, permission
  prompts, todo checklist, `--continue`/`--resume`, `/mode`, `/compact`,
  `/sessions`, `/new`; `minerva acp` stdio host for editors.

### Known issues
- Bun 1.3.12 on macOS arm64 emits unsigned compiled binaries (SIGKILLed on
  launch); run via `bun` until resolved.
- Live Zed interop over `minerva acp` not yet validated (wire contract is
  harness-tested).
