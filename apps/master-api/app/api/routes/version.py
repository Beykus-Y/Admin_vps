import time

import httpx
from fastapi import APIRouter

from app.core.config import settings

router = APIRouter(tags=["version"])

# Simple in-memory cache: (value, fetched_at)
_latest_agent_cache: tuple[str | None, float] = (None, 0.0)
_CACHE_TTL = 300  # 5 minutes

GITHUB_REPO = "Beykus-Y/Admin_vps"


async def get_latest_agent_version() -> str | None:
    global _latest_agent_cache
    cached_value, fetched_at = _latest_agent_cache

    if cached_value and (time.monotonic() - fetched_at) < _CACHE_TTL:
        return cached_value

    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(
                f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest",
                headers={"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"},
            )
            resp.raise_for_status()
            tag = resp.json().get("tag_name", "")
            # tag is "agent/v0.1.0" → strip prefix
            version = tag.removeprefix("agent/")
            _latest_agent_cache = (version, time.monotonic())
            return version
    except Exception:
        # return stale cache on error rather than None
        return cached_value


@router.get("/version")
async def get_version():
    latest_agent = await get_latest_agent_version()
    return {
        "master_version": settings.app_version,
        "latest_agent_version": latest_agent,
    }
