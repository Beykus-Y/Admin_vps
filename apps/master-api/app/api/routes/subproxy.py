from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Response, status
from pydantic import BaseModel, Field, RootModel

from app.api.deps import CurrentOperator, CurrentUser, DB
from app.services.audit import log_action
from app.services.sub_proxy import SubProxyClientError, request_sub_proxy

router = APIRouter(prefix="/subproxy", tags=["subproxy"])


class SubProxyConfigCreate(BaseModel):
    name: str | None = None
    uri: str
    enabled: bool = True


class SubProxyConfigOrderItem(BaseModel):
    id: int
    name: str | None = None
    uri: str | None = None
    enabled: bool = True


class SubProxyPerUserConfigItem(BaseModel):
    name: str
    uri: str
    enabled: bool = True


class SubProxyNodeFilter(BaseModel):
    all: bool = True
    allowed_configs: list[str] = Field(default_factory=list)


class SubProxyPerUserConfigMap(RootModel[dict[str, list[SubProxyPerUserConfigItem]]]):
    pass


class SubProxyNodeFilterMap(RootModel[dict[str, SubProxyNodeFilter]]):
    pass


class SubProxySettingsUpdate(BaseModel):
    sub_update_interval: int | None = None


def _raise_subproxy_error(exc: SubProxyClientError):
    raise HTTPException(status_code=exc.status_code, detail=exc.message)


@router.get("/status")
async def get_status(_: CurrentUser):
    try:
        return await request_sub_proxy("GET", "/status")
    except SubProxyClientError as exc:
        _raise_subproxy_error(exc)


@router.get("/users")
async def list_users(
    _: CurrentUser,
    limit: int = Query(default=500, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
):
    try:
        return await request_sub_proxy("GET", "/users", params={"limit": limit, "offset": offset})
    except SubProxyClientError as exc:
        _raise_subproxy_error(exc)


@router.get("/users/{username}")
async def get_user_details(username: str, _: CurrentUser):
    try:
        return await request_sub_proxy("GET", f"/users/{username}")
    except SubProxyClientError as exc:
        _raise_subproxy_error(exc)


@router.get("/configs")
async def list_configs(_: CurrentUser):
    try:
        return await request_sub_proxy("GET", "/configs")
    except SubProxyClientError as exc:
        _raise_subproxy_error(exc)


@router.post("/configs", status_code=201)
async def create_config(body: SubProxyConfigCreate, user: CurrentOperator, db: DB):
    payload = body.model_dump(exclude_none=True)
    try:
        result = await request_sub_proxy("POST", "/configs", payload=payload)
    except SubProxyClientError as exc:
        _raise_subproxy_error(exc)

    await log_action(
        db,
        user=user,
        action="subproxy.config.create",
        target_type="subproxy.config",
        target_id=body.uri,
        message=f"Sub Proxy config created: {body.name or body.uri}",
        details=payload,
    )
    await db.commit()
    return result


@router.delete("/configs/{config_id}", status_code=204)
async def delete_config(config_id: int, user: CurrentOperator, db: DB):
    try:
        await request_sub_proxy("DELETE", f"/configs/{config_id}")
    except SubProxyClientError as exc:
        _raise_subproxy_error(exc)

    await log_action(
        db,
        user=user,
        action="subproxy.config.delete",
        target_type="subproxy.config",
        target_id=str(config_id),
        message=f"Sub Proxy config deleted: {config_id}",
        details={"config_id": config_id},
    )
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/configs/reorder")
async def reorder_configs(body: list[SubProxyConfigOrderItem], user: CurrentOperator, db: DB):
    payload = [item.model_dump(exclude_none=True) for item in body]
    try:
        result = await request_sub_proxy("POST", "/configs/reorder", payload=payload)
    except SubProxyClientError as exc:
        _raise_subproxy_error(exc)

    await log_action(
        db,
        user=user,
        action="subproxy.config.reorder",
        target_type="subproxy.config",
        message="Sub Proxy configs reordered",
        details={"items": payload},
    )
    await db.commit()
    return result


@router.get("/per-user-configs")
async def get_per_user_configs(_: CurrentUser):
    try:
        return await request_sub_proxy("GET", "/per-user-configs")
    except SubProxyClientError as exc:
        _raise_subproxy_error(exc)


@router.post("/per-user-configs")
async def save_per_user_configs(body: SubProxyPerUserConfigMap, user: CurrentOperator, db: DB):
    payload = {
        username: [config.model_dump() for config in configs]
        for username, configs in body.root.items()
    }
    try:
        result = await request_sub_proxy("POST", "/per-user-configs", payload=payload)
    except SubProxyClientError as exc:
        _raise_subproxy_error(exc)

    await log_action(
        db,
        user=user,
        action="subproxy.per_user_configs.save",
        target_type="subproxy.per_user_configs",
        message="Sub Proxy per-user configs saved",
        details={"users": list(payload.keys())},
    )
    await db.commit()
    return result


@router.get("/node-filters")
async def get_node_filters(_: CurrentUser):
    try:
        return await request_sub_proxy("GET", "/node-filters")
    except SubProxyClientError as exc:
        _raise_subproxy_error(exc)


@router.post("/node-filters")
async def save_node_filters(body: SubProxyNodeFilterMap, user: CurrentOperator, db: DB):
    payload = {
        username: filter_value.model_dump()
        for username, filter_value in body.root.items()
    }
    try:
        result = await request_sub_proxy("POST", "/node-filters", payload=payload)
    except SubProxyClientError as exc:
        _raise_subproxy_error(exc)

    await log_action(
        db,
        user=user,
        action="subproxy.node_filters.save",
        target_type="subproxy.node_filters",
        message="Sub Proxy node filters saved",
        details={"users": list(payload.keys())},
    )
    await db.commit()
    return result


@router.get("/settings")
async def get_settings(_: CurrentUser):
    try:
        return await request_sub_proxy("GET", "/settings")
    except SubProxyClientError as exc:
        _raise_subproxy_error(exc)


@router.post("/settings")
async def save_settings(body: SubProxySettingsUpdate, user: CurrentOperator, db: DB):
    payload = body.model_dump()
    try:
        result = await request_sub_proxy("POST", "/settings", payload=payload)
    except SubProxyClientError as exc:
        _raise_subproxy_error(exc)

    await log_action(
        db,
        user=user,
        action="subproxy.settings.save",
        target_type="subproxy.settings",
        message="Sub Proxy settings updated",
        details=payload,
    )
    await db.commit()
    return result
