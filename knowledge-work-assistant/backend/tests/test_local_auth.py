from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from app.routers.auth import issue_ws_token, verify_ws_token
from app.routers.plugin import issue_plugin_pairing_code


def test_ws_token_is_bound_to_session() -> None:
    token = issue_ws_token("session-123456789")

    assert verify_ws_token(token, "session-123456789") is True
    assert verify_ws_token(token, "session-other-123") is False


@pytest.mark.asyncio
async def test_local_api_rejects_missing_token(app) -> None:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/health")

    assert response.status_code == 401


@pytest.mark.asyncio
async def test_plugin_pairing_issues_usable_credential(app) -> None:
    code = issue_plugin_pairing_code()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        paired = await client.post("/api/plugin/pair", json={"code": code})
        credential = paired.json()["credential"]
        health = await client.get(
            "/api/plugin/health",
            headers={"X-Plugin-Credential": credential},
        )

    assert paired.status_code == 200
    assert health.status_code == 200
