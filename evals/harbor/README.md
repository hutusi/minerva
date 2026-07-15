# Minerva agent evals (Harbor + SWE-bench)

Evaluate **Minerva the harness** — its system prompt, tool set, agent loop,
tool-feedback, compaction, permissions — end-to-end, by running the real agent
on real tasks and checking whether it actually resolved them.

We don't build a bench of our own. [Harbor](https://www.harborframework.com)
(the Docker-container agent-eval harness from the Terminal-Bench team) brings
the dataset, container sandboxing, verification, scoring, and parallelism.
Minerva plugs in as a Harbor **installed agent** (`minerva_harbor.agent:MinervaAgent`).

The model is held **fixed as a control** (default `bailian/glm-5.2` — GLM 5.2 on
Alibaba DashScope). With the model constant, the resolved-instance rate reads
Minerva's *scaffolding*, not model IQ — and is directly comparable to
`mini-swe-agent` / `claude-code` run on the same tasks with the same model.

> This is a self-contained Python island. It is **not** a Bun workspace package
> and is **not** part of `bun run verify` / `bun run knip`. It needs Docker and
> a `DASHSCOPE_API_KEY`; without them it simply doesn't run.

## Prerequisites

- Docker (Harbor spins up one container per task attempt)
- Python **3.12** — pinned via `.python-version`, which `uv` fetches
  automatically (Harbor 0.18 requires ≥3.12; newer Pythons like 3.14 lack
  prebuilt wheels for a native Harbor dep and fail to build)
- [`uv`](https://docs.astral.sh/uv/)
- `DASHSCOPE_API_KEY` for `bailian/glm-5.2`

## Install

```sh
cd evals/harbor
uv sync                     # installs harbor + this adapter (editable)
uv sync --extra daytona     # + the Daytona cloud backend (or --extra modal)
```

`uv.lock` is committed (harbor pinned + all transitive deps locked) so reruns
resolve identically; regenerate it with `uv lock` after bumping the dep.

## Run

Smoke first — a single instance, locally (`--n-tasks 1` caps it to one):

```sh
DASHSCOPE_API_KEY=... \
uv run harbor run \
  -d swe-bench/swe-bench-verified \
  --agent minerva_harbor.agent:MinervaAgent \
  --model bailian/glm-5.2 \
  --n-tasks 1
```

`--model` is passed straight through to `minerva -p --model …`; the adapter
forwards `DASHSCOPE_API_KEY` into the container from your shell env. Prefer
exporting the key (or the per-command prefix above) over Harbor's
`--ae DASHSCOPE_API_KEY=…`, which lands the secret in the process argv (visible
to `ps`) — reserve `--ae` for throwaway/CI shells.

Scale up only after the smoke is green (each step is a real cost decision —
GLM tokens × instances × trials): raise `--n-tasks` (a ~10–20 slice, or
`swe-bench/swe-smith`, 100, as a smaller/cheaper set) → full
`swe-bench/swe-bench-verified` (500). Concurrency is `--n-concurrent N` (`-n`).
For cloud parallelism, install the extra (above) and pass `--env daytona`. See
`uv run harbor run --help` for instance/task filters and retry policy.

### Knobs

| Setting | How | Default |
|---|---|---|
| Control model | `--model <provider/model>` | `bailian/glm-5.2` (scorecard default; see below) |
| Minerva source repo | `MINERVA_REPO` env or `repo=` agent kwarg | `github.com/hutusi/minerva` |
| Minerva ref (branch/tag/SHA) | `MINERVA_REF` env or `ref=` agent kwarg | `main` |
| Session mode | `minerva_mode=` agent kwarg | `auto` |
| GLM thinking / bailian endpoint | edit `minerva_harbor/settings.json` | thinking on for `glm-5.2` |

`MINERVA_REF` accepts a branch, tag, **or commit SHA** (the adapter fetches the
ref shallowly) — so the SHA the trajectory records can be passed back to
reproduce that exact run.

The control model is a scorecard **invariant**: leave it at `bailian/glm-5.2`
for comparable numbers. `--model` overrides are supported but produce a
different, non-comparable run (e.g. to A/B a model against another harness on
the same tasks), not an entry in the same scorecard.

## How a trial runs

1. **install()** — installs Bun + system deps, clones Minerva at `MINERVA_REF`,
   `bun install`, and drops a `minerva` launcher on PATH (runs the CLI entry
   the way `scripts/acp-smoke.ts` does).
2. **run()** — writes `settings.json` (GLM thinking on), then pipes the task
   instruction into `minerva -p --mode auto --model bailian/glm-5.2` (stdin, so
   large SWE-bench statements aren't argv-limited). A non-`end_turn` stop (turn
   cap) is tolerated so Harbor still scores the container diff; genuine API
   errors propagate for retry classification.
3. **scoring** — Harbor runs the SWE-bench `FAIL_TO_PASS` / `PASS_TO_PASS`
   tests against the container diff → reward at `/logs/verifier/reward.txt`.
4. **populate_context_post_run()** — copies Minerva's `ses_*.jsonl` out, picks
   the root session (subagent logs are siblings), and emits a best-effort ATIF
   `trajectory.json` + token totals summed over the root log's turn / task /
   compaction usage (logging only; not used for scoring).

## Open items / caveats

- **Key forwarding** and **`--model` threading** follow Harbor's built-in
  `qwen-code` / `mini-swe-agent` installed agents; confirm on the first real run.
- **Install cost**: cloning + `bun install` per container is slow. Once stable,
  pre-bake Minerva into a base image (`Dockerfile.minerva` is a starting point)
  to skip per-container install.
- **Uncommitted code**: the adapter evaluates a pushed branch/tag, not your
  dirty working tree. Push a ref (or bake an image) to eval local changes.
- This measures end-to-end capability, not Minerva's internal facets (the
  compaction trigger, the permission gate) — Harbor runs with permissions
  skipped (`--mode auto`). Those belong in in-repo scripted-provider tests.

See `docs/adr/0003-harbor-swebench-eval.md` for the decision and rejected
alternatives.
