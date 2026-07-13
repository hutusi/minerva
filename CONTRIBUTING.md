# Contributing to Minerva

## Setup

```sh
bun install          # Bun ≥ 1.3 (CI pins 1.3.14)
bun run verify       # typecheck + lint + all tests — the gate for everything
```

The repo is a Bun workspace; packages export TypeScript source directly (no
build step). `tsc --noEmit` typechecks, Biome lints/formats, `bun test` runs
everything, and knip guards against dead exports and unused dependencies.

Working on the GUI (`apps/gui`) additionally needs the Rust toolchain
([rustup](https://rustup.rs)) — plus webkit2gtk on Linux. The webview's
TypeScript is covered by the normal gate; the Rust side builds locally only
(`tauri dev` / `tauri build`), never in CI.

## The verify gate

`bun run verify` must be green before anything lands on `main`. CI enforces it
on every PR (ubuntu + macos), plus:

- `bun test --coverage` — per-file thresholds from `bunfig.toml` (bun applies
  them per file, not to the total). Ratchet up, never down.
- `bun run knip` — dead code / unused deps.
- `bun run smoke:tui` and `bun run e2e:tui` — the Ink UI under a real PTY
  (requires `expect`; preinstalled on macOS, `apt install expect` on Linux).

## Workflow

- **Branch for substantial work** (`<type>/<topic>`, e.g. `feat/mcp-http`,
  `chore/quality-gates`); trivial fixes may land on `main` directly with a
  green gate.
- **One commit per logical slice**, Conventional Commits. The subject says
  what changed; the body explains *why* — the problem, the decision, the
  trade-off. `git log` should make sense without opening PRs.
- **PRs merge without squashing** (merge commit) so the curated history
  survives on `main`.

## Test layout

| Location | What it covers |
|---|---|
| `packages/*/test/*.test.ts` | Unit + integration per package |
| `packages/client/test/` | Full-stack flows over the in-proc transport (resume, compact, permissions) |
| `packages/cli/test/acp.test.ts` | Real child process over stdio (ACP wire contract) |
| `packages/cli/test/app.test.tsx` | Ink UI via ink-testing-library, real kernel underneath |
| `packages/kernel/test/mcp.test.ts` | Real spawned MCP server from project settings |
| `packages/cli/test/acp.test.ts` (keyless cases) | `acp --allow-unconfigured` hosting contract |
| `apps/gui/test/` | GUI pure modules: transport framing, kernel manager (fake JSON-RPC bridge), sidecar generation gate, session install tokens + switches (incl. A-B-A reuse), stale-session self-heal against a real kernel, tabs, permission queue, config form, diff alignment, notification matrix |
| `scripts/*.exp` | The TUI under a genuine pseudo-terminal |
| `scripts/acp-smoke.ts` | Live ACP smoke: spawns `minerva acp`, drives JSON-RPC by hand |

GUI tests deliberately import only pure modules — never React components or
the one file touching `@tauri-apps/api` — so the per-file coverage threshold
stays meaningful (files loaded during a test run are measured).

Tests never touch `~/.minerva`: they pass a temp `dataDir` to the kernel (or
set `MINERVA_DATA_DIR` for spawned processes). Do the same for manual testing:

```sh
MINERVA_DATA_DIR=$(mktemp -d) bun run --cwd packages/cli dev
```

## Running things

```sh
bun run --cwd packages/cli dev        # interactive TUI (needs ANTHROPIC_API_KEY)
bun run packages/cli/src/index.tsx acp  # kernel on stdio for editors
bun run build:release                 # single-file executable (see README caveat)
bun run --cwd apps/gui dev            # Tauri GUI, kernel from source
bun run --cwd apps/gui prepare-sidecar && bun run --cwd apps/gui build  # packaged app
```

## GUI manual smoke (before landing apps/gui changes)

`tauri dev` with a temp `MINERVA_DATA_DIR` and walk:

1. First run (no keys in env, empty data dir) → config dialog appears; store
   a key → first prompt streams without a restart.
2. Prompt that writes a file → permission dialog (y/a/n hotkeys, Esc cancels
   the turn); diff preview renders; toggle unified/split.
3. Sessions → resume a TUI-created session (shared JSONL store).
4. Second tab on another repo; prompt both concurrently over one kernel.
5. `kill -9` the kernel process → banner, auto-restart, tabs restore;
   kill it again → stays down until the restart button.
6. Reload the webview (dev) → still exactly one kernel process.
7. Packaged app: run a grep-using prompt (proves the bundled rg sidecar),
   then Cmd+Q → kernel process gone.

## Design context

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (the package/process map and
the invariants index), [docs/DESIGN.md](docs/DESIGN.md) (founding decisions
D1–D15), [docs/adr/](docs/adr/) (decisions since), [CONTEXT.md](CONTEXT.md)
(the domain vocabulary — use its terms, not synonyms) and
[docs/PROTOCOL.md](docs/PROTOCOL.md) (the wire protocol) before
changing kernel or protocol behavior. The protocol version is pinned; breaking
wire changes need a version bump and a documented migration.
