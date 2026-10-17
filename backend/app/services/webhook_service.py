"""Webhook Dispatcher Service for GravityLAN events."""

import asyncio
import ipaddress
import logging
import socket
import httpx
from datetime import datetime, timezone
from urllib.parse import urlparse
from sqlalchemy import select
from app.database import async_session
from app.models.webhook import WebhookSubscription
from app.schemas.webhook import check_webhook_url, is_blocked_webhook_ip

logger = logging.getLogger(__name__)

_background_webhook_tasks: set[asyncio.Task] = set()


async def trigger_webhooks(event_type: str, data: dict):
    """Trigger registered webhooks for a specific event type in the background."""
    task = asyncio.create_task(_dispatch_webhooks(event_type, data))
    _background_webhook_tasks.add(task)
    task.add_done_callback(_background_webhook_tasks.discard)

async def _dispatch_webhooks(event_type: str, data: dict):
    """Asynchronously dispatches webhook events to all registered subscribers."""
    try:
        async with async_session() as db:
            result = await db.execute(
                select(WebhookSubscription).where(WebhookSubscription.is_active == True)
            )
            subscriptions = result.scalars().all()
    except Exception as e:
        logger.error(f"Webhook: Failed to query subscriptions from database: {e}")
        return

    # Filter subscriptions that match the event_type
    target_subs = []
    for sub in subscriptions:
        sub_events = [e.strip() for e in sub.events.split(",") if e.strip()]
        if event_type in sub_events:
            target_subs.append(sub)

    if not target_subs:
        return

    payload = {
        "event": event_type,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "data": data
    }

    async with httpx.AsyncClient(timeout=5.0) as client:
        tasks = []
        for sub in target_subs:
            tasks.append(_send_webhook_post(client, sub.url, payload))
        await asyncio.gather(*tasks, return_exceptions=True)

async def _blocked_target_reason(url: str) -> str | None:
    """Why ``url`` must not be posted to, or None when it may.

    Checks the URL again (subscriptions stored before the validation existed) and
    every address its host name resolves to, so a DNS name pointing at loopback or
    the cloud metadata address is refused as well. httpx resolves once more on
    connect, so this narrows DNS tricks rather than ruling out DNS rebinding.
    """
    try:
        check_webhook_url(url)
    except ValueError as e:
        return str(e)

    parsed = urlparse(url)
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(parsed.hostname, port, type=socket.SOCK_STREAM)
    except socket.gaierror:
        return None  # httpx reports the resolution failure as usual
    for *_, sockaddr in infos:
        try:
            addr = ipaddress.ip_address(sockaddr[0])
        except ValueError:
            continue
        if is_blocked_webhook_ip(addr):
            return f"{parsed.hostname} resolves to {addr}, a loopback, link-local or metadata address"
    return None


async def _send_webhook_post(client: httpx.AsyncClient, url: str, payload: dict):
    """Sends a single POST request to the target webhook URL."""
    reason = await _blocked_target_reason(url)
    if reason:
        logger.warning("Webhook: refusing to post to '%s': %s", url, reason)
        return
    try:
        response = await client.post(url, json=payload)
        if response.status_code >= 400:
            logger.warning(
                f"Webhook: Target URL '{url}' returned status code {response.status_code}"
            )
        else:
            logger.debug(f"Webhook: Successfully dispatched event to '{url}'")
    except httpx.HTTPError as e:
        logger.error(f"Webhook: Failed to post to '{url}': {e}")
    except Exception as e:
        logger.error(f"Webhook: Unexpected error posting to '{url}': {e}")
