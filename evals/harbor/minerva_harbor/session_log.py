"""Pure helpers for reading a Minerva session JSONL log (no Harbor deps).

Shared by agent.py and trajectory.py. Kept Harbor-free so it can be imported
without pulling in harbor.models.
"""

import json
from pathlib import Path
from typing import Any

# Root-log events that carry token usage. Summing all three reproduces the
# kernel's own replay total (replay.ts): task.completed folds in every
# subagent's whole-subtree spend, and session.compacted carries the
# summarization turn — so the root log alone is complete and child logs are
# never read (avoids double-counting).
USAGE_EVENT_TYPES = ("turn.completed", "task.completed", "session.compacted")


def parse_jsonl(path: Path) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def read_root_events(sessions_dir: Path) -> list[dict[str, Any]]:
    """Events of the ROOT session log under ``sessions_dir``.

    Subagent (task tool) logs are sibling ``ses_*.jsonl`` files in the same
    directory; the root is the one whose first ``session.created`` event has no
    ``parent`` field (a child's carries the parent session id). Copy-time mtimes
    are meaningless, so selection is by content, not timestamp. Falls back to the
    first log if none is identifiable.
    """
    if not sessions_dir.is_dir():
        return []
    logs = sorted(sessions_dir.rglob("ses_*.jsonl"))  # skips index.jsonl
    if not logs:
        return []
    parsed = [parse_jsonl(p) for p in logs]
    for events in parsed:
        created = next((e for e in events if e.get("type") == "session.created"), None)
        if created is not None and created.get("parent") is None:
            return events
    return parsed[0]


def sum_usage(events: list[dict[str, Any]]) -> dict[str, int]:
    """Sum token usage across the root log's usage-bearing events."""
    totals = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0}
    for event in events:
        if event.get("type") not in USAGE_EVENT_TYPES:
            continue
        usage = event.get("usage") or {}
        totals["input"] += usage.get("inputTokens") or 0
        totals["output"] += usage.get("outputTokens") or 0
        totals["cache_read"] += usage.get("cacheReadTokens") or 0
        totals["cache_write"] += usage.get("cacheWriteTokens") or 0
    return totals
