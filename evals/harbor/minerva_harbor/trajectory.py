"""Convert a Minerva session JSONL event log into a Harbor ATIF trajectory.

Best-effort and defensive: the call site wraps this in try/except, so a schema
drift on either side degrades to "no trajectory written" rather than a failed
trial. The authoritative record is still Minerva's own JSONL (copied into
/logs/agent/minerva-sessions) and the tee'd stdout.
"""

from pathlib import Path
from typing import Any

from harbor.models.trajectories import (
    Agent,
    FinalMetrics,
    Step,
    Trajectory,
)
from harbor.utils.trajectory_utils import format_trajectory_json

from minerva_harbor.session_log import sum_usage


def build_trajectory(
    events: list[dict[str, Any]], model_name: str, version: str | None
) -> Trajectory | None:
    """One ATIF step per assistant.message; token totals from the root log's
    turn.completed + task.completed + session.compacted usage (see session_log).
    """
    steps: list[Step] = []
    step_id = 1
    for event in events:
        if event.get("type") != "assistant.message":
            continue
        steps.append(
            Step(
                step_id=step_id,
                timestamp=event.get("at"),
                source="agent",
                message=event.get("text") or "(tool use)",
                model_name=model_name,
            )
        )
        step_id += 1

    if not steps:
        return None

    totals = sum_usage(events)
    return Trajectory(
        schema_version="ATIF-v1.6",
        session_id="minerva",
        agent=Agent(name="minerva", version=version or "unknown", model_name=model_name),
        steps=steps,
        final_metrics=FinalMetrics(
            total_prompt_tokens=totals["input"] or None,
            total_completion_tokens=totals["output"] or None,
            total_cached_tokens=totals["cache_read"] or None,
            total_cost_usd=None,
            total_steps=len(steps),
        ),
    )


def write_trajectory(
    events: list[dict[str, Any]],
    model_name: str,
    version: str | None,
    logs_dir: Path,
) -> None:
    trajectory = build_trajectory(events, model_name, version)
    if trajectory is None:
        return
    path = Path(logs_dir) / "trajectory.json"
    path.write_text(format_trajectory_json(trajectory.to_json_dict()), encoding="utf-8")
