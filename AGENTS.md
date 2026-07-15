# Working on Minerva (agent instructions)

Single source of instructions for any coding agent (and for Minerva itself
when self-hosted here). Humans: see [CONTRIBUTING.md](CONTRIBUTING.md).

## Gates — green before anything lands

```sh
bun run verify   # tsc (root + apps/gui) + biome + all tests
bun run knip     # dead exports / unused deps — unexport internals instead of ignoring
```

Touching `apps/gui/src-tauri/`? Also: `cargo fmt` and
`cargo clippy --all-targets` (warnings are failures) in that directory, and
re-run the lifecycle drills (kill -9 → one auto-respawn; packaged quit →
"kernel exited gracefully" log; see CONTRIBUTING's GUI smoke list).

Agent evals (`evals/harbor/`, Harbor + SWE-bench) are a separate Python island —
**not** part of `bun run verify` or `bun run knip`. They need Docker + a
`DASHSCOPE_API_KEY` and run on demand (`cd evals/harbor && uv run harbor run …`);
see [CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/adr/0003-harbor-swebench-eval.md](docs/adr/0003-harbor-swebench-eval.md).

## Conventions

- Conventional Commits, one commit per logical slice, body explains WHY.
- Branch `<type>/<topic>` for substantial work; PRs merge WITHOUT squashing;
  branches are kept after merge.
- Tests never touch `~/.minerva` — pass a temp `dataDir` or
  `MINERVA_DATA_DIR`. GUI tests import pure modules only (never React
  components or the one file importing @tauri-apps/api) — per-file coverage
  is enforced on every file a test run loads.
- Use the vocabulary in [CONTEXT.md](CONTEXT.md) — especially do not blur
  generation / install token / switch target, or drain / grace.

## Invariant hot-spots — read before touching

- `apps/gui/src-tauri/src/sidecar.rs`: read the module header and the
  `SidecarState` two-lock audit before changing start/kill/send/reader.
- `apps/gui/src/lib/{kernel-manager,session-slots,session-switches,sidecar-generation}.ts`:
  lifecycle and install-token policy; each file's header states its
  invariant.
- The full index: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) § Invariants.
  If you change an invariant, update the code comment AND the index entry
  in the same commit.

## Boundaries that must hold

- `packages/protocol` stays zero-dep and webview-loadable (no `node:*`).
- `packages/client` keeps its runtime deps to protocol only.
- `packages/providers` (the AI SDK) must never enter a webview bundle.
- Shared policy has exactly one home (e.g. `providerKeyStatuses`,
  `splitModelRef`) — never copy it into a second package.

## The docs rule — docs update WITH the change, same branch

| Your change touches… | Update |
|---|---|
| Wire surface / protocol behavior (`packages/protocol`, kernel handlers) | [docs/PROTOCOL.md](docs/PROTOCOL.md) |
| A package boundary, lifecycle policy, or any decision with rejected alternatives | new [docs/adr/](docs/adr/) entry; [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) if the map changed |
| An invariant (locking, tokens, shutdown, caps) | the code comment AND the ARCHITECTURE.md index entry |
| Domain vocabulary (new term, shifted meaning) | [CONTEXT.md](CONTEXT.md) |
| User-facing behavior (commands, flags, config, GUI features) | [README.md](README.md); CHANGELOG.md at release time |
| Gates, workflow, test layout | [CONTRIBUTING.md](CONTRIBUTING.md) + this file if agent-relevant |

Every PR states its docs impact (the PR template asks); "none" needs a
reason. A behavior change whose PR touches no doc is incomplete.
