# Changelog

All notable changes to Minerva are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/) once tagged.

## [Unreleased]

### Added
- CI (GitHub Actions): verify matrix on ubuntu/macos, per-file coverage
  thresholds, knip, PTY smoke + e2e for the TUI, compiled-binary smoke, and a
  secret-gated live-model smoke on main pushes; Dependabot.
- Ink UI test suite (ink-testing-library) and PTY e2e scripts in `scripts/`.
- `CONTRIBUTING.md`, `docs/PROTOCOL.md`, this changelog.

### Changed
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
