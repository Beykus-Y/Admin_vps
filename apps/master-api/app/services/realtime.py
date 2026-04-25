from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime

_subscribers: set[asyncio.Queue[str]] = set()


def subscribe() -> asyncio.Queue[str]:
    queue: asyncio.Queue[str] = asyncio.Queue(maxsize=100)
    _subscribers.add(queue)
    return queue


def unsubscribe(queue: asyncio.Queue[str]) -> None:
    _subscribers.discard(queue)


async def publish_event(event_type: str, payload: dict | None = None) -> None:
    if not _subscribers:
        return

    message = json.dumps(
        {
            "type": event_type,
            "payload": payload or {},
            "created_at": datetime.now(UTC).isoformat(),
        },
        default=str,
    )
    stale: list[asyncio.Queue[str]] = []
    for queue in list(_subscribers):
        try:
            queue.put_nowait(message)
        except asyncio.QueueFull:
            stale.append(queue)

    for queue in stale:
        _subscribers.discard(queue)
