# Changelog

All notable changes to Minerva are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/) once tagged.

## [Unreleased]

### Added
- Alibaba Bailian (DashScope) provider preset (`bailian/qwen-plus`,
  `DASHSCOPE_API_KEY`) and settings-defined custom OpenAI-compatible
  providers (any name + `baseUrl`), via `@ai-sdk/openai-compatible`.
- Known-models lists on providers (`models` in the registry and settings):
  the bailian preset ships qwen-plus/-max/-turbo and GLM-5.2, cyclable with
  ↑/↓ at the `/config` panel's model step; free-text ids still work.
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
