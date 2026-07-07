import httpx
from fastapi import Header, HTTPException, status

from ..common.config import get_settings


async def require_user(girder_token: str = Header(..., alias="Girder-Token")) -> dict:
    """Validate the caller's Girder token by calling Girder's /user/me."""
    settings = get_settings()
    async with httpx.AsyncClient(base_url=settings.girder_base, timeout=10) as client:
        resp = await client.get("/user/me", headers={"Girder-Token": girder_token})
    if resp.status_code != 200 or not resp.json():
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid Girder token")
    return resp.json()
