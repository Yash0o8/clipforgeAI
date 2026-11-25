"""Freemium plans, credits and referral accounting.

The product follows a "value first, signup later" flow: the browser generates a
device id, and that id owns a :class:`~app.db.CreditAccount`. Nothing here needs
a password or an email. When real accounts are introduced the same rows can be
re-keyed by user id without changing any route shape.

Enforcement is deliberately configurable. ``/billing`` is always live so the UI
can show remaining minutes and upgrade paths; servers that want hard quotas set
``ENABLE_CREDIT_GATE=true``.
"""

from __future__ import annotations

import logging
import secrets
from datetime import timedelta
from typing import Any

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .config import Settings
from .db import CreditAccount, iso, utcnow

logger = logging.getLogger(__name__)


def plan_catalog(settings: Settings) -> list[dict[str, Any]]:
    """Plans advertised by the pricing page and the export settings panel."""
    return [
        {
            "id": "free",
            "label": "Free",
            "priceInr": 0,
            "monthlyMinutes": int(settings.free_monthly_minutes),
            "watermark": True,
            "hd60": False,
            "splitScreenLibrary": True,
            "features": [
                "30 minutes of processing every month",
                "Split-screen + gaming presets",
                "480p instant preview, then 1080p export",
                "Small ClipForge watermark",
            ],
        },
        {
            "id": "creator",
            "label": "Creator",
            "priceInr": 299,
            "monthlyMinutes": int(settings.creator_monthly_minutes),
            "watermark": False,
            "hd60": False,
            "splitScreenLibrary": True,
            "features": [
                "300 minutes of processing every month",
                "No watermark on any export",
                "All caption presets + SFX hooks",
                "Priority render queue",
            ],
        },
        {
            "id": "pro",
            "label": "Pro",
            "priceInr": 499,
            "monthlyMinutes": int(settings.pro_monthly_minutes),
            "watermark": False,
            "hd60": True,
            "splitScreenLibrary": True,
            "features": [
                "1200 minutes of processing every month",
                "1080p 60fps exports",
                "No watermark on any export",
                "Everything in Creator",
            ],
        },
    ]


def entitlements_for(plan: str, settings: Settings) -> dict[str, Any]:
    """Capabilities derived from a plan id, used by export and UI gates."""
    plans = {item["id"]: item for item in plan_catalog(settings)}
    selected = plans.get(plan) or plans["free"]
    return {
        "plan": selected["id"],
        "watermarkRequired": bool(selected["watermark"]),
        "allow1080p60": bool(selected["hd60"]) and settings.allow_1080p60_exports,
        "splitScreenLibrary": bool(selected["splitScreenLibrary"]),
        "monthlyMinutes": int(selected["monthlyMinutes"]),
    }


def _new_referral_code(session: Session) -> str:
    for _ in range(8):
        code = secrets.token_hex(4).upper()
        if session.query(CreditAccount).filter(CreditAccount.referral_code == code).first() is None:
            return code
    raise RuntimeError("could not allocate a referral code")  # pragma: no cover


def _monthly_allowance(account: CreditAccount, settings: Settings) -> float:
    catalog = {item["id"]: item for item in plan_catalog(settings)}
    base = float(catalog.get(account.plan, catalog["free"])["monthlyMinutes"])
    return base + float(account.bonus_minutes or 0)


def _roll_period_if_needed(session: Session, account: CreditAccount) -> None:
    """Reset monthly usage once a 30-day window has elapsed."""
    if account.period_start is None:
        account.period_start = utcnow()
        return
    now = utcnow()
    start = account.period_start
    if start.tzinfo is None:
        from datetime import timezone
        start = start.replace(tzinfo=timezone.utc)
    if now - start >= timedelta(days=30):
        account.period_start = now
        account.used_sec = 0.0


def get_or_create_account(session: Session, device_id: str, settings: Settings) -> CreditAccount:
    """Fetch a device's ledger, creating it on first contact."""
    device_id = (device_id or "").strip()[:120]
    if not device_id:
        raise ValueError("deviceId is required")

    # Two first-contact requests for the same device can both see "no account"
    # before either commits. The primary key keeps the ledger correct; this loop
    # turns the losing insert into a normal read instead of a 500.
    for _attempt in range(3):
        account = session.query(CreditAccount).filter(CreditAccount.id == device_id).first()
        if account is not None:
            _roll_period_if_needed(session, account)
            session.commit()
            return account

        try:
            account = CreditAccount(
                id=device_id,
                account_type="device",
                plan="free",
                bonus_minutes=0,
                used_sec=0.0,
                period_start=utcnow(),
                referral_code=_new_referral_code(session),
            )
            session.add(account)
            session.commit()
            return account
        except IntegrityError:
            session.rollback()
            logger.info("credit account %s was created concurrently; reloading", device_id)

    # pragma: no cover - three collisions on one device is not realistic
    raise RuntimeError("could not load the credit account after concurrent inserts")


def account_payload(account: CreditAccount, settings: Settings) -> dict[str, Any]:
    """JSON view with computed quota fields."""
    allowance = _monthly_allowance(account, settings)
    used_minutes = float(account.used_sec or 0.0) / 60.0
    payload = account.to_dict(
        allowance_minutes=allowance,
        used_minutes=used_minutes,
    )
    payload["entitlements"] = entitlements_for(account.plan, settings)
    payload["checkoutEnabled"] = bool(
        settings.stripe_secret_key
        and settings.stripe_creator_price_id
        and settings.stripe_pro_price_id
    )
    return payload


def apply_referral(
    session: Session,
    account: CreditAccount,
    code: str,
    settings: Settings,
) -> tuple[CreditAccount, CreditAccount]:
    """Credit both sides of a referral. Returns ``(invitee, inviter)``."""
    code = (code or "").strip().upper()
    if not code:
        raise ValueError("Enter a referral code.")
    if account.referral_code and account.referral_code.upper() == code:
        raise ValueError("You cannot refer yourself.")
    if account.referred_by:
        raise ValueError("This device has already claimed a referral bonus.")

    inviter = session.query(CreditAccount).filter(CreditAccount.referral_code == code).first()
    if inviter is None:
        raise ValueError("That referral code was not found.")
    if inviter.id == account.id:
        raise ValueError("You cannot refer yourself.")

    bonus = int(settings.referral_bonus_minutes)
    account.referred_by = inviter.id
    account.bonus_minutes = int(account.bonus_minutes or 0) + bonus
    inviter.bonus_minutes = int(inviter.bonus_minutes or 0) + bonus
    account.updated_at = utcnow()
    inviter.updated_at = utcnow()
    session.commit()
    logger.info("referral applied: %s -> %s (+%d min each)", account.id, inviter.id, bonus)
    return account, inviter


def reserve_minutes(
    session: Session,
    account: CreditAccount,
    duration_sec: float,
    settings: Settings,
) -> tuple[bool, str | None]:
    """Charge estimated processing time, or explain why it is not allowed.

    Returns ``(allowed, errorMessage)``. When the gate is disabled this is a
    no-op so existing installs keep their current unlimited behaviour.
    """
    if not settings.enable_credit_gate:
        return True, None

    _roll_period_if_needed(session, account)
    allowance = _monthly_allowance(account, settings)
    used = float(account.used_sec or 0.0) / 60.0
    needed = max(0.0, float(duration_sec or 0.0)) / 60.0
    if used + needed > allowance:
        return False, (
            f"This video needs about {needed:.0f} minutes of processing, but only "
            f"{max(0.0, allowance - used):.0f} minutes remain this period. "
            "Invite a creator for +15 minutes, or upgrade to continue."
        )

    account.used_sec = float(account.used_sec or 0.0) + needed * 60.0
    account.updated_at = utcnow()
    session.commit()
    return True, None


def period_reset_at(account: CreditAccount) -> str | None:
    """Human-readable next reset, used by the pricing page."""
    if account.period_start is None:
        return None
    return iso(account.period_start + timedelta(days=30))
