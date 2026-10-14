"""Webhooks routing endpoints for GravityLAN."""

import logging
from fastapi import APIRouter, Depends, HTTPException, Body
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.database import get_db
from app.api.auth import get_bearer_admin, get_current_admin
from app.models.webhook import WebhookSubscription
from app.schemas.webhook import WebhookSubscriptionCreate, WebhookSubscriptionResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/webhooks", tags=["webhooks"])

@router.get("", response_model=list[WebhookSubscriptionResponse])
async def list_webhooks(
    token: str = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db)
):
    """List all registered webhook subscriptions."""
    result = await db.execute(select(WebhookSubscription).order_by(WebhookSubscription.created_at.desc()))
    return result.scalars().all()

@router.post("", response_model=WebhookSubscriptionResponse)
async def create_webhook(
    payload: WebhookSubscriptionCreate,
    token: str = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db)
):
    """Register a new webhook subscription."""
    events_str = ",".join(payload.events)
    
    new_sub = WebhookSubscription(
        url=payload.url,
        events=events_str,
        is_active=True
    )
    db.add(new_sub)
    await db.commit()
    await db.refresh(new_sub)
    return new_sub

@router.delete("/{webhook_id}")
async def delete_webhook(
    webhook_id: int,
    token: str = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db)
):
    """Delete / revoke a webhook subscription."""
    result = await db.execute(select(WebhookSubscription).where(WebhookSubscription.id == webhook_id))
    db_sub = result.scalar_one_or_none()
    if not db_sub:
        raise HTTPException(status_code=404, detail="Webhook subscription not found")
        
    await db.delete(db_sub)
    await db.commit()
    return {"status": "ok", "message": "Webhook subscription deleted successfully"}

@router.post("/test")
async def test_webhook_dispatch(
    event: str = Body("test.event", embed=True),
    data: dict = Body({"status": "testing"}, embed=True),
    token: str = Depends(get_current_admin)
):
    """Trigger a mock/test webhook event to verify integrations."""
    from app.services.webhook_service import trigger_webhooks
    await trigger_webhooks(event_type=event, data=data)
    return {"status": "ok", "message": f"Webhook test event '{event}' scheduled for dispatch."}

@router.get("/test")
async def test_webhook_dispatch_get(
    event: str = "test.event",
    token: str = Depends(get_bearer_admin),
    db: AsyncSession = Depends(get_db)
):
    """Trigger a mock/test webhook event via GET query parameter. Raises 404 if no webhooks exist.

    Needs an API token in the 'Authorization: Bearer' header; a session cookie alone is
    rejected (403), so a link on another site cannot fire webhooks. Browser sessions use
    POST /api/webhooks/test.
    """
    result = await db.execute(select(WebhookSubscription).where(WebhookSubscription.is_active == True))
    active_subs = result.scalars().all()
    if not active_subs:
        raise HTTPException(status_code=404, detail="No active webhooks configured")

    from app.services.webhook_service import trigger_webhooks
    from datetime import datetime, timezone
    mock_data = {
        "status": "testing",
        "triggered_by": "GET /api/webhooks/test",
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    await trigger_webhooks(event_type=event, data=mock_data)
    return {"status": "ok", "message": f"Webhook test event '{event}' scheduled for dispatch via GET."}
