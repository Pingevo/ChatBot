"""Focused regression for audit_botworker_incident.py — proves the audit sees
the CURRENT claim-terminal contract and batch/workflow reply linkage.

No Mongo, no network — pure fixtures + a mini collection honoring the exact
operators the audit uses ($in / $or / $ne / $exists).
"""
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import audit_botworker_incident as audit  # noqa: E402

# Legacy terminal names — historical claim docs may carry these; they are
# terminal in the audit but NOT part of the TypeScript owner contract, so they
# are excluded from the exact-equality comparison and checked separately.
LEGACY_TERMINAL_STATUSES = {"processed", "handoff", "skipped", "answered"}
# The stale list the buggy audit used (kept here only to prove the divergence once).
OLD_STALE_LIST = ["processed", "bot_failed", "handoff", "skipped", "answered"]

_REPO_ROOT = Path(__file__).resolve().parents[2]
_OWNER_TS = _REPO_ROOT / "ChatAdminWeb/src/backend/service/botWorkerService.ts"


def extract_owner_terminal_statuses() -> set[str]:
    """Read the real CLAIM_TERMINAL_STATUSES array from botWorkerService.ts.

    Bounded to the single declaration — never scans the whole file. Fails
    loudly when the declaration is missing or the array is empty, so a
    renamed/emptied owner can never silently green the suite."""
    src = _OWNER_TS.read_text(encoding="utf-8")
    m = re.search(
        r"CLAIM_TERMINAL_STATUSES\s*=\s*new Set<[^>]*>\(\[\s*([^\]]*?)\s*\]\s*\)",
        src,
    )
    if not m:
        raise AssertionError("CLAIM_TERMINAL_STATUSES declaration not found in botWorkerService.ts")
    statuses = set(re.findall(r'"([^"]+)"', m.group(1)))
    if not statuses:
        raise AssertionError("CLAIM_TERMINAL_STATUSES declaration has an empty array")
    return statuses


class FakeColl:
    def __init__(self, docs):
        self.docs = docs

    def find(self, query=None, projection=None):
        return [self._project(d, projection) for d in self.docs if self._match(d, query or {})]

    @staticmethod
    def _match(doc, q):
        for k, cond in q.items():
            if k == "$or":
                if not any(FakeColl._match(doc, sub) for sub in cond):
                    return False
                continue
            v = doc.get(k)
            if isinstance(cond, dict):
                if "$in" in cond:
                    if isinstance(v, list):
                        if not any(item in cond["$in"] for item in v):
                            return False
                    elif v not in cond["$in"]:
                        return False
                if "$ne" in cond and v == cond["$ne"]:
                    return False
                if "$exists" in cond and ((k in doc) != bool(cond["$exists"])):
                    return False
                if "$regex" in cond:
                    if not (isinstance(v, str) and re.search(cond["$regex"], v)):
                        return False
            elif v != cond:
                return False
        return True

    @staticmethod
    def _project(doc, proj):
        if not proj:
            return dict(doc)
        return {k: doc[k] for k in proj if k in doc and proj[k] == 1} | {"_id": doc.get("_id")}


results = []
def check(name, cond, extra=""):
    results.append((name, bool(cond)))
    print(("  PASS " if cond else "  FAIL ") + name + (f"  {extra}" if extra and not cond else ""))


def main():
    print("\n[0] import purity — helper tests must not touch .env/Mongo")
    check("audit module import does not load knowledge_base",
          "shopeechat.knowledge_base" not in sys.modules)

    # ── Part 1 — terminal classification ─────────────────────────────
    print("\n[1] terminal status classification vs runtime contract")
    # Contract is read from the real TypeScript owner — no Python mirror
    # decides what "correct" means. Drift in the owner fails this suite.
    owner_statuses = extract_owner_terminal_statuses()
    print(f"    owner CLAIM_TERMINAL_STATUSES = {sorted(owner_statuses)}")
    audit_current = audit.KNOWN_TERMINAL_STATUSES - LEGACY_TERMINAL_STATUSES
    check("audit current terminal statuses match TypeScript owner exactly",
          audit_current == owner_statuses,
          f"missing={owner_statuses - audit_current}, extra={audit_current - owner_statuses}")
    check("audit exposes classify_claim_status", hasattr(audit, "classify_claim_status"))
    if hasattr(audit, "classify_claim_status"):
        for s in owner_statuses:
            check(f"owner status '{s}' classified terminal",
                  audit.classify_claim_status(s) == "terminal")
        check("'processing' is NOT terminal", audit.classify_claim_status("processing") == "processing")
        check("missing status is unknown (not terminal)", audit.classify_claim_status(None) == "unknown")
        # pinned: a non-empty status outside the contract is NOT claimed terminal —
        # it is surfaced as "unrecognized" so a future non-terminal (e.g. 'retrying')
        # cannot become a false positive, and a future terminal cannot vanish
        check("non-empty status outside contract is 'unrecognized' (surfaced, not claimed)",
              audit.classify_claim_status("some_new_status") == "unrecognized")
        # legacy names still count as terminal via the known-terminal set
        for s in OLD_STALE_LIST:
            check(f"legacy status '{s}' classified terminal",
                  audit.classify_claim_status(s) == "terminal")

    # Prove the stale literal list misses the owner contract (regression guard)
    check("old literal list demonstrably misses owner contract (divergence > 0)",
          len(owner_statuses - set(OLD_STALE_LIST)) == 6,
          f"missed={owner_statuses - set(OLD_STALE_LIST)}")

    print("\n[1b] terminal_records_per_mid derivation over fetched claims")
    mids = ["m1", "m2", "m3", "m4", "m5"]
    claims = FakeColl([
        {"_id": "botworker:claim:m1", "message_id": "m1", "status": "processing"},
        {"_id": "botworker:claim:m2", "message_id": "m2", "status": "bot_answered"},
        {"_id": "botworker:claim:m3", "message_id": "m3", "status": "handed_off"},
        {"_id": "botworker:claim:m4", "message_id": "m4", "status": "workflow_resumed"},
        {"_id": "botworker:claim:m5", "message_id": "m5"},  # missing status → unknown
    ])
    fetched = list(claims.find({"message_id": {"$in": mids}}))
    if hasattr(audit, "terminal_statuses_per_mid"):
        per_mid, flagged = audit.terminal_statuses_per_mid(fetched, mids)
        check("m1 (processing) has no terminal record", per_mid.get("m1") == [])
        check("m2 terminal=[bot_answered]", per_mid.get("m2") == ["bot_answered"])
        check("m3 terminal=[handed_off]", per_mid.get("m3") == ["handed_off"])
        check("m4 terminal=[workflow_resumed]", per_mid.get("m4") == ["workflow_resumed"])
        check("m5 missing status reported as unknown, not hidden",
              any(u.get("message_id_hash") == audit.h("m5") and u.get("class") == "unknown"
                  for u in flagged))

    # ── Part 2 — reply query: scalar + batch array + wf suffix ───────
    print("\n[2] reply linkage — scalar, batch array, workflow suffix")
    replies = FakeColl([
        {"_id": "r1", "reply_id": "botworker:reply:m1", "inbound_message_id": "m1",
         "origin": "worker", "mode": "standalone"},
        {"_id": "r2", "reply_id": "botworker:reply:m1:b2", "inbound_message_id": "m1",
         "inbound_message_ids": ["m1", "m2", "m3"], "batch_id": "b2",
         "origin": "worker", "mode": "standalone"},
        {"_id": "r3", "reply_id": "botworker:reply:m1__wf0", "inbound_message_id": "m1__wf0",
         "inbound_message_ids": ["m1", "m2", "m3"], "batch_id": "b2",
         "origin": "workflow", "mode": "standalone", "outcome_envelope": {"type": "workflow"}},
        # historical wf shape — scalar suffix ONLY, no inbound_message_ids array
        {"_id": "r4", "reply_id": "botworker:reply:m4__wf0", "inbound_message_id": "m4__wf0",
         "origin": "workflow", "mode": "standalone"},
        {"_id": "rX", "reply_id": "other", "inbound_message_id": "zzz"},
        # suffix lookalike must NOT match: "__wfx" is not __wf<digits>
        {"_id": "rY", "reply_id": "other2", "inbound_message_id": "m4__wfx"},
    ])
    if hasattr(audit, "build_reply_query"):
        q = audit.build_reply_query(mids + ["mX"])
        hits = replies.find(q)
        hit_ids = {r["_id"] for r in hits}
        check("query returns scalar reply r1", "r1" in hit_ids)
        check("query returns batch reply r2 via array", "r2" in hit_ids)
        check("query returns wf reply r3 via array", "r3" in hit_ids)
        check("query returns historical scalar-only wf reply r4 via regex", "r4" in hit_ids)
        check("query rejects __wfx non-digit suffix", "rY" not in hit_ids)
        check("query does NOT return unrelated rX", "rX" not in hit_ids)

    if hasattr(audit, "reply_references_mid"):
        docs = replies.find({})
        by_id = {r["_id"]: r for r in docs}
        check("r2 (batch) references m2 via array", audit.reply_references_mid(by_id["r2"], "m2"))
        check("r2 (batch) references m3 via array", audit.reply_references_mid(by_id["r2"], "m3"))
        check("r3 (wf scalar m1__wf0) references m1", audit.reply_references_mid(by_id["r3"], "m1"))
        check("r4 (scalar-only wf) references m4", audit.reply_references_mid(by_id["r4"], "m4"))
        check("rY (__wfx) does NOT reference m4", not audit.reply_references_mid(by_id["rY"], "m4"))
        check("r1 does not reference m2", not audit.reply_references_mid(by_id["r1"], "m2"))

    # Per-mid coverage must be non-empty for every member once fixed
    if hasattr(audit, "reply_references_mid"):
        docs = replies.find(audit.build_reply_query(mids))
        for m in ["m1", "m2", "m3"]:
            check(f"reply coverage for {m} non-empty",
                  any(audit.reply_references_mid(r, m) for r in docs))
        # unique-doc counting: unique reply docs counted by _id must be {r1,r2,r3,r4}
        # (m4 coverage comes only from r4 — the scalar-only wf reply)
        all_ids = {r["_id"] for r in docs}
        check("unique reply docs = 4 (no double-count per mid)", len(all_ids) == 4)
        check("m4 covered solely by scalar-only wf reply",
              [r["_id"] for r in docs if audit.reply_references_mid(r, "m4")] == ["r4"])

    failed = [n for n, ok in results if not ok]
    print(f"\n=== {len(results) - len(failed)} passed, {len(failed)} failed ===")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
