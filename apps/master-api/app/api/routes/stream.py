import asyncio

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from app.api.deps import get_user_by_access_token
from app.core.config import settings
from app.db.base import AsyncSessionLocal
from app.services.realtime import subscribe, unsubscribe

router = APIRouter(prefix="/stream", tags=["stream"])


@router.get("")
async def stream(token: str):
    async with AsyncSessionLocal() as db:
        user = await get_user_by_access_token(token, db)
        if not user:
            raise HTTPException(status_code=401, detail="Invalid token")

    queue = subscribe()

    async def event_source():
        yield 'event: ready\ndata: {"status":"ok"}\n\n'
        try:
            while True:
                try:
                    message = await asyncio.wait_for(queue.get(), timeout=settings.sse_ping_seconds)
                    yield f"data: {message}\n\n"
                except TimeoutError:
                    yield "event: ping\ndata: {}\n\n"
        finally:
            unsubscribe(queue)

    return StreamingResponse(
        event_source(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
