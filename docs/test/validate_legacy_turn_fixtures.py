"""Fixture-integrity validator for legacy_turn_incidents.jsonl.

Catches fabricated failures and inconsistent fixture data BEFORE pytest:
a fixture must not create its own failure (hidden docs, shop mismatch,
expected ids absent from catalog), and statuses must be honest —
incident rows must pin a real level, answer-level rows must document the
prod symptom, pending rows must state why they cannot replay offline.

Run:  .venv/bin/python docs/test/validate_legacy_turn_fixtures.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "legacy_turn_incidents.jsonl"

OWNERS = {
    "turn_action", "conversation_subject", "claim_or_ticket_state",
    "profile_or_slot_parse", "canonical_identity", "canonical_availability",
    "source_recall", "compatibility_evidence", "selection_coverage",
    "answer_context", "final_claim_validation", "handoff_or_workflow_state",
    "token_or_web_gate", "policy_eligibility",
}
ACTIONS = {"answer", "handoff", "locked", "claim_collect", "order_info"}
STATUSES = {"positive", "incident", "answer_level", "pending_live_replay"}
_PHONE = re.compile(r"(?<!\d)0\d{9}(?!\d)")
_EMAIL = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")

# ── expectation-key allowlists (Phase 0C) ────────────────────────────────────
# Every expectation key must have a real assertion in
# test_legacy_turn_incident_replay.py. Metadata belongs in top-level fields
# (boundary_note/tags/refs/…), never inside an expectation block — a key
# without an assertion is a false-green and must fail here.
_TOP_LEVEL_KEYS = {
    "id", "source", "title", "shop", "platform", "conversation_id",
    "catalog", "orders", "turns", "history_extra", "timeline_seed",
    "claim_state_seed", "ticket_state", "intent_result", "runtime_flags",
    "shop_settings_seed", "turn_decision_expect",
    "expected", "profile_expect", "slot_expect", "availability_expect",
    "selection_expect", "expected_owner", "secondary_owners",
    "incident_levels", "levels", "status", "boundary_note", "pending_reason",
    "multi_shop_reason", "synthetic_pii", "tags", "refs", "owner_probe",
    "availability_probe",  # metadata: points at the item under test
    "expectation_note",    # metadata: L1/L2-only expectation prose (no assert)
    "noncatalog_item_reason",  # metadata: why expected ids are absent
}
_EXPECTED_KEYS = {
    "action", "handoff_reason", "web_search",
    "llm_item_ids", "llm_item_ids_any_of", "llm_must_not_item_ids",
    "llm_card_status", "llm_history_or_context_contains",
    "llm_forbidden_card_types", "llm_max_calls", "llm_general_qtype",
    "resp_max_products", "claim_state_exists", "final_claim_state",
    "link_policy",
}
_PROFILE_KEYS = {
    "product_types", "product_types_any", "target_device",
    "model_codes_absent", "compat_mode_in",
}
_SLOT_KEYS = {"min_slots", "types_union", "subtypes_union", "relation"}
_AVAIL_FIELDS = {
    "answerable", "available_for_sale", "catalog_status", "customer_visible",
}
_AVAIL_KEY = re.compile(r"^\d+(:\d+)?$")   # "<item_id>" or "<item_id>:<model_id>"
_SELECTION_KEYS = {
    "selected_item_ids", "unavailable_item_ids", "request_type_coverage",
}
_EXPECT_BLOCKS = {
    "expected": _EXPECTED_KEYS,
    "profile_expect": _PROFILE_KEYS,
    "slot_expect": _SLOT_KEYS,
    "selection_expect": _SELECTION_KEYS,
}


def _norm(v):
    if isinstance(v, float) and v == int(v):
        return int(v)
    if isinstance(v, str):
        try:
            f = float(v)
            return int(f) if f == int(f) else v
        except (ValueError, TypeError):
            return v
    return v


def _exec_mode(fx: dict) -> str:
    """L3 execution mode — honest flag coverage, not grouped-runtime proof."""
    flags = fx.get("runtime_flags") or {}
    return ("grouped_selection_on" if flags.get("grouped_selection")
            else "legacy_flag_off")


def _expected_ids(fx: dict) -> set:
    """every item id referenced by expected — including negative-control
    (llm_must_not_item_ids) and llm_card_status keys."""
    exp = fx.get("expected") or {}
    ids = {_norm(i) for k in ("llm_item_ids", "llm_must_not_item_ids")
           for i in (exp.get(k) or [])}
    for grp in exp.get("llm_item_ids_any_of") or []:
        ids |= {_norm(i) for i in grp}
    ids |= {_norm(k) for k in (exp.get("llm_card_status") or {})}
    return ids


def check_row(fx: dict) -> list[str]:
    errs: list[str] = []
    rid = fx.get("id") or "<no id>"
    status = fx.get("status")
    cat = fx.get("catalog") or []
    cat_ids = {_norm(d.get("item_id")) for d in cat}
    shops = {str(d.get("shopname")) for d in cat if d.get("shopname") is not None}

    if status not in STATUSES:
        errs.append(f"status={status!r} not in {sorted(STATUSES)}")

    # expectation-key coverage — unknown/unasserted keys are false-greens
    for k in fx:
        if k not in _TOP_LEVEL_KEYS:
            errs.append(f"unknown top-level key {k!r}")
    for block, allow in _EXPECT_BLOCKS.items():
        for k in (fx.get(block) or {}):
            if k not in allow:
                errs.append(f"unasserted expectation key {block}.{k!r} — "
                            "add a real assertion or move it to metadata")
    for key, val in (fx.get("availability_expect") or {}).items():
        if not _AVAIL_KEY.match(str(key)):
            errs.append(f"availability_expect key {key!r} must be "
                        "'<item_id>' or '<item_id>:<model_id>'")
        if not isinstance(val, dict):
            errs.append(f"availability_expect[{key}] must be a field dict")
            continue
        for f in val:
            if f not in _AVAIL_FIELDS:
                errs.append(f"unasserted availability field "
                            f"availability_expect.{key}.{f!r}")

    owner = fx.get("expected_owner")
    if status in {"incident", "answer_level", "pending_live_replay"}:
        if owner not in OWNERS:
            errs.append(f"expected_owner={owner!r} not in taxonomy")
    elif owner and owner not in OWNERS:
        errs.append(f"expected_owner={owner!r} not in taxonomy")

    # shop/catalog consistency — multi-shop needs an explicit reason
    if cat:
        fixture_shop = str(fx.get("shop") or "")
        if len(shops) > 1 and not fx.get("multi_shop_reason"):
            errs.append(f"multi-shop catalog {sorted(shops)} without "
                        "multi_shop_reason")
        if shops and fixture_shop and fixture_shop not in shops \
                and not fx.get("multi_shop_reason"):
            errs.append(f"fixture shop={fixture_shop} not in catalog "
                        f"shops={sorted(shops)}")

    # fabricated-failure mechanisms are forbidden
    if "fetchable_item_ids" in fx:
        errs.append("fetchable_item_ids is forbidden (fabricates recall "
                    "failure; use pending_live_replay)")

    # action enum + expected block is an L3 contract — a fixture without
    # level 3 must not claim boundary assertions (move to expectation_note)
    exp = fx.get("expected") or {}
    if "action" in exp and exp["action"] not in ACTIONS:
        errs.append(f"expected.action={exp['action']!r} not in "
                    f"{sorted(ACTIONS)}")
    if exp and 3 not in (fx.get("levels") or []):
        errs.append("expected block on a non-L3 fixture — expected is "
                    "asserted only at L3; move prose to expectation_note")

    # ids the case expects to fetch must exist in the catalog — negative
    # controls included; escape hatch = noncatalog_item_reason metadata
    missing = _expected_ids(fx) - cat_ids
    if (missing and status != "pending_live_replay"
            and not fx.get("noncatalog_item_reason")):
        errs.append(f"expected item ids absent from catalog: {sorted(missing)}")

    # status-specific honesty rules
    levels = set(fx.get("levels") or [])
    if status == "incident":
        inc = set(fx.get("incident_levels") or levels)
        if not inc <= levels:
            errs.append(f"incident_levels {sorted(inc)} not ⊆ levels "
                        f"{sorted(levels)}")
        if not inc:
            errs.append("incident with no levels")
    if status == "answer_level" and not fx.get("boundary_note"):
        errs.append("answer_level without boundary_note (must document "
                    "the prod answer-side symptom)")
    if status == "pending_live_replay" and not fx.get("pending_reason"):
        errs.append("pending_live_replay without pending_reason")

    # turn_decision_expect — per-user-turn TurnDecision contract assertions
    # (consumed by shadow sweep + contract test; one entry per user turn)
    tde = fx.get("turn_decision_expect")
    if tde is not None:
        _td_actions = {
            "locked", "noise", "handoff", "claim_collect", "claim_request",
            "answer_product", "answer_general", "followup", "unknown",
        }
        _tde_keys = {"action", "flags_contains"}
        user_turns = sum(1 for t in (fx.get("turns") or [])
                         if (t or {}).get("role", "user") == "user")
        if not isinstance(tde, list) or not tde:
            errs.append("turn_decision_expect must be a non-empty list")
        elif len(tde) != user_turns:
            errs.append(f"turn_decision_expect has {len(tde)} entries but "
                        f"{user_turns} user turns")
        else:
            for i, ent in enumerate(tde):
                path = f"turn_decision_expect[{i}]"
                if not isinstance(ent, dict):
                    errs.append(f"{path} must be a dict")
                    continue
                for k in ent:
                    if k not in _tde_keys:
                        errs.append(f"unknown nested key {path}.{k!r}")
                if "action" not in ent:
                    errs.append(f"{path}.action required")
                elif (not isinstance(ent["action"], str)
                        or ent["action"] not in _td_actions):
                    errs.append(f"{path}.action={ent['action']!r} not in "
                                f"{sorted(_td_actions)}")
                fc = ent.get("flags_contains")
                if fc is not None:
                    if (not isinstance(fc, list)
                            or any(not isinstance(f, str) or not f
                                   for f in fc)):
                        errs.append(f"{path}.flags_contains must be "
                                    "list[str] non-empty items")
                    elif len(set(fc)) != len(fc):
                        errs.append(f"{path}.flags_contains has duplicates")

    # shop_settings_seed — nested schema (per-shop settings docs)
    sss = fx.get("shop_settings_seed")
    if sss is not None:
        _ss_keys = {"shopname", "platform", "post_handoff_exceptions",
                    "is_deleted"}
        if not isinstance(sss, list):
            errs.append("shop_settings_seed must be a list")
        else:
            for i, row in enumerate(sss):
                path = f"shop_settings_seed[{i}]"
                if not isinstance(row, dict):
                    errs.append(f"{path} must be a dict")
                    continue
                for k in row:
                    if k not in _ss_keys:
                        errs.append(f"unknown nested key {path}.{k!r}")
                if not isinstance(row.get("shopname"), str) \
                        or not row["shopname"]:
                    errs.append(f"{path}.shopname must be non-empty str")
                if not isinstance(row.get("platform"), str) \
                        or not row["platform"]:
                    errs.append(f"{path}.platform must be non-empty str")
                exc = row.get("post_handoff_exceptions")
                if exc is not None:
                    if (not isinstance(exc, list)
                            or any(not isinstance(e, str) or not e
                                   for e in exc)):
                        errs.append(f"{path}.post_handoff_exceptions must "
                                    "be list[str] non-empty items")
                if "is_deleted" in row and not isinstance(
                        row["is_deleted"], bool):
                    errs.append(f"{path}.is_deleted must be bool")

    # vacuous claim assertion — seeded claim_state already exists;
    # claim_state_exists=true without final_claim_state asserts nothing
    if (fx.get("claim_state_seed") and exp.get("claim_state_exists")
            and not exp.get("final_claim_state")):
        errs.append("claim_state_exists with claim_state_seed is vacuous "
                    "— seed already creates it; assert final_claim_state")

    # vacuous final_claim_state — asserting only values already present in
    # the seed proves nothing about what the turn persisted
    seed = fx.get("claim_state_seed") or {}
    fcs = exp.get("final_claim_state")
    if seed and isinstance(fcs, dict) and fcs and all(
            k in seed and seed[k] == v for k, v in fcs.items()):
        errs.append("final_claim_state is vacuous — every key/value already "
                    "in claim_state_seed before replay")

    # no PII / raw customer data in turns — a fixture may declare
    # synthetic_pii when a claim test NEEDS a valid-format value
    synthetic = set(fx.get("synthetic_pii") or [])
    for t in fx.get("turns") or []:
        text = t.get("text") or ""
        if _PHONE.search(text) and "phone" not in synthetic:
            errs.append(f"phone-like number in turn text (not declared "
                        f"synthetic_pii): {text[:40]!r}")
        if _EMAIL.search(text):
            errs.append(f"email in turn text: {text[:40]!r}")
    return [f"{rid}: {e}" for e in errs]


def main() -> int:
    rows = [json.loads(l) for l in FIXTURES.read_text().splitlines()
            if l.strip()]
    errors: list[str] = []
    counts: dict[str, int] = {}
    for fx in rows:
        errors.extend(check_row(fx))
        counts[fx.get("status") or "?"] = counts.get(
            fx.get("status") or "?", 0) + 1

    print(f"fixtures: {len(rows)}")
    for k in ("positive", "incident", "answer_level", "pending_live_replay"):
        print(f"  {k:<22} {counts.get(k, 0)}")
    # execution mode — counted on L3 fixtures only (the level that actually
    # runs chat()); non-L3 rows are L1/L2 contract-only, never "legacy chat"
    l3_rows = [fx for fx in rows if 3 in (fx.get("levels") or [])]
    modes: dict[str, int] = {}
    for fx in l3_rows:
        modes[_exec_mode(fx)] = modes.get(_exec_mode(fx), 0) + 1
    for k in ("legacy_flag_off", "grouped_selection_on"):
        print(f"  exec:{k:<20} {modes.get(k, 0)}")
    print(f"  contract_only          {len(rows) - len(l3_rows)}")
    if errors:
        print(f"\nINTEGRITY FAILURES: {len(errors)}")
        for e in errors:
            print(f"  ✗ {e}")
        return 1
    print("\nintegrity: all rows pass")
    return 0


if __name__ == "__main__":
    sys.exit(main())
