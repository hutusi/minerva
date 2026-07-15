"""Convert a Minerva session JSONL event log into a Harbor ATIF trajectory.

Best-effort and defensive: every call site wraps this in try/except, so a
schema drift on either side degrades to "no trajectory written" rather than a
failed trial. The authoritative record is still Minerva's own JSONL (copied
into /logs/agent/minerva-sessions) and the tee'd stdout.
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


def _usage(event: dict[str, Any]) -> tuple[int, int]:
    usage = event.get("usage") or {}
    prompt = usage.get("inputTokens") or usage.get("input_tokens") or 0
    completion = usage.get("outputTokens") or usage.get("output_tokens") or 0
    return prompt, completion


def build_trajectory(events: list[dict[str, Any]], model_name: str) -> Trajectory | None:
    """One ATIF step per assistant.message; token totals from turn.completed."""
    steps: list[Step] = []
    step_id = 1
    total_in = 0
    total_out = 0

    for event in events:
        event_type = event.get("type")
        if event_type == "assistant.message":
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
        elif event_type == "turn.completed":
            prompt, completion = _usage(event)
            total_in += prompt
            total_out += completion

    if not steps:
        return None

    return Trajectory(
        schema_version="ATIF-v1.6",
        session_id="minerva",
        agent=Agent(name="minerva", version="unknown", model_name=model_name),
        steps=steps,
        final_metrics=FinalMetrics(
            total_prompt_tokens=total_in or None,
            total_completion_tokens=total_out or None,
            total_cost_usd=None,
            total_steps=len(steps),
        ),
    )


def write_trajectory(
    events: list[dict[str, Any]], model_name: str, logs_dir: Path
) -> None:
    trajectory = build_trajectory(events, model_name)
    if trajectory is None:
        return
    path = Path(logs_dir) / "trajectory.json"
    path.write_text(format_trajectory_json(trajectory.to_json_dict()))
