import pytest
import pytest_asyncio
from unittest.mock import AsyncMock, patch

from app.models.webhook import WebhookSubscription
from app.services.session_service import session_store


@pytest_asyncio.fixture
async def browser_session(client, db, admin_token):
    """Log the test client in like the dashboard does: only the session cookie, no header."""
    db.add(WebhookSubscription(url="http://192.168.1.50:9000/hook", events="test.event", is_active=True))
    await db.commit()
    session_id = session_store.create_session()
    client.cookies.set("gravitylan_token", session_id)
    yield session_id
    session_store.delete_session(session_id)


@pytest.mark.asyncio
async def test_get_webhook_test_rejects_session_cookie(client, browser_session):
    """A link or redirect from another site carries the Lax cookie but no header: nothing is sent."""
    with patch("app.services.webhook_service.trigger_webhooks", new_callable=AsyncMock) as mock_trigger:
        response = await client.get("/api/webhooks/test")

    assert response.status_code == 403
    assert "POST" in response.json()["detail"]
    mock_trigger.assert_not_called()


@pytest.mark.asyncio
async def test_get_webhook_test_checks_bearer_even_with_cookie(client, browser_session):
    """The valid session cookie must not stand in for a wrong token in the header."""
    with patch("app.services.webhook_service.trigger_webhooks", new_callable=AsyncMock) as mock_trigger:
        response = await client.get(
            "/api/webhooks/test", headers={"Authorization": "Bearer wrong-token"}
        )

    assert response.status_code == 401
    mock_trigger.assert_not_called()


@pytest.mark.asyncio
async def test_get_webhook_test_accepts_bearer_token(client, browser_session, admin_token):
    with patch("app.services.webhook_service.trigger_webhooks", new_callable=AsyncMock) as mock_trigger:
        response = await client.get(
            "/api/webhooks/test", headers={"Authorization": f"Bearer {admin_token}"}
        )

    assert response.status_code == 200
    mock_trigger.assert_awaited_once()
    assert mock_trigger.call_args.kwargs["event_type"] == "test.event"


@pytest.mark.asyncio
async def test_post_webhook_test_still_works_with_session_cookie(client, browser_session):
    """Browser sessions keep the POST variant (Lax does not send the cookie on cross-site POSTs)."""
    with patch("app.services.webhook_service.trigger_webhooks", new_callable=AsyncMock) as mock_trigger:
        response = await client.post("/api/webhooks/test", json={"event": "test.event"})

    assert response.status_code == 200
    mock_trigger.assert_awaited_once()
