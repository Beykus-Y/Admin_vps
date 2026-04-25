from __future__ import annotations

import time
from dataclasses import dataclass

import httpx

GITHUB_REPO = "Beykus-Y/Admin_vps"
AGENT_ASSET_PREFIX = "filin-agent-linux-"
_CACHE_TTL_SECONDS = 300
_latest_release_cache: tuple["AgentRelease" | None, float] = (None, 0.0)


@dataclass(frozen=True)
class AgentRelease:
    tag_name: str
    assets: list[dict]

    @property
    def version(self) -> str:
        return self.tag_name.removeprefix("agent/v").removeprefix("agent/")


def normalize_agent_version(version: str | None) -> tuple[int, int, int] | None:
    if not version:
        return None
    cleaned = version.removeprefix("agent/").lstrip("v")
    parts = cleaned.split(".")
    values: list[int] = []
    for part in parts[:3]:
        if not part.isdigit():
            return None
        values.append(int(part))
    while len(values) < 3:
        values.append(0)
    return values[0], values[1], values[2]


def is_agent_outdated(current: str | None, latest: str | None) -> bool:
    current_version = normalize_agent_version(current)
    latest_version = normalize_agent_version(latest)
    if not current_version or not latest_version:
        return False
    return current_version < latest_version


def _has_agent_assets(release: dict) -> bool:
    if release.get("draft") or release.get("prerelease"):
        return False
    tag_name = release.get("tag_name", "")
    if not tag_name.startswith("agent/"):
        return False
    assets = release.get("assets", [])
    return any(asset.get("name", "").startswith(AGENT_ASSET_PREFIX) for asset in assets)


async def get_latest_agent_release() -> AgentRelease | None:
    global _latest_release_cache
    cached, fetched_at = _latest_release_cache
    if cached and (time.monotonic() - fetched_at) < _CACHE_TTL_SECONDS:
        return cached

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"https://api.github.com/repos/{GITHUB_REPO}/releases",
            params={"per_page": 20},
            headers={"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"},
        )
        resp.raise_for_status()
        for release in resp.json():
            if _has_agent_assets(release):
                found = AgentRelease(tag_name=release["tag_name"], assets=release.get("assets", []))
                _latest_release_cache = (found, time.monotonic())
                return found

    return cached


def _asset_url(release: AgentRelease, name: str) -> str | None:
    for asset in release.assets:
        if asset.get("name") == name:
            return asset.get("browser_download_url")
    return None


async def build_agent_update_payload(arch: str | None) -> dict:
    release = await get_latest_agent_release()
    if not release:
        raise ValueError("No agent release with Linux assets found")

    agent_arch = "arm64" if arch and "arm" in arch.lower() else "amd64"
    binary_name = f"filin-agent-linux-{agent_arch}"
    checksum_name = f"{binary_name}.sha256"
    download_url = _asset_url(release, binary_name)
    checksum_url = _asset_url(release, checksum_name)
    if not download_url:
        raise ValueError(f"No release asset '{binary_name}' found in {release.tag_name}")

    payload = {
        "download_url": download_url,
        "version": release.version,
        "arch": agent_arch,
    }
    if checksum_url:
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(checksum_url)
                resp.raise_for_status()
                payload["checksum_sha256"] = resp.text.split()[0]
        except Exception:
            pass
    return payload
