"""Harbor installed-agent adapter for Minerva.

Runs Minerva (this repo's model-agnostic code agent) headlessly on a Harbor
task: install() drops Minerva into the task container (Bun + source clone) and
run() drives it via `minerva -p` print mode. The model is held FIXED as a
control (default `bailian/glm-5.2`) so the resolved-instance rate on a dataset
like SWE-bench reads Minerva's *scaffolding* — prompt, tool set, agent loop,
tool-feedback, compaction — rather than raw model IQ.

Deliberately NOT a Bun workspace package: this is a self-contained Python
island (Harbor is a `uv`/pip tool), kept out of the JS gates. See
evals/harbor/README.md and docs/adr/0003-harbor-swebench-eval.md.
"""

import json
import os
import shlex
from pathlib import Path
from typing import Any, override

from harbor.agents.installed.base import (
    BaseInstalledAgent,
    EnvVar,
    with_prompt_template,
)
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

# Fixed control model. Bailian (Alibaba DashScope) serves Zhipu's GLM, so the
# provider-prefixed ref is `bailian/glm-5.2` and the key is DASHSCOPE_API_KEY.
DEFAULT_MODEL = "bailian/glm-5.2"
DEFAULT_REPO = "https://github.com/hutusi/minerva.git"
DEFAULT_REF = "main"

# Writable Minerva data/config root inside the container (never ~/.minerva; the
# repo rule keeps every run off the real user data dir).
DATA_DIR = "/tmp/minerva-data"
# Harbor mounts the host `logs_dir` at the container's agent dir; mirror the
# path convention the built-in qwen/mini-swe adapters use.
AGENT_LOG = "/logs/agent/minerva.txt"
SESSIONS_SUBDIR = "minerva-sessions"

# Container-side Minerva settings (bailian endpoint tweaks + GLM thinking-on),
# kept as an editable file so tuning needs no Python change.
_SETTINGS_PATH = Path(__file__).parent / "settings.json"


class MinervaAgent(BaseInstalledAgent):
    """Minerva as a Harbor installed agent (headless `minerva -p`)."""

    # We emit a best-effort ATIF trajectory in populate_context_post_run.
    SUPPORTS_ATIF: bool = True
    # One SWE-bench instance == one prompt; no session resume needed.
    SUPPORTS_RESUME: bool = False

    # DASHSCOPE_API_KEY (the bailian/GLM key) is forwarded from the host env or
    # `--ae DASHSCOPE_API_KEY=...` into the container and passed to `minerva`.
    ENV_VARS = [
        EnvVar(
            "dashscope_api_key",
            env="DASHSCOPE_API_KEY",
            type="str",
            env_fallback="DASHSCOPE_API_KEY",
        ),
    ]

    def __init__(
        self,
        repo: str | None = None,
        ref: str | None = None,
        minerva_mode: str | None = None,
        *args: Any,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        # `ref` must be a branch or tag (shallow clone); a bare SHA won't work.
        self._repo = repo or os.environ.get("MINERVA_REPO", DEFAULT_REPO)
        self._ref = ref or os.environ.get("MINERVA_REF", DEFAULT_REF)
        # `auto` = tools run without asking (Minerva's analog of claude-code's
        # --dangerously-skip-permissions), which SWE-bench needs.
        self._mode = minerva_mode or "auto"

    @staticmethod
    @override
    def name() -> str:
        return "minerva"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        # System deps: git + unzip (Bun's installer needs unzip) + curl/ca-certs.
        await self.exec_as_root(
            environment,
            command=(
                "if command -v apt-get >/dev/null 2>&1; then "
                "  apt-get update && apt-get install -y curl git unzip ca-certificates; "
                "elif command -v apk >/dev/null 2>&1; then "
                "  apk add --no-cache curl git unzip bash ca-certificates; "
                "elif command -v yum >/dev/null 2>&1; then "
                "  yum install -y curl git unzip ca-certificates; "
                "elif command -v dnf >/dev/null 2>&1; then "
                "  dnf install -y curl git unzip ca-certificates; "
                "else echo 'minerva-install: no known package manager' >&2; fi"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        # Bun + Minerva from source + a `minerva` launcher on PATH. The launcher
        # runs the CLI entry the same way scripts/acp-smoke.ts does:
        # `bun packages/cli/src/index.tsx <args>`.
        launcher = (
            "#!/usr/bin/env bash\n"
            'export BUN_INSTALL="$HOME/.bun"\n'
            'export PATH="$BUN_INSTALL/bin:$PATH"\n'
            'exec bun "$HOME/minerva/packages/cli/src/index.tsx" "$@"\n'
        )
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                'export BUN_INSTALL="$HOME/.bun"; '
                'export PATH="$BUN_INSTALL/bin:$HOME/.local/bin:$PATH"; '
                'if ! command -v bun >/dev/null 2>&1; then '
                "  curl -fsSL https://bun.sh/install | bash; "
                "fi; "
                'mkdir -p "$HOME/.local/bin"; '
                'rm -rf "$HOME/minerva"; '
                f"git clone --depth 1 --branch {shlex.quote(self._ref)} "
                f'{shlex.quote(self._repo)} "$HOME/minerva"; '
                'cd "$HOME/minerva" && bun install; '
                f"printf '%s' {shlex.quote(launcher)} > \"$HOME/.local/bin/minerva\"; "
                'chmod +x "$HOME/.local/bin/minerva"; '
                '"$HOME/.local/bin/minerva" --version'
            ),
        )

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        model = self.model_name or DEFAULT_MODEL
        env = {**self._resolved_env_vars, "MINERVA_DATA_DIR": DATA_DIR}

        # The built-in bailian provider sends no enable_thinking by default;
        # GLM wants it on. Ship a container-side Minerva settings.json that
        # turns thinking on for glm-5.2 (per-model map, resolveThinking).
        settings = _SETTINGS_PATH.read_text()
        await self.exec_as_agent(
            environment,
            command=(
                f"mkdir -p {shlex.quote(DATA_DIR)} && "
                f"printf '%s' {shlex.quote(settings)} "
                f"> {shlex.quote(DATA_DIR)}/settings.json"
            ),
            env=env,
        )

        # Feed the instruction on stdin (robust for large/multi-line SWE-bench
        # problem statements — `minerva -p` reads stdin when given no inline
        # prompt and stdin is not a TTY). runPrintMode exits 1 on a non-end_turn
        # stop (e.g. hitting the 40-turn cap); tolerate that so Harbor still
        # scores the container diff, but let genuine API errors (rate limit /
        # auth) propagate so Harbor's ERROR_PATTERNS classify them for retry.
        escaped = shlex.quote(instruction)
        run_cmd = (
            'export BUN_INSTALL="$HOME/.bun"; '
            'export PATH="$BUN_INSTALL/bin:$HOME/.local/bin:$PATH"; '
            "mkdir -p /logs/agent; "
            f"printf '%s' {escaped} | "
            f"minerva -p --mode {shlex.quote(self._mode)} --model {shlex.quote(model)} "
            f"> {AGENT_LOG} 2>&1; rc=$?; "
            f"cat {AGENT_LOG}; "
            f'if [ "$rc" -ne 0 ] && ! grep -qiE "turn ended early" {AGENT_LOG}; '
            'then exit "$rc"; fi; '
            "exit 0"
        )
        await self.exec_as_agent(environment, command=run_cmd, env=env)

        # Copy Minerva's append-only session log(s) out for the trajectory
        # parser. Best-effort: never fail the trial on a missing log.
        await self.exec_as_agent(
            environment,
            command=(
                f"mkdir -p /logs/agent/{SESSIONS_SUBDIR}; "
                f"find {shlex.quote(DATA_DIR)} -name '*.jsonl' "
                f"-exec cp {{}} /logs/agent/{SESSIONS_SUBDIR}/ \\; 2>/dev/null || true"
            ),
            env=env,
        )

    def _read_session_events(self) -> list[dict[str, Any]]:
        """Newest copied Minerva session JSONL → list of parsed events."""
        sessions_dir = self.logs_dir / SESSIONS_SUBDIR
        if not sessions_dir.is_dir():
            return []
        jsonl = list(sessions_dir.rglob("*.jsonl"))
        if not jsonl:
            return []
        newest = max(jsonl, key=lambda p: p.stat().st_mtime)
        events: list[dict[str, Any]] = []
        for line in newest.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return events

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        events = self._read_session_events()
        if not events:
            return

        # Token accounting from turn.completed usage (whole-prompt billing).
        n_in = 0
        n_out = 0
        for event in events:
            if event.get("type") != "turn.completed":
                continue
            usage = event.get("usage") or {}
            n_in += usage.get("inputTokens") or usage.get("input_tokens") or 0
            n_out += usage.get("outputTokens") or usage.get("output_tokens") or 0
        context.n_input_tokens = n_in
        context.n_output_tokens = n_out

        # Best-effort ATIF trajectory for Harbor's logs; a schema mismatch must
        # not fail the trial.
        try:
            from minerva_harbor.trajectory import write_trajectory

            write_trajectory(events, self.model_name or DEFAULT_MODEL, self.logs_dir)
        except Exception:
            self.logger.debug("minerva: failed to build ATIF trajectory")
