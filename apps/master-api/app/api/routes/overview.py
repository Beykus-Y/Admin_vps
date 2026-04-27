from fastapi import APIRouter, Response

from app.api.deps import DB, CurrentUser
from app.services.inventory import load_inventory_snapshot

router = APIRouter(prefix="/overview", tags=["overview"])


@router.get("")
async def get_overview(_: CurrentUser, db: DB, response: Response):
    response.headers["Cache-Control"] = "max-age=5"
    snapshot = await load_inventory_snapshot(db, limit_events=20)
    summary = snapshot["summary"]
    return {
        "nodes": summary["nodes"],
        "containers": summary["containers"],
        "ports": {
            "total": summary["ports"]["total"],
            "unexpected": summary["ports"]["unexpected"],
        },
        "recent_events": snapshot["recent_events"],
    }
