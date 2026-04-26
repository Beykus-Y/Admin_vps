from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.api.deps import CurrentAdmin, DB
from app.services.app_settings import get_sub_proxy_settings_payload, save_sub_proxy_settings
from app.services.audit import log_action
from app.services.sub_proxy import SubProxyClientError, request_sub_proxy

router = APIRouter(prefix="/settings", tags=["settings"])


class SubProxyConnectionSettingsUpdate(BaseModel):
    base_url: str = ""
    hmac_secret: str | None = None
    clear_hmac_secret: bool = False
    timeout_seconds: int = Field(default=10, ge=1, le=120)


def _raise_subproxy_error(exc: SubProxyClientError):
    raise HTTPException(status_code=exc.status_code, detail=exc.message)


@router.get("/sub-proxy")
async def get_sub_proxy_settings(_: CurrentAdmin, db: DB):
    return await get_sub_proxy_settings_payload(db)


@router.put("/sub-proxy")
async def update_sub_proxy_settings(body: SubProxyConnectionSettingsUpdate, user: CurrentAdmin, db: DB):
    payload = body.model_dump()
    result = await save_sub_proxy_settings(db, payload)
    await log_action(
        db,
        user=user,
        action="settings.sub_proxy.save",
        target_type="settings",
        target_id="sub_proxy",
        message="Sub Proxy connection settings updated",
        details={
            "base_url": result["base_url"],
            "timeout_seconds": result["timeout_seconds"],
            "hmac_secret_set": result["hmac_secret_set"],
        },
    )
    await db.commit()
    return result


@router.post("/sub-proxy/test")
async def test_sub_proxy_settings(_: CurrentAdmin, db: DB):
    try:
        status = await request_sub_proxy("GET", "/status", db=db)
    except SubProxyClientError as exc:
        _raise_subproxy_error(exc)
    return {"ok": True, "status": status}
