# Minerva — Design Record

Minerva is a cross-platform, model-agnostic code agent: a headless kernel with
multiple frontends (CLI now, GUI later). It is a daily-driver tool first and the
foundation for an enterprise product later. This document records the v0.1
design decisions and the reasoning behind them.

The central constraint that shaped the architecture: **Tauri 2's backend is
Rust, so a TypeScript kernel can never run in-process in the GUI** — the kernel
must be protocol-fronted and out-of-process from day one.

## Decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Purpose | Daily-driver now, enterprise foundation later — lean on proven libraries; protocol stability matters |
| 2 | Process model | **Protocol everywhere, transport varies**: kernel = library + host; CLI uses an in-process transport, Tauri spawns the kernel as a stdio sidecar, `minerva serve` (WebSocket) later for remote/enterprise. Every frontend speaks the protocol — no privileged in-process API |
| 3 | Protocol | **ACP (Agent Client Protocol) core + `minerva/*` extensions**. ACP verbatim for sessions / prompts / streaming updates / permission requests; namespaced extension methods for session browsing, usage/cost telemetry, config. Zed/Neovim become free frontends and conformance testers |
| 4 | Model layer | **Vercel AI SDK (v7 as of 0.2.x)** behind a kernel-owned `ModelProvider` interface (only the adapter package imports `ai`). Anthropic first, then OpenAI; Bailian and Ollama landed as OpenAI-compatible entries; Bedrock/Vertex/Azure are cheap adds later |
| 5 | Permissions | **Kernel-enforced rule engine + session modes** (plan / default / accept-edits / auto). Allow/deny/ask patterns like `Bash(git *)`, `Edit(src/**)`. Unmatched → ACP permission request to the frontend. Every decision appended to the audit log. "Always allow" persists as a rule |
| 6 | Tools | Built-ins: ReadFile, WriteFile, EditFile (string-replace), Glob, Grep, Bash (`spawn` pipes — **no PTY in v1**), Todo, WebFetch (bounded HTTP GET; never auto-allowed — network egress always prompts/matches rules against the URL; private/loopback hosts refused by default — checked post-DNS-resolution and on every redirect hop, `webFetch.allowPrivate` settings escape hatch, DNS-rebinding race between check and connect accepted — same "friction, not a cage" posture as bash rules). Plus **MCP client in v1** (stdio and Streamable HTTP with SSE fallback); MCP tools flow through the same permission engine |
| 7 | Sessions | **Append-only JSONL event logs** per session under `~/.minerva/projects/<project-slug>/`; the event stream is the source of truth (replay → model context or UI view). Index file for fast session lists. Resume = replay. Manual `/compact` plus **auto-compaction**: when the provider declares a `contextWindow` (built-in defaults, settings-overridable), a prompt whose predecessor crossed 80% of it compacts first (announced via `minerva/session/compacted`). The trigger is the LAST model call's input tokens (which already include cache reads/writes), persisted per turn and cleared by compaction — a tool loop's summed billing usage would trigger at a fraction of the threshold, and a running total would re-trigger on every prompt after (the compaction turn's own input ≈ the over-threshold context) |
| 8 | Frontends | **CLI first** (Ink). `@minerva/client` shared package: protocol client + session state reducer (events in → renderable view-model out, zero UI imports). Tauri 2 GUI is M2, reusing `@minerva/client`; webview = React + Vite |
| 9 | Runtime & dist | **Bun-first, Node-tolerant**: Bun is the blessed runtime; kernel core accesses spawn/fs through a thin runtime-adapter seam so a Node build stays cheap. CLI ships as `bun build --compile` single binaries; Tauri bundles the same binary as sidecar |
| 10 | v0.1 scope | **Full CLI feature set as the single public milestone.** No intermediate releases; integration risk managed via internal vertical slices |
| 11 | License | **v0.2.0: repo stays private, no LICENSE — license deferred.** Apache-2.0 + CLA remains the default candidate if/when opened |
| 12 | Project instructions | **AGENTS.md open standard**: `<dataDir>/AGENTS.md` (global) + project-root `AGENTS.md` only — nested per-directory files deferred (re-affirmed 2026-07: a full-tree walk is unbounded prompt cost; lazy per-touched-dir loading would vary the system prompt mid-session in a way the event log doesn't record, breaking replay fidelity; and each project file needs its own symlink-confinement pass — a design slice, not an increment). Appended to the base system prompt (host override stays the base), loaded at session establish, never persisted (the system prompt isn't in the event log). Repo-controlled text entering the prompt matches the existing trust posture — project settings already inject allow rules |
| 13 | Skills | **`skills/<name>/SKILL.md` dirs** (global under dataDir, project under `.minerva/`; project wins collisions like `mcpServers`). Frontmatter is `key: value` lines only — hand-rolled parser, no YAML dep. Model-invoked via one **`skill` tool** (progressive disclosure: names+descriptions in the tool description, body read at invoke; read-only but deniable, audited like any tool). User-invoked `/name` expands **kernel-side** (transcript keeps the literal text, the provider sees the body) so skills work identically from ACP hosts; the CLI's built-in slash commands stay client-side and win name collisions. `/name` honors deny rules, skips ask (typing it is consent), audited via `providerText`. Project-layer files (AGENTS.md and skills) are symlink-confined to the workspace with an invoke-time recheck; global files are user-owned and unconfined |
| 14 | Profiles | **Named personas in settings**: `profiles: { <name>: { systemPrompt?, model?, defaultMode? } }` + a `profile` default scalar; per-name merge project-over-global like `providers`. A profile's `systemPrompt` **replaces** the base coding-agent prompt (AGENTS.md still appends), so the kernel serves non-coding agents without forking hosts. Sessions record only the profile NAME (`session.created` / `session.profile_changed` events); load re-resolves it against current settings — prompt edits apply on resume, a vanished profile degrades to the base persona. Mid-session switching is free because the system prompt is rebuilt per prompt. Surface: `--profile`, `/profile`, `minerva/profiles/list`, `minerva/session/set_profile` |

Explicitly **not** in v1: subagents, PTY shells, OS sandboxing,
WS/remote transport (designed-for, not built), web frontend.

## Repository layout (Bun workspaces)

```
minerva/
  packages/
    protocol/    # ACP types + minerva/* extensions, JSON-RPC framing,
                 # Transport interface + in-proc & stdio implementations
    kernel/      # agent loop, session engine (JSONL event log), tool registry,
                 # built-in tools, MCP client (stdio + Streamable HTTP),
                 # permission engine + modes, audit log,
                 # runtime-adapter seam (spawn/fs)
    providers/   # ModelProvider interface + AI SDK adapter (sole importer of `ai`)
    client/      # frontend-agnostic protocol client + session view-model reducer
    cli/         # Ink app: REPL, streaming render, approval prompts, slash commands
  apps/
    gui/         # Tauri 2 + React + Vite (M2)
```

Config: `~/.minerva/settings.json` (global) + `.minerva/settings.json`
(project) — provider/model selection (`model`, `providers`; API keys
global-only, file written `0600`), permission rules, MCP server definitions.
The config extension method is `minerva/config/set_model` (persist + live
provider swap); provider construction is host-injected via
`KernelOptions.resolveProvider` so the kernel never imports the AI SDK.

## v0.1 internal slices (checkpoints, not releases)

1. ✅ **Hello loop** — kernel library + in-proc transport + minimal Ink REPL;
   Anthropic via AI SDK; Read/Edit/Bash; ask-every-time approvals; JSONL event
   logging on from the first turn. Proves every architectural seam end-to-end.
2. ✅ **Permissions & persistence** — rule engine + modes; "always allow"
   persistence; session resume (replay); remaining built-ins; audit log.
3. ✅ **Protocol hardening** — stdio transport (ACP newline-delimited JSON) +
   `minerva acp` host command; wire contract covered by a spawned-process
   conformance harness; second provider (OpenAI) via provider/model refs;
   `minerva/*` extension methods (sessions/list, session/compact).
4. ✅ **Ecosystem & polish** — MCP client (stdio servers from settings, tools
   permission-gated as `mcp__server__tool`); manual `/compact`; slash-command
   palette; `build:release` script (see watchlist for the macOS signing issue).

**v0.1 exit criteria:** daily-drivable CLI for real work *(pending live-model
smoke — needs an API key)*; Zed connects over ACP and completes a session
*(harness-verified; live Zed pending)*; two providers switchable mid-project ✅;
`kill -9` the CLI → resume restores the session ✅ (tested, including torn log
lines); every side effect traceable in the audit log ✅.

**M2 (post-v0.1):** Tauri 2 GUI — kernel as bundled sidecar, React UI consuming
`@minerva/client` view-models; session browser reads the JSONL index.

## Development workflow

All of v0.1 is developed on a single branch (`feat/v0.1`); `main` stays
untouched until v0.1 lands via one final, non-squashed PR.

- One Conventional Commit per logical unit, each with a why-body. The branch's
  `git log` is the development narrative.
- Review happens at slice boundaries (code review on the working tree when each
  slice completes), not only at the final PR.
- Verify gate — `bun run verify` (typecheck + lint + tests) — must be green at
  every slice boundary.

## Risks / watchlist

- **Ink on Bun** (yoga-wasm, raw-mode quirks): the Node-tolerant seam is the
  fallback — develop the CLI under Node if Bun misbehaves, compile with Bun for
  release.
- **ACP spec churn** (young standard): pin the protocol version; keep the ACP
  mapping inside `packages/protocol` only.
- **No PTY** limits interactive commands (`vim`, watch modes): documented; PTY
  is a v2 item.
- **Provider-specific features** (prompt caching, thinking budgets): the AI SDK
  adapter must pass `providerOptions` through — this is why `ModelProvider` is
  kernel-owned.
- **Windows**: compiled-binary paths, shell differences — test in slice 4, not
  after.
- **macOS arm64 compiled binaries**: Bun 1.3.12's `--compile` output is
  unsigned on this setup; the kernel SIGKILLs unsigned arm64 binaries and
  `codesign` rejects the file format for re-signing. Revisit on a newer Bun
  before cutting release artifacts.

## Verification strategy

- **Kernel**: unit tests with mock model providers; golden-transcript tests —
  replay recorded JSONL event logs and assert reconstructed state.
- **Protocol**: ACP conformance via a scripted stdio harness, plus a live Zed
  connection as the external check.
- **End-to-end**: scripted CLI session against a real provider on a sample repo
  (edit → test → commit flow); resume-after-kill test; permission-rule matrix
  test (allow/deny/ask × modes).
