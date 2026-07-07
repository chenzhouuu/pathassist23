import httpx
from fastapi import Header, HTTPException, status

from ..common.config import get_settings


async def require_user(girder_token: str = Header(..., alias="Girder-Token")) -> dict:
    """Validate the caller's Girder token by calling Girder's /user/me."""
    settings = get_settings()
    try:
        async with httpx.AsyncClient(base_url=settings.girder_base, timeout=10) as client:
            resp = await client.get("/user/me", headers={"Girder-Token": girder_token})
    except httpx.HTTPError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Girder unreachable") from exc
    try:
        body = resp.json() if resp.status_code == 200 else None
    except ValueError:
        body = None
    if not body:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid Girder token")
    return body
