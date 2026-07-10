# Contributing to Minerva

## Setup

```sh
bun install          # Bun ≥ 1.3 (CI pins 1.3.12)
bun run verify       # typecheck + lint + all tests — the gate for everything
```

The repo is a Bun workspace; packages export TypeScript source directly (no
build step). `tsc --noEmit` typechecks, Biome lints/formats, `bun test` runs
everything, and knip guards against dead exports and unused dependencies.

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
| `scripts/*.exp` | The TUI under a genuine pseudo-terminal |

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
```

## Design context

Read [docs/DESIGN.md](docs/DESIGN.md) (architecture decisions and their
rationale) and [docs/PROTOCOL.md](docs/PROTOCOL.md) (the wire protocol) before
changing kernel or protocol behavior. The protocol version is pinned; breaking
wire changes need a version bump and a documented migration.
