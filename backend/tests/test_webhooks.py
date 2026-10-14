import pytest
import asyncio
from unittest.mock import AsyncMock, patch
from app.models.webhook import WebhookSubscription
from app.services.webhook_service import trigger_webhooks, _dispatch_webhooks

@pytest.mark.asyncio
async def test_webhooks_api_and_dispatch(client, db, admin_token):
    # 1. Register a webhook subscription
    create_payload = {
        "url": "http://192.168.1.50:9000/webhook-test",
        "events": ["scan.complete", "device.offline"]
    }
    response = await client.post(
        "/api/webhooks",
        json=create_payload,
        headers={"Authorization": f"Bearer {admin_token}"}
    )
    assert response.status_code == 200
    created_data = response.json()
    assert created_data["url"] == "http://192.168.1.50:9000/webhook-test"
    assert created_data["events"] == ["scan.complete", "device.offline"]

    # 2. Get list of webhooks
    response = await client.get(
        "/api/webhooks",
        headers={"Authorization": f"Bearer {admin_token}"}
    )
    assert response.status_code == 200
    subs = response.json()
    assert len(subs) == 1
    assert subs[0]["id"] == created_data["id"]

    # 3. Trigger webhook dispatch and verify HTTP post mock
    class SessionContext:
        def __init__(self, session):
            self.session = session
        async def __aenter__(self):
            return self.session
        async def __aexit__(self, exc_type, exc_val, exc_tb):
            pass

    session_ctx = SessionContext(db)
    with patch("app.services.webhook_service.async_session", return_value=session_ctx):
        with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
            # Mock successful response
            mock_response = AsyncMock()
            mock_response.status_code = 200
            mock_post.return_value = mock_response

            # Execute direct dispatch implementation so we can await it cleanly
            await _dispatch_webhooks("scan.complete", {"status": "finished"})

            # Assert post was called with correct arguments
            mock_post.assert_called_once()
            args, kwargs = mock_post.call_args
            assert args[0] == "http://192.168.1.50:9000/webhook-test"
            payload = kwargs["json"]
            assert payload["event"] == "scan.complete"
            assert payload["data"] == {"status": "finished"}

    # 4. Invalidate subscription/Delete webhook
    response = await client.delete(
        f"/api/webhooks/{created_data['id']}",
        headers={"Authorization": f"Bearer {admin_token}"}
    )
    assert response.status_code == 200


# --- SSRF protection ----------------------------------------------------------

@pytest.mark.parametrize("url", [
    "http://192.168.1.50:8123/api/webhook/abc",
    "https://hooks.example.com/notify",
    "http://n8n.lan:5678/webhook/x",
    "http://[fd12:3456::10]:8080/hook",
])
def test_webhook_url_accepts_lan_and_public_targets(url):
    from app.schemas.webhook import WebhookSubscriptionCreate
    assert WebhookSubscriptionCreate(url=url, events=["scan.complete"]).url == url


@pytest.mark.parametrize("url", [
    "file:///etc/passwd",
    "ftp://192.168.1.50/pub",
    "http://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1:8000/api/settings/reset-db",
    "http://127.8.9.10/",
    "http://localhost:8000/",
    "http://api.localhost/",
    "http://[::1]:8000/",
    "http://[::ffff:127.0.0.1]/",
    "http://0.0.0.0:8000/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://127.1/",
    "http://192.168.1.50:99999/",
    "http:///no-host",
])
def test_webhook_url_rejects_unsafe_targets(url):
    from pydantic import ValidationError
    from app.schemas.webhook import WebhookSubscriptionCreate
    with pytest.raises(ValidationError):
        WebhookSubscriptionCreate(url=url, events=["scan.complete"])


@pytest.mark.asyncio
async def test_create_webhook_rejects_metadata_address(client, admin_token):
    response = await client.post(
        "/api/webhooks",
        json={"url": "http://169.254.169.254/latest/meta-data/", "events": ["scan.complete"]},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_dispatch_refuses_stored_and_resolved_internal_targets(monkeypatch):
    """Rows stored before the URL check existed, and host names resolving to loopback, get no POST."""
    import socket
    from app.services import webhook_service

    async def resolves_to_loopback(host, port, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port))]

    monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", resolves_to_loopback)
    http = AsyncMock()

    await webhook_service._send_webhook_post(http, "http://127.0.0.1:9000/legacy-row", {"event": "x"})
    await webhook_service._send_webhook_post(http, "http://rebind.example/hook", {"event": "x"})

    http.post.assert_not_called()
