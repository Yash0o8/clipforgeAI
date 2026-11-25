"""Plans, credits and referral endpoints.

All routes are keyed by a browser-generated ``deviceId`` so the first clip can
be generated without an account. The payloads already match a future logged-in
user flow — only the lookup key would change.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..billing import (
    account_payload,
    apply_referral,
    entitlements_for,
    get_or_create_account,
    period_reset_at,
    plan_catalog,
)
from ..config import get_settings
from ..db import get_session

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/billing", tags=["billing"])


class DeviceRequest(BaseModel):
    deviceId: str = Field(min_length=3, max_length=120)


class ReferralRequest(DeviceRequest):
    code: str = Field(min_length=3, max_length=32)


class CheckoutRequest(DeviceRequest):
    planId: str = Field(pattern="^(creator|pro)$")


@router.get("/plans")
def list_plans() -> dict[str, Any]:
    settings = get_settings()
    return {
        "plans": plan_catalog(settings),
        "currency": "INR",
        "billingPeriod": "monthly",
        "referralBonusMinutes": int(settings.referral_bonus_minutes),
        "checkoutEnabled": bool(
            settings.stripe_secret_key
            and settings.stripe_creator_price_id
            and settings.stripe_pro_price_id
        ),
    }


@router.post("/account")
def get_account(payload: DeviceRequest, session: Session = Depends(get_session)) -> dict[str, Any]:
    settings = get_settings()
    account = get_or_create_account(session, payload.deviceId, settings)
    data = account_payload(account, settings)
    data["periodResetAt"] = period_reset_at(account)
    return data


@router.post("/referral")
def claim_referral(payload: ReferralRequest, session: Session = Depends(get_session)) -> dict[str, Any]:
    settings = get_settings()
    account = get_or_create_account(session, payload.deviceId, settings)
    try:
        account, inviter = apply_referral(session, account, payload.code, settings)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    data = account_payload(account, settings)
    data["invitedDevice"] = inviter.id
    data["bonusMinutesEach"] = int(settings.referral_bonus_minutes)
    return data


@router.post("/checkout")
def create_checkout(payload: CheckoutRequest, session: Session = Depends(get_session)) -> dict[str, Any]:
    """Stripe-ready checkout descriptor.

    With Stripe keys configured this returns a checkout session URL. Without
    them it returns a clearly-marked unavailable descriptor instead of a
    broken redirect, so the UI can explain the upgrade path honestly.
    """
    settings = get_settings()
    if not settings.stripe_secret_key:
        return {
            "mode": "unavailable",
            "checkoutUrl": None,
            "planId": payload.planId,
            "message": (
                "Online checkout is not configured for this deployment. "
                "Set STRIPE_SECRET_KEY and the price IDs to enable it."
            ),
        }

    try:
        import stripe  # type: ignore  # optional dependency
    except ImportError as exc:  # pragma: no cover - depends on deployment
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Stripe SDK is not installed on this server.",
        ) from exc

    price_id = (
        settings.stripe_pro_price_id
        if payload.planId == "pro"
        else settings.stripe_creator_price_id
    )
    stripe.api_key = settings.stripe_secret_key
    account = get_or_create_account(session, payload.deviceId, settings)
    try:
        checkout = stripe.checkout.Session.create(
            mode="subscription",
            line_items=[{"price": price_id, "quantity": 1}],
            client_reference_id=account.id,
            success_url="/app/billing?checkout=success",
            cancel_url="/app/billing?checkout=cancelled",
        )
    except Exception as exc:  # pragma: no cover - needs live Stripe account
        logger.exception("stripe checkout failed")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Could not start checkout: {exc}",
        ) from exc

    return {
        "mode": "stripe",
        "checkoutUrl": checkout.url,
        "sessionId": checkout.id,
        "planId": payload.planId,
        "entitlements": entitlements_for(payload.planId, settings),
    }
