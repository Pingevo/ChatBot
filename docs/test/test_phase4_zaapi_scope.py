"""Phase 4 — delivery-scope normalization owner contracts (Task 2; §16.25,31).

`canonical_delivery_scope` is the single owner of shop/platform normalization:
shop whitespace-collapse (case-sensitive) + platform strip/casefold. No
callsite may inline-copy it — `account_scope_fingerprint` delegates, and later
generation/retrieval normalize query scope through the same function.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))    # shopeechat.kb_zaapi_schema


def test_scope_owner_truth_table():
    """§16.25: shop whitespace variants collapse to match; shop case differs →
    NOT equal; platform case differs → equal; different scope → different."""
    from shopeechat.kb_zaapi_schema import canonical_delivery_scope

    # whitespace collapse — leading/trailing/internal, case-sensitive shop
    assert canonical_delivery_scope("  Shop  A ", " shopee ") == ("Shop A", "shopee")
    assert canonical_delivery_scope("Shop A", "SHOPEE") == ("Shop A", "shopee")
    # shop case differs → different scope (case-sensitive)
    assert canonical_delivery_scope("shop a", "shopee") == ("shop a", "shopee")
    assert canonical_delivery_scope("shop a", "shopee") != \
        canonical_delivery_scope("Shop A", "shopee")
    # platform case differs → same scope (casefold)
    assert canonical_delivery_scope("Shop", "Shopee") == \
        canonical_delivery_scope("Shop", "SHOPEE")
    # different shop or platform → different scope (no leak)
    assert canonical_delivery_scope("ShopA", "shopee") != \
        canonical_delivery_scope("ShopB", "shopee")
    assert canonical_delivery_scope("ShopA", "shopee") != \
        canonical_delivery_scope("ShopA", "lazada")


def test_account_scope_fingerprint_parity():
    """Accounts differing only by pre-normalization whitespace/case produce the
    same fingerprint as their canonical form (existing contract — refactor must
    not drift). Different scopes produce different fingerprints."""
    from shopeechat.kb_zaapi_schema import account_scope_fingerprint as fp

    raw = [{"id": "a1", "name": "  Shop  A ", "platform": " SHOPEE "}]
    canon = [{"id": "a1", "name": "Shop A", "platform": "shopee"}]
    assert fp(raw) == fp(canon)
    other_shop = [{"id": "a1", "name": "Shop B", "platform": "shopee"}]
    assert fp(raw) != fp(other_shop)
    other_platform = [{"id": "a1", "name": "Shop A", "platform": "lazada"}]
    assert fp(raw) != fp(other_platform)


def test_account_scope_fingerprint_uses_owner(monkeypatch):
    """§16.31 behavioral: the fingerprint path must call the single owner —
    a spy on the module attribute must observe one call per account in each of
    the two inline sites (delivery-uniqueness set + identity fingerprint)."""
    import shopeechat.kb_zaapi_schema as schema

    calls = []
    real = schema.canonical_delivery_scope

    def spy(shop, platform):
        calls.append((shop, platform))
        return real(shop, platform)

    monkeypatch.setattr(schema, "canonical_delivery_scope", spy)
    accounts = [{"id": "a1", "name": "Shop A", "platform": "shopee"},
                {"id": "a2", "name": "Shop B", "platform": "shopee"}]
    schema.account_scope_fingerprint(accounts)
    assert len(calls) == 2 * len(accounts)


def test_scope_boundary_malformed():
    """§16.31: malformed account types fail at the boundary —
    `account_scope_fingerprint` validates str-ness before delegating."""
    from shopeechat.kb_zaapi_schema import account_scope_fingerprint

    with pytest.raises(ValueError, match="invalid account scope"):
        account_scope_fingerprint([{"id": "a1", "name": None,
                                    "platform": "shopee"}])
    with pytest.raises(ValueError, match="invalid account scope"):
        account_scope_fingerprint([{"id": "a1", "name": "Shop",
                                    "platform": 123}])
    with pytest.raises(ValueError, match="invalid account scope"):
        account_scope_fingerprint("not-a-list")
