"""Freemium plans, credits and referral loop.

These are pure accounting tests plus the HTTP surface the pricing page uses.
No network or card details are involved: checkout is deliberately a descriptor
until Stripe keys are configured.
"""

from __future__ import annotations

from app.billing import (
    account_payload,
    apply_referral,
    entitlements_for,
    get_or_create_account,
    plan_catalog,
    reserve_minutes,
)
from app.config import Settings
from app.db import CreditAccount, new_session

API = "/api/v1"


def test_plan_catalog_matches_the_pdf():
    settings = Settings()
    plans = plan_catalog(settings)
    by_id = {item["id"]: item for item in plans}

    assert set(by_id) == {"free", "creator", "pro"}
    assert by_id["free"]["priceInr"] == 0
    assert by_id["free"]["monthlyMinutes"] == 30
    assert by_id["creator"]["priceInr"] == 299
    assert by_id["pro"]["priceInr"] == 499
    assert by_id["free"]["watermark"] is True
    assert by_id["pro"]["hd60"] is True


def test_entitlements_gate_watermark_and_hd60():
    paid = Settings(allow_1080p60_exports=True)

    free = entitlements_for("free", paid)
    creator = entitlements_for("creator", paid)
    pro = entitlements_for("pro", paid)

    assert free["watermarkRequired"] is True
    assert free["allow1080p60"] is False
    assert creator["watermarkRequired"] is False
    assert creator["allow1080p60"] is False
    assert pro["allow1080p60"] is True
    # Server flag still wins when no paid entitlement exists.
    assert entitlements_for("pro", Settings())["allow1080p60"] is False


def test_account_creation_is_idempotent(db_session):
    settings = Settings()
    first = get_or_create_account(db_session, "device-abc", settings)
    code = first.referral_code
    db_session.commit()

    again = get_or_create_account(db_session, "device-abc", settings)

    assert again.id == "device-abc"
    assert again.referral_code == code
    assert db_session.query(type(first)).count() == 1


def test_concurrent_first_contact_does_not_500(db_session):
    """Two devices' first requests can race; the loser must read the winner's row."""
    settings = Settings()
    first_session = new_session()
    second_session = new_session()
    try:
        # Both sessions see an empty ledger before either one commits.
        assert first_session.query(CreditAccount).filter(CreditAccount.id == "device-race").first() is None
        assert second_session.query(CreditAccount).filter(CreditAccount.id == "device-race").first() is None

        first = get_or_create_account(first_session, "device-race", settings)
        second = get_or_create_account(second_session, "device-race", settings)

        assert second.id == first.id
        assert second.referral_code == first.referral_code
    finally:
        first_session.close()
        second_session.close()

    db_session.expire_all()
    assert db_session.query(CreditAccount).filter(CreditAccount.id == "device-race").count() == 1


def test_referral_credits_both_sides_and_rejects_reuse(db_session):
    settings = Settings(referral_bonus_minutes=15)
    inviter = get_or_create_account(db_session, "device-inviter", settings)
    invitee = get_or_create_account(db_session, "device-invitee", settings)

    apply_referral(db_session, invitee, inviter.referral_code, settings)

    assert invitee.bonus_minutes == 15
    assert inviter.bonus_minutes == 15
    assert invitee.referred_by == inviter.id

    third = get_or_create_account(db_session, "device-third", settings)
    try:
        apply_referral(db_session, third, "NOPE", settings)
    except ValueError:
        pass
    else:
        raise AssertionError("unknown referral codes must be rejected")


def test_credit_gate_is_opt_in(db_session):
    settings = Settings(enable_credit_gate=False, free_monthly_minutes=1)
    account = get_or_create_account(db_session, "device-gate-off", settings)

    allowed, error = reserve_minutes(db_session, account, 3600, settings)

    assert allowed is True
    assert error is None
    assert account.used_sec == 0.0


def test_credit_gate_blocks_over_quota(db_session):
    settings = Settings(enable_credit_gate=True, free_monthly_minutes=1)
    account = get_or_create_account(db_session, "device-gate-on", settings)

    allowed, error = reserve_minutes(db_session, account, 30, settings)
    assert allowed is True
    assert error is None

    allowed, error = reserve_minutes(db_session, account, 3600, settings)
    assert allowed is False
    assert "remain" in (error or "")

    payload = account_payload(account, settings)
    assert payload["usedMinutes"] == 0.5
    assert payload["entitlements"]["watermarkRequired"] is True


def test_billing_http_surface(client):
    plans = client.get(f"{API}/billing/plans")
    assert plans.status_code == 200
    assert [p["id"] for p in plans.json()["plans"]] == ["free", "creator", "pro"]

    account = client.post(f"{API}/billing/account", json={"deviceId": "device-http"})
    assert account.status_code == 200
    data = account.json()
    assert data["plan"] == "free"
    assert data["remainingMinutes"] >= 30

    referral = client.post(
        f"{API}/billing/referral",
        json={"deviceId": "device-http-2", "code": data["referralCode"]},
    )
    assert referral.status_code == 200
    assert referral.json()["bonusMinutesEach"] == 15

    checkout = client.post(
        f"{API}/billing/checkout",
        json={"deviceId": "device-http-2", "planId": "pro"},
    )
    assert checkout.status_code == 200
    # No Stripe keys in tests: honest unavailable descriptor, not a fake URL.
    assert checkout.json()["mode"] == "unavailable"
    assert checkout.json()["checkoutUrl"] is None
