# 0003 — Evaluate the harness via Harbor + SWE-bench, not a bespoke framework

Status: accepted · Date: 2026-07-15

## Context

We had no way to answer "is Minerva *the harness* any good end-to-end" — the
~550 unit tests drive a scripted provider (they check wiring, not outcomes), and
the live smoke tests only assert trivial strings. `docs/DESIGN.md` gestured at
"golden-transcript tests" but nothing scored real task outcomes.

The expensive parts of an eval are the task dataset and safely sandboxing an
agent that runs `rm`/arbitrary commands. Building those ourselves is a large,
never-finished commitment, and a self-authored bench is self-graded — no outside
reference point.

The goal is to read Minerva's *scaffolding* (system prompt, tool set, agent
loop, tool-feedback, compaction, permissions), not to compare models. So the
model must be a **fixed control**, held constant while the harness varies.

## Decision

- **Use [Harbor](https://www.harborframework.com)** (the Terminal-Bench team's
  Docker-container agent-eval harness) with the **SWE-bench** dataset. Harbor
  brings the dataset, per-task container sandboxing, verification
  (`FAIL_TO_PASS`/`PASS_TO_PASS` → reward), scoring, and cloud parallelism.
- **Minerva plugs in as a Harbor installed-agent** — `MinervaAgent`
  (`BaseInstalledAgent`) in `evals/harbor/minerva_harbor/agent.py`. `install()`
  fetches the pinned Minerva ref (branch/tag/SHA) + `bun install`s it into the
  task container and drops a `minerva` launcher; `run()` pipes the task
  instruction into `minerva -p --mode auto`, redirecting output to a log file it
  then emits (redirect-then-`cat`, so the exit code is captured rather than
  masked by a pipe); `populate_context_post_run()` emits a best-effort ATIF
  trajectory. It mirrors Harbor's built-in `qwen-code` / `mini-swe-agent`
  adapters (key forwarding via `ENV_VARS`/`extra_env`, `--model` passthrough).
- **Fixed control model = `bailian/glm-5.2`** (GLM 5.2 on Alibaba DashScope),
  key `DASHSCOPE_API_KEY`. The adapter ships a container-side `settings.json`
  turning GLM thinking on (the built-in bailian provider sends none by default).
  With the model constant, the resolved-instance rate reads the harness, and is
  comparable to `mini-swe-agent`/`claude-code` on the same tasks + model. The
  model is a scorecard **invariant**: `--model` may override it, but such runs
  are non-comparable experiments, not entries in the same scorecard.
- **A minimal Python island, not a package.** It lives in `evals/harbor/` with
  its own `pyproject.toml` (single dep: `harbor`) — deliberately **not** a
  `@minerva/*` Bun workspace and **not** part of `bun run verify` / `bun run
  knip`. It needs Docker + `DASHSCOPE_API_KEY`; without them it does not run.
- **A non-`end_turn` stop is tolerated** (Minerva's `-p` exits 1 on a turn-cap
  stop) so Harbor still scores the container diff; genuine API errors propagate
  so Harbor's retry classification sees them.

Rejected:

- **A bespoke in-repo eval framework** — would mean authoring/maintaining a task
  dataset and sandboxing a destructive agent (the original plan ran `rm` in a
  `/tmp` dir on the dev's machine), and it grades itself. Harbor gives real
  tasks, container isolation, and an external yardstick.
- **A `@minerva/*` workspace or a heavyweight Python package** — drags a foreign
  (Python/Docker) toolchain into the JS gates (tsc/biome/knip/bun-test), which
  don't understand it.
- **Driving Minerva over its ACP stdio host** (like `scripts/acp-smoke.ts`) or
  compiling the release binary and pushing it in — chose the source-clone
  install for the first cut (no published-binary dependency, version pinned by
  git ref); pre-baking an image is a documented later optimization.
- **An LLM-judge oracle** — SWE-bench's tests are an objective verdict;
  a judge adds noise and cost for no gain here.

## Consequences

- New toolchain surface: running evals needs Docker + `uv`, outside the Bun
  workflow. Owned as a separate island; see `evals/harbor/README.md`.
- This measures end-to-end capability, **not** Minerva's internal facets — the
  compaction trigger and permission gate aren't exercised (Harbor runs with
  permissions skipped via `--mode auto`). Those stay in-repo scripted-provider
  tests if we want them.
- It evaluates a pushed branch/tag, not the dirty working tree; push a ref (or
  bake an image) to eval local changes.
- Cost/latency scale with instances × trials, and cloning + `bun install` per
  container is slow — so this is a periodic, opt-in scorecard, not a per-commit
  gate. Attach point for a future CI job: gate it exactly like the existing
  `live-smoke` job (main-only, skip without a key), never on PRs.
- Open items to confirm on the first real run: Harbor's secret/env forwarding
  and `--model` threading for a custom installed agent, and that
  `providers.bailian.thinking` is honored under `-p`.
