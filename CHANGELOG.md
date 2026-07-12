# Changelog

All notable changes to Minerva are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/) once tagged.

## [Unreleased]

### Added
- Structured diffs for file edits: `edit_file`/`write_file` results carry a
  `{ type: "diff", path, oldText, newText }` content entry (ACP semantics,
  `oldText: null` = new file, either side > 48k chars ⇒ text-only fallback)
  on `tool_call_update`, persisted in the session log so diffs survive
  replay. The CLI renders completed edits as a colored line diff (LCS,
  capped at 20 lines).
- Informed permission prompts: the CLI prompt now renders the kernel's
  option list (arrow keys + enter, y/a/n hotkeys by option kind, esc
  cancels the turn) plus a preview of what the call will do — the command
  for execute tools, a line diff for edits, all-added content for new
  files, the URL for fetches.
- Auto-compaction: providers now declare a `contextWindow` (anthropic and
  openai 200k, bailian 128k; settings-overridable per provider). When the
  previous prompt's context — the LAST model call's input tokens, which
  already include cache reads/writes — crosses 80% of it, the next prompt
  compacts first and continues from the summary, announced via a new
  `minerva/session/compacted` notification (`reason: "auto"`) that the CLI
  shows as an info line. The trigger is persisted per turn, cleared by
  compaction, and rebuilt on resume — so neither a tool loop's summed
  billing usage nor the compaction turn's own spend can mis-trigger it. A
  failed auto-compaction degrades to a warning and the prompt proceeds
  uncompacted.
- Print mode: `minerva -p "<prompt>"` runs one prompt and exits — reply on
  stdout (pipe-clean), tool progress and diagnostics on stderr, exit 0 only
  when the turn completes. `-p` without an argument reads the prompt from
  piped stdin; composes with `-c`/`-r`/`-m`/`--profile` (an explicit
  `--profile` also overrides a resumed session's persisted persona).
  `--mode <id>` sets the session mode for the run (print-mode only; the TUI
  keeps `/mode`); the run always uses an explicit mode — `default` unless
  flagged, overriding session/settings modes — and in `default` every
  permission request is auto-denied with a stderr note since there is
  nobody to ask. New client option `onSessionUpdate` taps raw updates
  before store application for streaming surfaces.
- `web_fetch` tool: bounded, permission-gated HTTP(S) GET for the model —
  manual redirects (max 5, scheme re-checked per hop), 30 s default / 120 s
  max timeout, 1 MiB body cap, 30k char output cap, HTML reduced to plain
  text. Never auto-allowed (network egress always prompts in default mode);
  permission rules match the URL, e.g. `web_fetch(https://example.com/*)` —
  which also applies to MCP tools whose inputs carry a `url`. No
  private-IP/SSRF blocking in v1 (documented posture).
- Named profiles: settings `profiles: { <name>: { systemPrompt?, model?,
  defaultMode? } }` plus a `profile` default. A profile's system prompt
  replaces the base coding-agent prompt (AGENTS.md instructions still
  append), opening the kernel to non-coding agents. Select per run with
  `--profile <name>`, switch mid-session with `/profile <name>` (applies
  from the next message; `/profile none` clears), list with `/profile`.
  New protocol surface: `minerva/profiles/list`,
  `minerva/session/set_profile`, and additive `profile` fields on
  `session/new` / `session/load`. Sessions log only the profile name and
  re-resolve it on resume, so prompt edits take effect and a deleted
  profile degrades to the base persona instead of bricking the session.
- Interactive session picker: `/sessions` (and the new `/resume` alias)
  opens an arrow-key list of recent sessions — relative age, first-prompt
  preview, `(current)` marker — and enter switches to the selected session
  in place, replaying its transcript. A new client `closeSession` detaches
  a session's store so a session can be re-entered after switching away.
- CLI input history and slash autocomplete: ↑/↓ recall prior inputs (with
  the in-progress draft stashed and restored), persisted across runs to
  `<dataDir>/history.jsonl` (last 500, file mode 0600). Typing `/prefix`
  opens a dropdown of built-in commands and skills — ↑/↓ to select, tab or
  enter to complete.
- CLI polish: an animated busy spinner with elapsed seconds replaces the
  static "working…" line; frontend failures render as red `✖` error items
  distinct from dim info notices; the usage footer becomes a status footer
  that also shows the session mode when it isn't `default`; and a terminal
  bell rings when a permission request arrives.
- CLI: assistant replies render as terminal markdown (headings, lists,
  fenced code, blockquotes, inline emphasis/links) via `marked`'s lexer and
  a hand-rolled Ink renderer. Unknown constructs (tables, HTML) fall back
  to their raw source so content is never dropped; info/user/tool output
  stays plain.
- Skills: reusable instructions as `skills/<name>/SKILL.md` directories
  (project `.minerva/` and global `~/.minerva/`, project winning name
  collisions). The model discovers them through a read-only `skill` tool
  whose description lists names+descriptions only — those ride in each
  request, while bodies are read from disk at invoke time — and model
  invocations are permission-gated and audited like any other tool. Users
  invoke one as `/name args`: the kernel expands it for the model while the
  transcript keeps the literal line (a new `providerText` field on
  `user.message` events; old logs replay unchanged), so skills behave the
  same from the CLI and ACP hosts. `/name` honors deny permission rules and
  skips ask rules (typing the command is consent); the expansion is audited
  via `providerText`. A new `minerva/skills/list` method feeds the CLI's
  slash dispatch and `/help`, which now lists skills.
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

### Security
- Project-layer `AGENTS.md` and `.minerva/skills/` files must now resolve
  inside the workspace: a repo-planted symlink can no longer pull outside
  files (`~/.ssh/...`) into the model prompt. Skills re-check confinement at
  every read, so a symlink swapped in after discovery is refused too. Global
  `~/.minerva` files stay unconfined — they are user-owned, and symlinking
  them from a dotfiles repo is legitimate.
- Instruction and skill files are read through a new bounded-read runtime
  primitive: discovery reads only an 8 KiB frontmatter prefix, bodies read at
  most 4× their character cap, and a huge or sparse file can no longer
  exhaust memory before truncation applies. Skill descriptions are capped at
  500 chars and discovery scans at most 64 entries per directory. Remote MCP
  tool output is capped at 50k chars and server-provided descriptions at 2k.

- Confined reads are now atomic with their check: the bounded read pins the
  inode it actually read (via the open fd) and the path must still resolve
  inside the workspace to that same inode, closing the residual
  check-then-open TOCTOU for project AGENTS.md/SKILL.md files. Reads also
  refuse non-regular files (a planted FIFO can no longer hang session start;
  opens are non-blocking).

### Fixed
- The SSE fallback now uses a fresh MCP client for the retry — the SDK
  fail-fasts (`AlreadyConnected`) when a client that bound a transport is
  reused, so the fallback could hit dirty state; failed clients are closed.
  A test also pins that configured headers reach the SSE probe's initial GET
  (they do — via the SDK's common-headers path), so authenticated legacy
  servers can accept the fallback.
- Truncation cuts (instruction files, skill bodies, MCP tool output) are now
  surrogate-safe: a cut can no longer split an astral character and emit a
  lone surrogate, which is invalid Unicode and can break JSON encoding to
  providers.
- Session establish runs MCP connect, AGENTS.md loading, and skill discovery
  concurrently — a slow MCP server no longer delays instruction/skill
  loading it doesn't depend on.
- A throwing host `systemPrompt` callback (or any failure between claiming
  the prompt lease and handing it to the turn loop) no longer locks the
  session permanently — all fallible pre-work now sits inside a
  release-on-throw block, and the lease is never touched again after the
  loop takes ownership.
- `/name` skill invocation now reads the registry fresh from disk every
  time, matching what `minerva/skills/list` advertises: a project override
  added after the session started shadows the cached global skill, and a
  deleted override falls back to the global one instead of erroring.
- MCP session startup is bounded: connect and tool discovery share a
  15-second per-server deadline (the SDK's 60s-per-request default put up to
  two minutes on the session-establish critical path), and a client whose
  discovery fails is closed immediately instead of lingering until teardown.
- Remote MCP tool output is accumulated incrementally up to the 50k cap
  instead of being fully joined first, so the kernel's copy of a huge
  response stays bounded (the SDK's parse of the wire response is accepted
  as-is).
- Two prompts arriving in the same tick can no longer interleave one
  session's state: the prompt lease is claimed synchronously before the
  kernel awaits anything (the skills change had opened a window between the
  guard and the claim), and `beginPrompt` now throws instead of silently
  replacing the live AbortController.
- A skill added after a session was established now expands on `/name`
  instead of passing the literal line to the model — the kernel reloads the
  registry on a miss, matching what `minerva/skills/list` advertises.
- The MCP SSE fallback only fires when the server answered Streamable HTTP
  with a 4xx (the actual "legacy server" signal); DNS failures, timeouts, and
  5xx no longer trigger a second connection attempt that doubled the
  worst-case session-start delay.
- A host-injected tool named `skill` is no longer duplicated by the generated
  one (host tools win).
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
