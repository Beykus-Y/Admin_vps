from fastapi import APIRouter, Response

from app.api.deps import CurrentUser, DB
from app.services.inventory import load_inventory_snapshot

router = APIRouter(prefix="/inventory", tags=["inventory"])


@router.get("")
async def get_inventory(_: CurrentUser, db: DB, response: Response):
    response.headers["Cache-Control"] = "max-age=5"
    return await load_inventory_snapshot(db)
