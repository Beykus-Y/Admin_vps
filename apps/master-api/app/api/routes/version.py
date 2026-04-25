from fastapi import APIRouter

from app.core.config import settings
from app.services.agent_releases import get_latest_agent_release

router = APIRouter(tags=["version"])

async def get_latest_agent_version() -> str | None:
    try:
        release = await get_latest_agent_release()
        return release.version if release else None
    except Exception:
        return None


@router.get("/version")
async def get_version():
    latest_agent = await get_latest_agent_version()
    return {
        "master_version": settings.app_version,
        "latest_agent_version": latest_agent,
    }
