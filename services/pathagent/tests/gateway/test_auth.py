import httpx
import pytest
import respx
from fastapi import HTTPException


@respx.mock
async def test_require_user_ok(monkeypatch):
    from pathagent.common.config import get_settings
    from pathagent.gateway.auth import require_user

    monkeypatch.setenv("PATHAGENT_GIRDER_BASE", "https://girder.test/api/v1")
    get_settings.cache_clear()
    respx.get("https://girder.test/api/v1/user/me").mock(
        return_value=httpx.Response(200, json={"_id": "u1", "login": "doc"})
    )
    user = await require_user(girder_token="tok")
    assert user["_id"] == "u1"
    get_settings.cache_clear()


@respx.mock
async def test_require_user_rejects_bad_token(monkeypatch):
    from pathagent.common.config import get_settings
    from pathagent.gateway.auth import require_user

    monkeypatch.setenv("PATHAGENT_GIRDER_BASE", "https://girder.test/api/v1")
    get_settings.cache_clear()
    respx.get("https://girder.test/api/v1/user/me").mock(return_value=httpx.Response(401, json={}))
    with pytest.raises(HTTPException) as exc:
        await require_user(girder_token="bad")
    assert exc.value.status_code == 401
    get_settings.cache_clear()


@respx.mock
async def test_require_user_handles_girder_unreachable(monkeypatch):
    from pathagent.common.config import get_settings
    from pathagent.gateway.auth import require_user

    monkeypatch.setenv("PATHAGENT_GIRDER_BASE", "https://girder.test/api/v1")
    get_settings.cache_clear()
    respx.get("https://girder.test/api/v1/user/me").mock(side_effect=httpx.ConnectError("down"))
    with pytest.raises(HTTPException) as exc:
        await require_user(girder_token="tok")
    assert exc.value.status_code == 503
    get_settings.cache_clear()
