"""Phase 0 — gold replay baseline & failure ownership gate.

Replays docs/test/fixtures/legacy_turn_incidents.jsonl through the real legacy
pipeline at three levels, fully offline (no Mongo / LLM / network):

  L1  pure-owner: route_context.build_retrieval_profile / build_retrieval_slots /
      build_retrieval_relations, product_store.resolve_availability,
      handoffs.detect_human_request, guards.check_output on fixture data.
  L2  real-schema: fixture catalog docs (real ShpProducts field shapes:
      float item_id, model[].stock_info_v2, tier_variation, raw statuses)
      → resolve_availability + to_product_card + executor/selection contract.
  L3  chat() boundary: every user turn replays through app.chat() with
      monkeypatched DB/LLM/intent/web seams — captures exactly what reaches
      llm.answer (products, extra_context, history, call count, handoff).

Assertions are semantic (item_ids/statuses/actions), never LLM prose.

Fixture statuses:
  incident              reproduces offline at incident_levels → strict xfail;
                        an unexpected pass hard-fails so the flag must go once
                        the owner is fixed
  answer_level          prod incident lives past the LLM-input boundary →
                        runs as a positive contract, never counted as a
                        reproduced retrieval failure
  pending_live_replay   cannot reproduce honestly offline (e.g. real Mongo
                        recall) → skipped with reason
  positive              plain asserts, never xfail

Offline guarantee (Phase 0B): autouse tripwires fail loudly on
socket.connect, pymongo.MongoClient(), urllib.request.urlopen (unhandled
seam) and embedding._get_model (HF load). _install additionally pins
.env-inherited branches (engine envs, grouped flags, USE_UNIT_INDEX), stubs
embed_query/embed_texts deterministically, and captures handoff POSTs.
Integrity of every fixture row is enforced by
docs/test/validate_legacy_turn_fixtures.py — run it before trusting counts.

Run:  .venv/bin/python -m pytest docs/test/test_legacy_turn_incident_replay.py -v
"""
from __future__ import annotations

import io
import json
import os
import re
import socket
import sys
import urllib.request
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

# ── import-time offline boundary (Phase 0C) — must install BEFORE importing
# shopeechat: app.py runs load_dotenv() at module import. Neutralize dotenv,
# HF downloads, real sockets, Mongo clients and urlopen so collection itself
# cannot read .env credentials or touch network — never rely on _install ──
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
# non-credential config names the code reads at runtime — .env is suppressed
# so these must exist; values are fake and never reach a real client
# (MongoClient is tripwired below; _install replaces every cached client)
os.environ.setdefault("MONGO_DB", "dbWallet")
os.environ.setdefault("ADMIN_MONGO_DB", "chatbot_admin")


def _import_leak(what):  # pragma: no cover - fires only on a real leak
    raise RuntimeError(f"OFFLINE LEAK at import/collection: {what}")


import dotenv  # noqa: E402
import pymongo  # noqa: E402

# stubs live ONLY for the import block — restored in finally so no global
# patch leaks into the shared pytest process (finding A). Test-time
# protection stays in _offline_guard + _install.
_orig = (dotenv.load_dotenv, socket.socket.connect, urllib.request.urlopen,
         pymongo.MongoClient.__init__)
dotenv.load_dotenv = lambda *a, **k: False
socket.socket.connect = lambda self, addr: _import_leak(
    f"socket.connect({addr!r})")
urllib.request.urlopen = lambda *a, **k: _import_leak("urlopen")
pymongo.MongoClient.__init__ = lambda self, *a, **k: _import_leak(
    "pymongo.MongoClient()")
try:
    from shopeechat import app, conversation_products, embedding, guards, handoffs, llm  # noqa: E402
    from shopeechat import knowledge_base, order_store, persona, product_store  # noqa: E402
    from shopeechat import route_context, runtime_config, turn_decision, units, warranty_flow, web_search  # noqa: E402
    from shopeechat import intent_classifier  # noqa: E402
finally:
    (dotenv.load_dotenv, socket.socket.connect, urllib.request.urlopen,
     pymongo.MongoClient.__init__) = _orig
    # bound aliases: `from dotenv import load_dotenv` in app.py:18 /
    # knowledge_base.py:28 bound the stub lambda during import — restoring
    # the provider global is not enough; restore the aliases too so no
    # harness lambda survives anywhere
    if "app" in dir():
        app.load_dotenv = _orig[0]
    if "knowledge_base" in dir():
        knowledge_base.load_dotenv = _orig[0]

FIXTURES = ROOT / "docs" / "test" / "fixtures" / "legacy_turn_incidents.jsonl"


def _load_fixtures() -> list[dict]:
    return [json.loads(l) for l in FIXTURES.read_text().splitlines() if l.strip()]


ALL_FX = _load_fixtures()
L1_FX = [f for f in ALL_FX if 1 in f.get("levels", [])]
L2_FX = [f for f in ALL_FX if 2 in f.get("levels", [])]
L3_FX = [f for f in ALL_FX if 3 in f.get("levels", [])]


# ── fake mongo ───────────────────────────────────────────────────────────────

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


def _get_path(doc: dict, path: str):
    """Resolve a dotted Mongo path — returns (value, present). List fields
    descend into elements (Mongo array semantics → returns list of values)."""
    cur = doc
    for p in path.split("."):
        if isinstance(cur, list):
            cur = [x.get(p) for x in cur if isinstance(x, dict) and p in x]
            if not cur:
                return None, False
            continue
        if not isinstance(cur, dict) or p not in cur:
            return None, False
        cur = cur[p]
    return cur, True


def _match(doc: dict, filt: dict) -> bool:
    for k, cond in (filt or {}).items():
        if k == "$or":
            if not any(_match(doc, sub) for sub in cond):
                return False
            continue
        val, present = _get_path(doc, k) if "." in k else (doc.get(k), k in doc)
        vals = val if isinstance(val, list) else [val]  # array → any-element
        if isinstance(cond, dict):
            if "$in" in cond:
                if not any(_norm(v) in {_norm(x) for x in cond["$in"]}
                           for v in vals):
                    return False
            if "$regex" in cond:
                opts = cond.get("$options", "")
                flags = re.IGNORECASE if "i" in opts else 0
                if not any(re.search(cond["$regex"], str(v or ""), flags)
                           for v in vals):
                    return False
            if "$ne" in cond and any(
                    _norm(v) == _norm(cond["$ne"]) for v in vals):
                return False
            if "$exists" in cond and (val is not None) != bool(cond["$exists"]):
                return False
        else:
            if not any(_norm(v) == _norm(cond) for v in vals):
                return False
    return True


class _Cursor(list):
    def limit(self, n):
        return _Cursor(self[:n])

    def sort(self, *a, **k):
        return self

    def skip(self, n):
        return _Cursor(self[n:])


class FakeColl:
    """Minimal Mongo collection double — equality/$in/$regex filters, $set/$unset."""

    def __init__(self, docs=None):
        self._docs: list[dict] = [dict(d) for d in (docs or [])]
        self.database = None  # bound by FakeDb

    def find_one(self, filt=None, *a, **k):
        for d in self._docs:
            if _match(d, filt):
                return d
        return None

    def find(self, filt=None, *a, **k):
        return _Cursor([d for d in self._docs if _match(d, filt)])

    def count_documents(self, filt=None, *a, **k):
        return sum(1 for d in self._docs if _match(d, filt))

    def estimated_document_count(self):
        return len(self._docs)

    def aggregate(self, *a, **k):
        return iter(())

    def distinct(self, field, *a, **k):
        return list({d.get(field) for d in self._docs})

    def create_index(self, *a, **k):
        return None

    def update_one(self, filt, update, upsert=False, *a, **k):
        for d in self._docs:
            if _match(d, filt):
                self._apply(d, update)
                return SimpleNamespace(matched_count=1, upserted_id=None)
        if upsert:
            doc = {k: v for k, v in (filt or {}).items() if not k.startswith("$")}
            self._apply(doc, update)
            self._docs.append(doc)
            return SimpleNamespace(matched_count=0, upserted_id=len(self._docs))
        return SimpleNamespace(matched_count=0, upserted_id=None)

    @staticmethod
    def _apply(doc, update):
        for key, val in (update.get("$set") or {}).items():
            parts = key.split(".")
            tgt = doc
            for p in parts[:-1]:
                tgt = tgt.setdefault(p, {})
            tgt[parts[-1]] = val
        for key in update.get("$unset") or {}:
            doc.pop(key, None)

    def insert_one(self, doc, *a, **k):
        self._docs.append(dict(doc))
        return SimpleNamespace(inserted_id=len(self._docs))

    def delete_many(self, *a, **k):
        return SimpleNamespace(deleted_count=0)

    def update_many(self, filt, update, *a, **k):
        n = 0
        for d in self._docs:
            if _match(d, filt):
                self._apply(d, update)
                n += 1
        return SimpleNamespace(modified_count=n)


class FakeDb:
    def __init__(self, colls=None):
        self._colls: dict[str, FakeColl] = {}
        for name, docs in (colls or {}).items():
            self._colls[name] = FakeColl(docs)
            self._colls[name].database = self

    def __getitem__(self, name):
        if name not in self._colls:
            self._colls[name] = FakeColl()
            self._colls[name].database = self
        return self._colls[name]

    def list_collection_names(self):
        return list(self._colls)


class _AdminNs:
    def command(self, *a, **k):
        return {"ok": 1}


class FakeClient:
    """client[db_name] → FakeDb; client.admin.command('ping') works."""

    def __init__(self, dbs=None):
        self._dbs: dict[str, FakeDb] = dict(dbs or {})
        self.admin = _AdminNs()

    def __getitem__(self, name):
        return self._dbs.setdefault(name, FakeDb())


# ── offline tripwires ────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def _offline_guard(monkeypatch):
    """Fail loudly on any real network/DB/model-download attempt.

    `shopeechat.app` runs `load_dotenv()` at import — `.env` values enter the
    process and env-dependent branches (engine routing, grouped flags, unit
    index, embedding model) otherwise differ per machine. Nothing in this
    suite may open a socket; the only allowed 'network' call is the handoff
    urlopen seam, which _install replaces with a capture stub.
    """
    def _connect_guard(self, address):
        pytest.fail(f"OFFLINE LEAK: socket.connect({address!r}) — "
                    "real network/DB/HF access reached from tests",
                    pytrace=False)
    monkeypatch.setattr(socket.socket, "connect", _connect_guard)

    # any real MongoClient construction is a leak by definition — every
    # legit path is served by the patched cached clients in _install
    import pymongo
    def _client_init_guard(self, *a, **k):
        pytest.fail("OFFLINE LEAK: pymongo.MongoClient() constructed — "
                    "an unpatched client-builder path was reached",
                    pytrace=False)
    monkeypatch.setattr(pymongo.MongoClient, "__init__", _client_init_guard)

    def _urlopen_guard(req, *a, **k):
        pytest.fail(f"OFFLINE LEAK: urllib.request.urlopen("
                    f"{getattr(req, 'full_url', req)!r}) unhandled seam",
                    pytrace=False)
    monkeypatch.setattr(urllib.request, "urlopen", _urlopen_guard)

    def _dotenv_guard(*a, **k):
        pytest.fail("OFFLINE LEAK: load_dotenv() reached during tests — "
                    "real .env would be read", pytrace=False)
    # patch ALL bindings: `from dotenv import load_dotenv` in app.py /
    # knowledge_base.py creates module-level aliases — patching only
    # dotenv.load_dotenv would leave the aliases live (silent False stubs
    # would instead hide the leak, so this must fail fast)
    monkeypatch.setattr(dotenv, "load_dotenv", _dotenv_guard)
    monkeypatch.setattr(app, "load_dotenv", _dotenv_guard)
    monkeypatch.setattr(knowledge_base, "load_dotenv", _dotenv_guard)

    monkeypatch.setattr(embedding, "_get_model",
                        lambda *a, **k: pytest.fail(
                            "OFFLINE LEAK: embedding._get_model() — "
                            "HF model load reached from tests", pytrace=False))
    yield


# ── L3 harness: real chat() with stubbed seams ───────────────────────────────

ADMIN_DB = "chatbot_admin"
PRODUCT_DB = "dbWallet"
COLL = "ShpProducts"


class _CapturedLLM:
    """llm.answer* replacement — records inputs, returns canned reply."""

    def __init__(self, reply="รับทราบค่ะ เดี๋ยวเช็กให้นะคะ"):
        self.calls: list[dict] = []
        self.reply = reply

    def __call__(self, *args, **kwargs):
        fn = getattr(self, "_fn", "answer")
        # answer_general(message, context, qtype, ...) — arg1 is context,
        # not products; record it explicitly so policy-context probes work
        if fn == "answer_general":
            products = list(kwargs.get("products") or [])
            context = kwargs.get("context", args[1] if len(args) > 1 else None)
        elif fn == "answer_typed":
            # typed boundary: context = AnswerContext — scoped products live
            # on ctx.products (raw message/products never cross this seam)
            context = kwargs.get("context")
            products = list(getattr(context, "products", None) or ())
        else:
            products = list(kwargs.get("products")
                            or (args[1] if len(args) > 1 else []))
            context = kwargs.get("context")
        self.calls.append({
            "fn": fn,
            "message": kwargs.get("message", args[0] if args else None),
            "products": products,
            "context": context,
            "qtype": kwargs.get("qtype", args[2] if len(args) > 2 else None),
            "history": kwargs.get("history"),
            "extra_context": kwargs.get("extra_context"),
            "intent_result": kwargs.get("intent_result"),
        })
        return self.reply, {"prompt": 10, "output": 5, "total": 15}


def _fixture_dbs(fx: dict):
    """Build FakeClient wiring product db + admin db for one fixture.

    Every catalog doc is visible to the fake source — hiding docs to fake a
    recall miss is forbidden (validator enforces). A fixture that needs a
    real recall failure must be marked pending_live_replay instead.
    """
    docs = fx.get("catalog") or []
    proddb = FakeDb({COLL: docs})
    conv_id = fx.get("conversation_id") or f"fx-{fx['id']}"
    conv_docs = []
    if fx.get("timeline_seed") or fx.get("claim_state_seed"):
        seed = {
            "conversation_id": conv_id,
            "platform": fx.get("platform", "shopee"),
            "shop": fx.get("shop"),
            "products": (fx.get("timeline_seed") or {}).get("products", []),
            "active_item_id": (fx.get("timeline_seed") or {}).get("active_item_id"),
        }
        if fx.get("claim_state_seed"):
            seed["claim_state"] = fx["claim_state_seed"]
        conv_docs.append(seed)
    admindb = FakeDb({
        "conversation_products": conv_docs,
        "sellable_units": [],
        "system_configs": [],
        "shop_settings": fx.get("shop_settings_seed") or [],
        "status_conversation": [],
        "test_status_conversation": [],
        "test_chat_sessions": [],
        "image_texts": [],
        "knowledge_base": [],
        "qa_pairs": [],
    })
    return FakeClient({PRODUCT_DB: proddb, ADMIN_DB: admindb}), proddb, admindb


def _install(monkeypatch, fx: dict):
    """Wire all seams for one fixture. Returns (client, captured-llm, handoffs)."""
    client, proddb, admindb = _fixture_dbs(fx)
    captured = _CapturedLLM()
    handoff_calls: list[dict] = []

    monkeypatch.setattr(product_store, "_cached_client", client)
    monkeypatch.setattr(knowledge_base, "_cached_admin_client", client)
    monkeypatch.setattr(units, "_units_coll",
                        lambda snap=None: admindb["sellable_units"])
    monkeypatch.setattr(persona, "get_persona", lambda *a, **k: None)
    # remaining lazy client builders — pinned to the same fake so cert
    # (itStock), persona and order paths can never reach real Mongo
    monkeypatch.setattr(product_store, "_cached_stock_client", client)
    monkeypatch.setattr(persona, "_cached_admin_client", client)
    monkeypatch.setattr(order_store, "_ORDER_CLIENT", client)

    # ── env-pinned boundaries — .env is loaded at import; pin every
    # env-dependent branch so results don't depend on the host machine ──
    flags = fx.get("runtime_flags") or {}
    monkeypatch.setenv("USE_CHAT_V3", "0")
    monkeypatch.setenv("USE_LEGACY_CHAT", "1")
    monkeypatch.setenv("USE_UNIT_INDEX", "0")
    # ADMIN_MONGO_DB: .env overrides the module-level setdefault when a
    # sibling test file imported shopeechat.app first — re-pin per test so
    # _admin_db() routes to the seeded db, never an env-shadowed one
    monkeypatch.setenv("ADMIN_MONGO_DB", ADMIN_DB)
    monkeypatch.setenv("MONGO_DB", PRODUCT_DB)
    monkeypatch.setattr(runtime_config, "grouped_retrieval_shadow_enabled",
                        lambda: bool(flags.get("grouped_shadow", False)))
    monkeypatch.setattr(runtime_config,
                        "grouped_retrieval_selection_enabled",
                        lambda: bool(flags.get("grouped_selection", False)))
    # Phase 10A — global web-search operator toggle: pinned per fixture like
    # the grouped flags (default OFF; web_on fixtures set it true)
    _web_on = bool(flags.get("web_search"))
    monkeypatch.setattr(runtime_config, "web_search_enabled",
                        lambda: _web_on)

    # ── embedding boundary — bge-m3 (HF) behind embed_query; return a
    # deterministic zero vector so vector paths run their no-similarity
    # branches instead of downloading the model ──
    import numpy as _np
    _zero_vec = lambda *a, **k: _np.zeros(embedding.EMBEDDING_DIM,
                                          dtype=_np.float32)
    monkeypatch.setattr(embedding, "embed_query", _zero_vec)
    monkeypatch.setattr(embedding, "embed_texts",
                        lambda texts, *a, **k: _np.zeros(
                            (len(texts), embedding.EMBEDDING_DIM),
                            dtype=_np.float32))

    # ── handoff HTTP seam — warranty_flow/responses POST via urlopen
    # directly; allow ONLY the handoff endpoint (allowlist — any other URL
    # is an offline leak, never a silent capture) ──
    def _fake_urlopen(req, *a, **k):
        url = getattr(req, "full_url", str(req))
        if "bot-handoff" not in url:
            pytest.fail(f"OFFLINE LEAK: urlopen({url!r}) — not a handoff "
                        "endpoint (allowlist)", pytrace=False)
        try:
            payload = json.loads((req.data or b"{}").decode("utf-8"))
        except Exception:
            payload = {}
        handoff_calls.append({"url": url, "payload": payload})
        return io.BytesIO(b"{}")
    monkeypatch.setattr(urllib.request, "urlopen", _fake_urlopen)

    # intent classifier is LLM-backed — deterministic fixture injection
    # row-level default + optional per-turn override (turn["intent_result"],
    # keyed by message text — same structured boundary, zero extra calls)
    intent_result = dict(fx.get("intent_result") or
                         {"intent": "other", "confidence": 0.5})
    _turn_results = {
        t["text"]: dict(t["intent_result"])
        for t in fx.get("turns", []) if t.get("intent_result")
    }
    intent_calls: list[dict] = []

    def _fake_classify(message, history=None, shop=None):
        intent_calls.append({"message": message})
        return dict(_turn_results.get(message) or intent_result)

    monkeypatch.setattr(intent_classifier, "classify_intent", _fake_classify)
    captured.intent_calls = intent_calls

    # retrieval: serve collection docs as product cards (real to_product_card)
    shop = fx.get("shop")
    docs = [d for d in proddb[COLL]._docs
            if not shop or str(d.get("shopname", "")).lower() == shop.lower()]

    def _fake_fetch(db, message, shop_filter=None, limit=20, **kw):
        # shop boundary: empty filter or matching shop → fixture docs;
        # any other shop → [] — never leak cross-shop docs
        if shop_filter and (not shop or
                            shop_filter.lower() != shop.lower()):
            return []
        return [product_store.to_product_card(d, message) for d in docs[:limit]]

    monkeypatch.setattr(product_store, "fetch_products", _fake_fetch)

    # llm boundaries captured; fixture may pin a product-bearing canned
    # reply (Phase 5-R3: mixed composition must prove the product-owner
    # answer text survives the policy segment append at enforce)
    for name in ("answer", "answer_general", "answer_with_kb",
                 "answer_typed"):
        fn = getattr(llm, name, None)
        if fn is not None:
            cap = _CapturedLLM()
            cap._fn = name
            cap.calls = captured.calls  # share log across entry points
            if fx.get("llm_reply"):
                cap.reply = fx["llm_reply"]
            monkeypatch.setattr(llm, name, cap)

    # web search — OFF by default (provider call = hard fail); web_on
    # fixtures must supply web_result for search_and_extract
    monkeypatch.setattr(web_search, "is_configured", lambda: _web_on)
    monkeypatch.setattr(web_search, "should_use_web_search", lambda *a, **k: False)

    def _fake_web(*a, **k):
        if not _web_on or not isinstance(fx.get("web_result"), dict):
            pytest.fail("web_search called but web_search expected off",
                        pytrace=False)
        return dict(fx["web_result"])

    for name in ("search_and_extract", "reanswer", "search_and_answer"):
        if getattr(web_search, name, None) is not None:
            monkeypatch.setattr(web_search, name, _fake_web)

    # Phase 5 policy records — fixture-supplied versioned rules replace the
    # (empty) production seam for this turn only; fixtures without the key
    # keep the real (empty) source so production activation stays honest
    if fx.get("policy_records"):
        try:
            from shopeechat import policy_resolver
        except ImportError:
            pass  # module not implemented yet — policy_decision expectation fails downstream
        else:
            _rules = tuple(policy_resolver.policy_rule_from_dict(d)
                           for d in fx["policy_records"])
            monkeypatch.setattr(policy_resolver, "active_policy_rules",
                                lambda *a, **k: _rules)

    # orders
    orders = {str(o.get("order_sn")): o for o in (fx.get("orders") or [])}
    monkeypatch.setattr(order_store, "lookup_order",
                        lambda sn, shop_filter=None: orders.get(str(sn)))
    monkeypatch.setattr(order_store, "lookup_by_tracking",
                        lambda tn, shop_filter=None: None)

    # handoff POST seam — capture the call and report a confirmed outcome
    # (the transport's own bounded-retry/state parsing lives in
    # test_handoff_transport.py; here a stub success is the honest model)
    def _fake_send(req, ctx=None, *, reason="", **kw):
        handoff_calls.append({"reason": reason, "conversation_id":
                              getattr(req, "conversation_id", None)})
        return {"outcome": {"state": "assigned"}}
    monkeypatch.setattr(app, "_send_handoff", _fake_send)
    try:
        from shopeechat import responses as _resp_mod
        monkeypatch.setattr(_resp_mod, "_send_handoff", _fake_send)
    except Exception:
        pass

    return client, captured, handoff_calls


def _replay(monkeypatch, fx: dict):
    """Run all user turns through real chat(); return per-turn records."""
    client, captured, handoff_calls = _install(monkeypatch, fx)
    history = list(fx.get("history_extra") or [])
    records = []
    for turn in fx.get("turns", []):
        if turn.get("role", "user") != "user":
            history.append({"role": "model", "text": turn.get("text", "")})
            continue
        kwargs = dict(
            message=turn["text"], shop=fx.get("shop"),
            platform=fx.get("platform", "shopee"),
            history=list(history),
            conversation_id=fx.get("conversation_id"),
            ticket_state=turn.get("ticket_state", fx.get("ticket_state")),
            limit=5, simulate_assignment=True, test_source="phase0_replay",
        )
        if turn.get("item_id"):
            kwargs["item_id"] = turn["item_id"]
        n_calls = len(captured.calls)
        resp = app.chat(app.ChatRequest(**kwargs))
        new_calls = captured.calls[n_calls:]
        records.append({
            "turn": turn["text"], "resp": resp, "llm_calls": new_calls,
            "handoffs": list(handoff_calls),
        })
        history.append({"role": "user", "text": turn["text"]})
        history.append({"role": "model", "text": getattr(resp, "answer", "") or ""})
    return records, captured, client


def _card_ids(products: list[dict]) -> set[int]:
    return {_norm(p.get("item_id")) for p in products if p.get("item_id") is not None}


def _norm_set(ids) -> set:
    return {_norm(i) for i in (ids or [])}


def _llm_products(rec) -> list[dict]:
    """Flatten products seen by every llm call in the final turn."""
    out = []
    for c in rec["llm_calls"]:
        out.extend(c["products"])
    return out


# ── L1: pure-owner assertions ────────────────────────────────────────────────

def _profile_for(fx):
    return route_context.build_retrieval_profile(
        fx["turns"][-1]["text"],
        history=None,
        intent_result=fx.get("intent_result"),
        shop=fx.get("shop"),
        platform=fx.get("platform", "shopee"),
    )


def _allow_reversed(fx):
    """reversed-relation eligibility = typed TurnPlan productish need —
    derivation เดียวกับ retrieval_runtime callsite (fail closed เมื่อ plan
    raise หรือไม่มี productish need)"""
    try:
        needs = turn_decision.decide_turn(
            fx["turns"][-1]["text"], history=[],
            intent_result=fx.get("intent_result")).needs
    except Exception:
        return False
    return any(n.kind in ("product", "compare", "compat") for n in needs)


@pytest.mark.parametrize("fx", L1_FX, ids=[f["id"] for f in L1_FX])
def test_l1_profile_and_parse(fx):
    pe = fx.get("profile_expect") or {}
    se = fx.get("slot_expect") or {}
    if not pe and not se:
        pytest.skip("no L1 expectation")
    fails: list[str] = []
    prof = _profile_for(fx)
    if pe.get("product_types"):
        if not set(pe["product_types"]) <= set(prof.product_types):
            fails.append(f"types {set(prof.product_types)} missing "
                         f"{set(pe['product_types']) - set(prof.product_types)}")
    if pe.get("product_types_any"):
        for alt in pe["product_types_any"]:
            if not any(t in prof.product_types for t in alt):
                fails.append(f"types {set(prof.product_types)} missing any of {alt}")
    if pe.get("target_device"):
        if (prof.target_device or "").lower() != pe["target_device"].lower():
            fails.append(f"target_device={prof.target_device!r} want "
                         f"{pe['target_device']!r}")
    if pe.get("model_codes_absent"):
        bad = {c.replace(" ", "").lower() for c in prof.model_codes}
        for code in pe["model_codes_absent"]:
            if code.replace(" ", "").lower() in bad:
                fails.append(f"device alias {code!r} leaked into model_codes {bad}")
    if pe.get("compat_mode_in"):
        if prof.compat_mode not in pe["compat_mode_in"]:
            fails.append(f"compat_mode={prof.compat_mode!r}")

    if se:
        slots = route_context.build_retrieval_slots(prof)
        if se.get("min_slots") and len(slots) < se["min_slots"]:
            fails.append(f"slots {len(slots)} < {se['min_slots']}")
        if se.get("types_union"):
            got = set().union(*[set(s.product_types) for s in slots]) if slots else set()
            if not set(se["types_union"]) <= got:
                fails.append(f"slot types {got} missing "
                             f"{set(se['types_union']) - got}")
        if se.get("subtypes_union"):
            got = set().union(*[set(s.subtypes) for s in slots]) if slots else set()
            if not set(se["subtypes_union"]) <= got:
                fails.append(f"slot subtypes {got} missing "
                             f"{set(se['subtypes_union']) - got}")
        if se.get("relation"):
            rels = route_context.build_retrieval_relations(
                prof, slots, allow_reversed=_allow_reversed(fx))
            exp = se["relation"]
            hit = False
            for r in rels:
                src = next((s for s in slots if s.slot_id == r.source_slot_id), None)
                tgt = next((s for s in slots if s.slot_id == r.target_slot_id), None)
                src_types = set(src.product_types) if src else set()
                tgt_types = set(tgt.product_types) if tgt else set()
                if (set(exp["source_types"]) & src_types
                        and set(exp["target_types"]) & tgt_types
                        and {tuple(c) for c in (exp.get("constraints") or [])}
                        <= {tuple(c) for c in r.constraints}):
                    hit = True
            if not hit:
                fails.append(f"relation {exp} not found (rels={list(rels)})")
    _gate(fx, fails, level=1)


@pytest.mark.parametrize("fx", L1_FX, ids=[f["id"] for f in L1_FX])
def test_l1_owner_probes(fx):
    probe = fx.get("owner_probe")
    if not probe:
        pytest.skip("no owner probe")
    msg = fx["turns"][-1]["text"]
    if probe == "detect_human_request":
        # detection probe — decide_turn เจ้าของ decision; transport ไม่ re-detect
        out = (handoffs.is_human_request(msg)
               or handoffs.is_service_anger(msg))
        if fx["expected"]["action"] == "handoff":
            assert out, "expected handoff detection"
        else:
            assert not out, f"unexpected handoff detection"
    elif probe == "guards_spec_claim":
        # output boundary must flag spec claims not grounded in card context
        out = guards.check_output("ตัวนี้กันน้ำ IP68 นะคะ")
        assert isinstance(out, list)


# ── L2: real-schema availability + selection ─────────────────────────────────

@pytest.mark.parametrize("fx", L2_FX, ids=[f["id"] for f in L2_FX])
def test_l2_availability_schema(fx):
    ae = fx.get("availability_expect")
    if not ae:
        pytest.skip("no availability expectation")
    fails: list[str] = []
    doc_by_id = {_norm(d["item_id"]): d for d in fx.get("catalog") or []}
    for key, want in ae.items():
        iid_s, _, mid_s = key.partition(":")
        doc = doc_by_id.get(_norm(iid_s))
        assert doc is not None, f"catalog missing {iid_s}"
        mdoc = None
        if mid_s:
            mdoc = next((m for m in doc.get("model") or []
                         if _norm(m.get("model_id")) == _norm(mid_s)), None)
            assert mdoc is not None, f"model {mid_s} missing in {iid_s}"
        av = product_store.resolve_availability(doc, model_doc=mdoc)
        for f_name, want_val in want.items():
            if av.get(f_name) != want_val:
                fails.append(f"{key}.{f_name}={av.get(f_name)!r} want "
                             f"{want_val!r} (reason={av.get('reason')})")
    _gate(fx, fails, level=2)


def _card_group(d: dict) -> str | None:
    """canonical group of a catalog doc — charger-family subtype else
    product_type. Enumerates the production taxonomy (_SUBTYPE_TO_TYPES)
    and reuses the production per-subtype filter as detector — no copied
    keyword lists and no fixture-specific names."""
    hits = [s for s in units._SUBTYPE_TO_TYPES
            if product_store._filter_charger_subtype([d], s)]
    # production classify precedence: a "set" doc also satisfies the
    # adapter/cable filters (both return set items) — pick 'set' then
    if "set" in hits and set(hits) <= {"set", "adapter", "cable"}:
        return "set"
    if hits:
        return hits[0]
    det = product_store._detect_product_types(d.get("item_name") or "")
    return next(iter(sorted(det)), None)


def _request_covers(req, group: str) -> bool:
    """request covers a product_type / subtype / unit type group."""
    from shopeechat.units import _SUBTYPE_TO_TYPES
    eff = set(req.product_types) | set(req.subtypes)
    for s in req.subtypes:
        eff |= _SUBTYPE_TO_TYPES.get(s, set())
    return group in eff


def _l2_run(fx, drop_group_pred=None):
    """L2 contract harness: planner requests → executor._bucket per request
    → build_candidate_pool → select_for_llm_context.

    Scope honesty: this exercises planner + bucketing + pool + selection
    contracts. It does NOT cover the public executor entry point or the
    source adapters (unit fetch / legacy fetch / KB / anchors) — those are
    seams with their own queries; fixture docs are injected post-fetch.
    Returns (requests, SelectionResult, pool)."""
    from shopeechat import candidate_pool, retrieval_executor
    from shopeechat import retrieval_planner, retrieval_policy
    from shopeechat import retrieval_selection

    msg = fx["turns"][-1]["text"]
    prof = _profile_for(fx)
    slots = route_context.build_retrieval_slots(prof)
    rels = route_context.build_retrieval_relations(
        prof, slots, allow_reversed=_allow_reversed(fx))
    reqs = retrieval_planner.build_grouped_retrieval_requests(prof, slots, rels)
    docs = [d for d in (fx.get("catalog") or [])
            if not (drop_group_pred and drop_group_pred(_card_group(d)))]
    results = []
    for req in reqs:
        elig, unav, rej = [], [], []
        for d in docs:
            card = product_store.to_product_card(d, msg)
            sub = _card_group(d)
            if sub and sub not in (card.get("product_type"),):
                # unit cards carry subtype fields — annotate the fixture card
                # the same way so selection's per-subtype coverage sees it
                card.setdefault("charger_subtype", sub)
            # executor contract: canonicalize ก่อน bucket เสมอ
            ec = retrieval_policy.make_evidence_card(card, source="fixture")
            b, why = retrieval_executor._bucket(ec, req)
            ec["_selection_reason"] = why
            (elig if b == "eligible" else
             unav if b == "unavailable" else rej).append(ec)
        results.append(retrieval_executor.RetrievalExecutionResult(
            request_id=req.request_id, source=req.source,
            slot_id=req.slot_id, relation_id=req.relation_id,
            subtypes=req.subtypes, model_codes=req.model_codes,
            target_device=req.target_device,
            eligible_candidates=tuple(elig),
            unavailable_evidence=tuple(unav),
            rejected_evidence=tuple(rej)))
    pool = candidate_pool.build_candidate_pool(tuple(results), profile=prof)
    return reqs, retrieval_selection.select_for_llm_context(pool, reqs, prof), pool


def _l2_fails(fx, reqs, result, pool) -> list[str]:
    se = fx.get("selection_expect") or {}
    fails: list[str] = []
    sel_ids = {_norm(c.card.get("item_id")) for c in result.selected
               if c.card.get("item_id") is not None}
    if "selected_item_ids" in se:
        if sel_ids != _norm_set(se["selected_item_ids"]):
            fails.append(f"selected {sorted(sel_ids)} want "
                         f"{sorted(_norm_set(se['selected_item_ids']))}")
    if "unavailable_item_ids" in se:
        got_un = {_norm(u.get("item_id") or (u.get("card") or {}).get("item_id"))
                  for u in (result.unavailable_evidence or [])}
        if not _norm_set(se["unavailable_item_ids"]) <= got_un:
            fails.append(f"unavailable evidence {got_un} missing "
                         f"{_norm_set(se['unavailable_item_ids']) - got_un}")
    rtc = se.get("request_type_coverage")
    if rtc:
        req_by_id = {r.request_id: r for r in reqs}
        picked_by_req = {
            rid: {_norm(c.card.get("item_id")) for c in picked}
            for rid, picked in result.by_request}
        pooled_subs = {
            rid: {c.subtype for c in cs if c.subtype}
            for rid, cs in pool.by_request}
        for key, want in rtc.items():
            owners = [r.request_id for r in reqs
                      if _request_covers(r, key)]
            if not owners:
                fails.append(f"coverage {key!r}: no request owns the type")
                continue
            got = set().union(*(picked_by_req.get(rid, set())
                                for rid in owners))
            miss = _norm_set(want) - got
            if miss:
                fails.append(f"request coverage {key!r} missing "
                             f"{sorted(miss)} (selected {sorted(got)})")
        # per-request quota: a requested subtype with eligible candidates
        # keeps >=1 seat — another type must not eat its quota
        for rid, picked in result.by_request:
            req = req_by_id[rid]
            want_subs = req.subtypes & pooled_subs.get(rid, set())
            picked_subs = {(c.card.get("charger_subtype")
                            or c.card.get("cable_subtype"))
                           for c in picked}
            starved = want_subs - picked_subs
            if starved:
                fails.append(f"{rid}: subtypes {sorted(starved)} starved "
                             f"by quota (picked subs {sorted(picked_subs - {None})})")
            # isolation: picked cards must belong to this request's scope
            for c in picked:
                grp = (c.card.get("charger_subtype")
                       or c.card.get("cable_subtype")
                       or c.card.get("product_type"))
                if grp and not _request_covers(req, grp):
                    fails.append(f"{rid}: card {c.card.get('item_id')} "
                                 f"group={grp} outside request scope")
    return fails


@pytest.mark.parametrize("fx", L2_FX, ids=[f["id"] for f in L2_FX])
def test_l2_selection_contract(fx):
    if not fx.get("selection_expect"):
        pytest.skip("no selection expectation")
    reqs, result, pool = _l2_run(fx)
    _gate(fx, _l2_fails(fx, reqs, result, pool), level=2)


def _group_under_key(key: str, group: str | None) -> bool:
    """doc group belongs to a coverage key (type↔subtype↔unit-type)."""
    if not group:
        return False
    if group == key:
        return True
    from shopeechat.units import _SUBTYPE_TO_TYPES
    return (key in _SUBTYPE_TO_TYPES.get(group, set())
            or group in _SUBTYPE_TO_TYPES.get(key, set()))


def test_l2_selection_quota_negative_control():
    """negative control: removing a coverage group's candidates must break
    request_type_coverage for THAT key — proves the per-request assertion is
    not vacuous (a candidate of another type must not silently fill quota)."""
    fx = next((f for f in ALL_FX
               if (f.get("selection_expect") or {}).get(
                   "request_type_coverage")), None)
    assert fx, "no fixture with request_type_coverage — control has no target"
    reqs, result, pool = _l2_run(fx)
    base = _l2_fails(fx, reqs, result, pool)
    assert not base, f"baseline must be clean before mutation: {base}"
    for key in fx["selection_expect"]["request_type_coverage"]:
        reqs, result, pool = _l2_run(
            fx, drop_group_pred=lambda g: _group_under_key(key, g))
        fails = _l2_fails(fx, reqs, result, pool)
        want = f"request coverage {key!r} missing"
        assert any(want in f for f in fails), (
            f"dropping group under {key!r} did not fail on that key — "
            f"fails={fails}")


# ── L3: chat() boundary replay ───────────────────────────────────────────────

def _expectations_met(fx, records, captured):
    """Semantic assertions on the FINAL turn. Returns list of failure strings."""
    fails: list[str] = []
    if not records:
        return ["no turns"]
    rec = records[-1]
    resp = rec["resp"]
    exp = fx.get("expected") or {}
    products = _llm_products(rec)
    ids = _card_ids(products)

    # execution mode — honest flag coverage: fixtures without runtime_flags
    # are legacy_flag_off. chat_engine=="legacy" proves the response came from
    # the legacy engine flag path — it does NOT prove every source adapter
    # (units/legacy products/KB/anchors) executed on that turn.
    mode = ("grouped_selection_on"
            if (fx.get("runtime_flags") or {}).get("grouped_selection")
            else "legacy_flag_off")
    if mode == "legacy_flag_off" and getattr(resp, "chat_engine", "") != "legacy":
        fails.append(f"flag-off fixture ran engine="
                     f"{getattr(resp, 'chat_engine', None)!r} want 'legacy'")

    action = exp.get("action")
    if action == "locked":
        # ⚡ 2B.5 boundary fix — "locked" = wait-only state, NOT a handoff
        #   command: handoff_to_admin/handoff_reason/routing-path="handoff"
        #   all mean "perform a new handoff" downstream — must stay clean.
        if getattr(resp, "handoff_to_admin", False):
            fails.append("locked response must not signal handoff_to_admin")
        if getattr(resp, "handoff_reason", None) is not None:
            fails.append(f"locked handoff_reason="
                         f"{getattr(resp, 'handoff_reason', None)!r} want None")
        _rd = getattr(resp, "routing_decision", None) or {}
        if _rd.get("path") != "human_wait":
            fails.append(f"locked routing path={_rd.get('path')!r} "
                         "want 'human_wait'")
        if rec["llm_calls"]:
            fails.append(f"llm called {len(rec['llm_calls'])}x during lock")
        _prev_h = records[-2]["handoffs"] if len(records) > 1 else []
        if len(rec["handoffs"]) != len(_prev_h):
            fails.append("handoff POST fired during locked turn")
    elif action == "handoff":
        if not getattr(resp, "handoff_to_admin", False):
            fails.append("expected handoff_to_admin")
        hr = exp.get("handoff_reason")
        if hr and getattr(resp, "handoff_reason", None) != hr:
            fails.append(f"handoff_reason={getattr(resp, 'handoff_reason', None)!r}")
    elif action == "answer":
        if getattr(resp, "handoff_to_admin", False):
            fails.append("expected answer but response handed off")
        if not (getattr(resp, "answer", "") or "").strip():
            fails.append("expected bot answer but resp.answer is empty")
    elif action == "no_reply":
        # ⚡ Phase 2C.3 — TurnPlan no_reply = noise/placeholder turn:
        #   ไม่ตอบ ไม่เรียก LLM ไม่ handoff (bot silent โดยเจตนา)
        if getattr(resp, "handoff_to_admin", False):
            fails.append("no_reply response must not signal handoff_to_admin")
        if (getattr(resp, "answer", "") or "").strip():
            fails.append("expected empty answer for no_reply turn")
        if rec["llm_calls"]:
            fails.append(f"llm called {len(rec['llm_calls'])}x during no_reply")
    elif action == "claim_collect":
        claim = conversation_products.load_claim_state(fx.get("conversation_id"))
        if not claim:
            fails.append("action=claim_collect but no claim_state persisted")
    if "claim_state_exists" in exp:
        _exists = bool(conversation_products.load_claim_state(
            fx.get("conversation_id")))
        if _exists != bool(exp["claim_state_exists"]):
            fails.append(f"claim_state_exists: got {_exists} "
                         f"want {exp['claim_state_exists']}")
    elif action == "order_info":
        if getattr(resp, "handoff_to_admin", False):
            fails.append("order lookup unexpectedly handed off")

    # final_claim_state is an independent post-state assertion — it runs
    # for EVERY action (handoff/answer/…), not only claim_collect; a
    # None value asserts the key is absent in persisted state
    fcs = exp.get("final_claim_state")
    if fcs:
        claim = conversation_products.load_claim_state(
            fx.get("conversation_id"))
        for k, v in fcs.items():
            if not claim or claim.get(k) != v:
                fails.append(f"claim_state.{k}={claim and claim.get(k)!r} "
                             f"want {v!r}")

    if "llm_max_calls" in exp and len(rec["llm_calls"]) > exp["llm_max_calls"]:
        fails.append(f"llm_calls={len(rec['llm_calls'])} > {exp['llm_max_calls']}")
    if "llm_item_ids" in exp:
        want = _norm_set(exp["llm_item_ids"])
        if not want <= ids:
            fails.append(f"llm products {sorted(ids)} missing {sorted(want - ids)}")
    if "llm_item_ids_any_of" in exp:
        if not any(_norm_set(g) & ids for g in exp["llm_item_ids_any_of"]):
            fails.append(f"llm products {sorted(ids)} hit none of "
                         f"{exp['llm_item_ids_any_of']}")
    if "llm_must_not_item_ids" in exp and exp["llm_must_not_item_ids"]:
        bad = _norm_set(exp["llm_must_not_item_ids"]) & ids
        if bad:
            fails.append(f"forbidden items in llm input: {sorted(bad)}")
    # link_policy — checked at the LLM-INPUT boundary (product cards sent to
    # the LLM); the prose/link text itself is answer-level and out of reach
    # for the offline suite. Both policies require the llm input to contain
    # only subject products — no unrelated cards may be introduced.
    lp = exp.get("link_policy")
    if lp in ("links_only_for_subject_products",
              "subject_kept_link_may_be_cut"):
        subjects = _norm_set(exp.get("llm_item_ids"))
        extra = ids - subjects
        if extra:
            fails.append(f"link_policy={lp}: non-subject products in llm "
                         f"input {sorted(extra)} (subjects={sorted(subjects)})")
    if exp.get("llm_card_status"):
        for iid, statuses in exp["llm_card_status"].items():
            hit = False
            for p in products:
                if _norm(p.get("item_id")) == _norm(iid):
                    hit = True
                    if p.get("catalog_status") not in statuses:
                        fails.append(f"card {iid} catalog_status="
                                     f"{p.get('catalog_status')!r} want {statuses}")
            if not hit:
                fails.append(f"llm_card_status item {iid} absent from "
                             "llm input")
    if exp.get("llm_history_or_context_contains"):
        blob = json.dumps(
            [{"h": c["history"], "x": c["extra_context"]} for c in rec["llm_calls"]],
            ensure_ascii=False, default=str)
        for needle in exp["llm_history_or_context_contains"]:
            if needle not in blob:
                fails.append(f"llm input missing {needle!r}")
    if exp.get("policy_decision"):
        # Phase 5-R1 — the typed PolicyDecision must reach the answer
        # boundary as data (routing_decision), not only marker text in
        # the LLM prompt. Assert outcome (+ matched rules when pinned)
        # on the boundary object; the context marker is kept as a
        # phrasing aid and asserted too.
        pde = exp["policy_decision"]
        rd_pdec = ((getattr(resp, "routing_decision", None) or {})
                   .get("policy_decision") or {})
        if rd_pdec.get("outcome") != pde["outcome"]:
            fails.append(
                f"policy_decision outcome={pde['outcome']!r} absent from "
                f"routing_decision (got {rd_pdec.get('outcome')!r})")
        for rid in pde.get("matched_rule_ids") or []:
            if rid not in (rd_pdec.get("matched_rule_ids") or ()):
                fails.append(
                    f"policy rule {rid!r} absent from routing_decision")
    # Phase 5-R3 — final answer content assertions: product-owner text and
    # the deterministic policy segment must both survive composition;
    # the eligibility marker/prose must never reach the product LLM.
    _ans = getattr(resp, "answer", "") or ""
    for needle in exp.get("answer_contains") or []:
        if needle not in _ans:
            fails.append(f"answer missing {needle!r} (got {_ans!r})")
    for needle in exp.get("answer_contains_once") or []:
        if _ans.count(needle) != 1:
            fails.append(f"answer must contain {needle!r} exactly once "
                         f"(count={_ans.count(needle)})")
    for needle in exp.get("answer_must_not_contain") or []:
        if needle in _ans:
            fails.append(f"answer must not contain {needle!r} "
                         f"(got {_ans!r})")
    if exp.get("llm_must_not_contain"):
        blob = json.dumps(
            [{"h": c["history"], "x": c["extra_context"],
              "c": c["context"]}
             for c in rec["llm_calls"]],
            ensure_ascii=False, default=str)
        for needle in exp["llm_must_not_contain"]:
            if needle in blob:
                fails.append(f"llm input must not contain {needle!r}")
    if exp.get("resp_source"):
        _src = getattr(resp, "source", "") or ""
        if not _src.startswith(exp["resp_source"]):
            fails.append(f"resp.source {_src!r} not under "
                         f"{exp['resp_source']!r}")
    if exp.get("llm_general_qtype"):
        qts = {c.get("qtype") for c in rec["llm_calls"]
               if c.get("fn") == "answer_general"}
        if not (qts & set(exp["llm_general_qtype"])):
            fails.append(f"no answer_general call with qtype in "
                         f"{exp['llm_general_qtype']} (got {sorted(qts)})")
    if exp.get("llm_forbidden_card_types"):
        for p in products:
            name = str(p.get("name") or "") + str(p.get("category") or "")
            for t in exp["llm_forbidden_card_types"]:
                if t in name.lower():
                    fails.append(f"forbidden type {t} card: {p.get('name')!r}")
    if "resp_max_products" in exp:
        n = len(getattr(resp, "products", None) or [])
        if n > exp["resp_max_products"]:
            fails.append(f"resp products={n} > {exp['resp_max_products']}")
    if "web_search" in exp:
        got_ws = bool(getattr(resp, "web_search_used", False))
        if got_ws != bool(exp["web_search"]):
            fails.append(f"web_search_used={got_ws} want {exp['web_search']}")
    return fails


def _gate(fx, fails, level: int):
    """Result gate per level, by fixture status:
    - incident + incident_level → xfail with owner+evidence; unexpected pass
      → hard fail (forces flag removal once the owner is fixed)
    - answer_level → incident whose symptom lives past the LLM-input boundary
      (offline suite cannot reach it) → run as a positive contract, never
      counted as a reproduced retrieval failure
    - pending_live_replay → cannot prove offline honestly (e.g. real Mongo
      recall) → skip with reason, never counted as reproduced
    - positive → plain assert.
    """
    status = fx.get("status")
    if status == "pending_live_replay":
        pytest.skip(f"pending_live_replay owner={fx.get('expected_owner')} — "
                    f"{fx.get('pending_reason', 'needs live source')}")
    if status == "incident" and level in fx.get(
            "incident_levels", fx.get("levels", [])):
        if fails:
            pytest.xfail(f"known incident owner={fx.get('expected_owner')} — "
                         + " ; ".join(fails))
        pytest.fail("incident unexpectedly passed at this level — remove "
                    "status=incident or tighten expectations", pytrace=False)
    assert not fails, " | ".join(fails)


@pytest.mark.parametrize("fx", L3_FX, ids=[f["id"] for f in L3_FX])
def test_l3_chat_boundary(monkeypatch, fx):
    records, captured, client = _replay(monkeypatch, fx)
    fails = _expectations_met(fx, records, captured)
    _gate(fx, fails, level=3)


# ── Phase 2B.5: ticket-close/lock safety — episode identity, not just action ──

_P2B5_SHOP = "KingGadgets"


def _p2b5_fx(**over):
    fx = {"id": "p2b5-dedicated", "shop": _P2B5_SHOP, "platform": "shopee",
          "conversation_id": "fx-conv-p2b5-ded", "catalog": [],
          "status": "positive", "levels": [3],
          "intent_result": {"intent": "other", "confidence": 0.5},
          "turns": []}
    fx.update(over)
    return fx


def test_p2b5_closed_greeting_no_post_same_episode(monkeypatch):
    """closed→bot + collecting claim + greeting → normal answer, ZERO new
    handoff POST, same episode_id/stage — ticket close must not resolve,
    cancel, duplicate, or re-escalate the claim episode."""
    seed = {"stage": "collecting", "episode_id": "ep-keep",
            "customer_name": "สมชาย ใจดี"}
    fx = _p2b5_fx(
        conversation_id="fx-conv-p2b5-keep", ticket_state="closed",
        claim_state_seed=seed,
        turns=[{"role": "model",
                "text": "รับทราบค่ะ เดี๋ยวแอดมินดูแลเรื่องเคลมต่อนะคะ"},
               {"text": "สวัสดีครับ"}])
    records, _cap, _client = _replay(monkeypatch, fx)
    resp = records[-1]["resp"]
    assert not getattr(resp, "handoff_to_admin", False), \
        "closed-ticket greeting must answer, not hand off"
    assert records[-1]["handoffs"] == [], \
        f"no new handoff POST during lock-free turn: {records[-1]['handoffs']}"
    claim = conversation_products.load_claim_state("fx-conv-p2b5-keep")
    assert claim and claim.get("episode_id") == "ep-keep"
    assert claim.get("stage") == "collecting"
    assert claim.get("customer_name") == "สมชาย ใจดี"


def test_p2b5_active_handoff_locks_and_writes_nothing(monkeypatch):
    """open ticket + collecting claim + claim-field message → wait-admin
    lock: no new POST, no claim write, episode untouched."""
    seed = {"stage": "collecting", "episode_id": "ep-lock",
            "customer_name": "สมชาย ใจดี"}
    fx = _p2b5_fx(
        conversation_id="fx-conv-p2b5-lock", ticket_state="open",
        claim_state_seed=seed,
        turns=[{"text": "0812345678"}])
    records, _cap, _client = _replay(monkeypatch, fx)
    resp = records[-1]["resp"]
    # ⚡ wait-only contract: lock ≠ handoff command — flag/reason/path must
    #   stay clean so downstream callers cannot re-fire a handoff
    assert resp.handoff_to_admin is False
    assert resp.handoff_reason is None
    assert (resp.routing_decision or {}).get("path") == "human_wait"
    assert records[-1]["handoffs"] == [], "lock must not POST again"
    claim = conversation_products.load_claim_state("fx-conv-p2b5-lock")
    assert claim and claim.get("episode_id") == "ep-lock"
    assert claim.get("stage") == "collecting"
    assert claim.get("customer_name") == "สมชาย ใจดี"
    assert not claim.get("customer_phone"), \
        "locked turn must not write claim fields"


def test_p2b5_double_close_idempotent(monkeypatch):
    """close twice (two greeting turns under closed) → both answer normally,
    zero POSTs, episode stable across both."""
    seed = {"stage": "collecting", "episode_id": "ep-dbl"}
    fx = _p2b5_fx(
        conversation_id="fx-conv-p2b5-dbl", ticket_state="closed",
        claim_state_seed=seed,
        turns=[{"role": "model",
                "text": "รับทราบค่ะ เดี๋ยวแอดมินดูแลเรื่องเคลมต่อนะคะ"},
               {"text": "สวัสดีครับ"},
               {"text": "สวัสดีครับ"}])
    records, _cap, _client = _replay(monkeypatch, fx)
    for i, rec in enumerate(records):
        assert not getattr(rec["resp"], "handoff_to_admin", False), \
            f"turn {i} must answer, not hand off"
        assert rec["handoffs"] == [], f"turn {i} posted handoff"
    claim = conversation_products.load_claim_state("fx-conv-p2b5-dbl")
    assert claim and claim.get("episode_id") == "ep-dbl"
    assert claim.get("stage") == "collecting"


def test_p2b5_handoff_failure_then_close_keeps_episode(monkeypatch):
    """Failed claim handoff POST (transport down) must not resolve the
    claim; admin closing afterwards must not erase/restart the episode."""
    client, captured, handoff_calls = _install(monkeypatch, _p2b5_fx(
        conversation_id="fx-conv-p2b5-fail", ticket_state="bot",
        claim_state_seed={"stage": "collecting", "episode_id": "ep-fail"}))
    # turn 1: claim field arrives but the handoff POST fails (transport owner
    # stub → None). The merge must still persist the field.
    monkeypatch.setattr(app, "_send_handoff", lambda *a, **k: None)
    from shopeechat import responses as _resp_mod
    monkeypatch.setattr(_resp_mod, "_send_handoff", lambda *a, **k: None)
    history: list = []
    resp1 = app.chat(app.ChatRequest(
        message="0812345678", shop=_P2B5_SHOP, platform="shopee",
        history=list(history), conversation_id="fx-conv-p2b5-fail",
        ticket_state="bot", limit=5, simulate_assignment=True,
        test_source="phase2b5"))
    claim = conversation_products.load_claim_state("fx-conv-p2b5-fail")
    assert claim and claim.get("episode_id") == "ep-fail"
    assert claim.get("customer_phone") == "0812345678", \
        "field merge must persist even when the handoff POST fails"
    history += [{"role": "user", "text": "0812345678"},
                {"role": "model", "text": getattr(resp1, "answer", "") or ""},
                {"role": "model",
                 "text": "รับทราบค่ะ เดี๋ยวแอดมินดูแลเรื่องเคลมต่อนะคะ"}]
    # turn 2: restore a RECORDING success stub first — a re-escalating POST
    # (BUG-D) must show up in handoff_calls and flip handoff_to_admin.
    def _cap_send(req, ctx=None, *, reason="", **kw):
        handoff_calls.append({"reason": reason})
        return {"outcome": {"state": "assigned"}}
    monkeypatch.setattr(app, "_send_handoff", _cap_send)
    monkeypatch.setattr(_resp_mod, "_send_handoff", _cap_send)
    resp2 = app.chat(app.ChatRequest(
        message="สวัสดีครับ", shop=_P2B5_SHOP, platform="shopee",
        history=list(history), conversation_id="fx-conv-p2b5-fail",
        ticket_state="closed", limit=5, simulate_assignment=True,
        test_source="phase2b5"))
    assert not getattr(resp2, "handoff_to_admin", False), \
        "post-close greeting must not re-escalate"
    assert handoff_calls == [], \
        f"no handoff POST may fire on the closed+greeting turn: {handoff_calls}"
    claim = conversation_products.load_claim_state("fx-conv-p2b5-fail")
    assert claim and claim.get("episode_id") == "ep-fail"
    assert claim.get("stage") == "collecting"
    assert claim.get("customer_phone") == "0812345678"


def test_p2b5_stale_field_replay_same_episode(monkeypatch):
    """closed ticket + collecting claim + re-sending an already-stored field
    → merges into the SAME episode (no duplicate/restart)."""
    seed = {"stage": "collecting", "episode_id": "ep-stale",
            "customer_phone": "0812345678"}
    fx = _p2b5_fx(
        conversation_id="fx-conv-p2b5-stale", ticket_state="closed",
        claim_state_seed=seed,
        turns=[{"role": "model",
                "text": "รับทราบค่ะ เดี๋ยวแอดมินดูแลเรื่องเคลมต่อนะคะ"},
               {"text": "0812345678"}],
        synthetic_pii=["phone"])
    records, _cap, _client = _replay(monkeypatch, fx)
    claim = conversation_products.load_claim_state("fx-conv-p2b5-stale")
    assert claim and claim.get("episode_id") == "ep-stale", \
        "re-sending a stored field must stay in the same episode"
    assert claim.get("customer_phone") == "0812345678"
    assert claim.get("stage") == "collecting"


# ── Phase 2B.5 boundary correction — single lock owner at /chat entry ────────

def _assert_wait_only(resp):
    """Wait-only contract — downstream callers branch on these fields:
    handoff_to_admin/reason/routing-path mean "perform a NEW handoff",
    never "already human-owned"."""
    assert resp.handoff_to_admin is False
    assert resp.handoff_reason is None
    assert (resp.routing_decision or {}).get("path") == "human_wait"
    assert "รอการติดต่อกลับ" in (resp.answer or ""), \
        "lock must keep the wait-admin answer"


def test_p2b5_wait_response_is_not_handoff_command(monkeypatch):
    """R1 — active ticket → wait-admin answer with ZERO handoff-command
    fields; no POST, no claim write, no LLM call."""
    _client, captured, handoff_calls = _install(monkeypatch, _p2b5_fx(
        conversation_id="fx-conv-p2b5-wait", ticket_state="handoff",
        claim_state_seed={"stage": "collecting", "episode_id": "ep-wait"}))
    resp = app.chat(app.ChatRequest(
        message="สวัสดีครับ", shop=_P2B5_SHOP, platform="shopee",
        history=[], conversation_id="fx-conv-p2b5-wait",
        ticket_state="handoff", limit=5, test_source="phase2b5"))
    _assert_wait_only(resp)
    assert handoff_calls == [], "waiting state must not POST a new handoff"
    assert captured.calls == [], "lock must not spend LLM calls"
    claim = conversation_products.load_claim_state("fx-conv-p2b5-wait")
    assert claim and claim.get("episode_id") == "ep-wait"
    assert claim.get("stage") == "collecting"


def test_p2b5_v2_image_never_reaches_vision(monkeypatch):
    """R3 — use_v2 + active ticket + image → lock fires at /chat BEFORE v2
    dispatch: chat_v2 never entered, describe_images never called."""
    _client, captured, handoff_calls = _install(monkeypatch, _p2b5_fx(
        conversation_id="fx-conv-p2b5-v2img", ticket_state="open"))
    from shopeechat import chat_v2 as _cv2
    v2_calls, vision_calls = [], []
    monkeypatch.setattr(_cv2, "chat_v2",
                        lambda *a, **k: v2_calls.append(a) or {})
    monkeypatch.setattr(llm, "describe_images",
                        lambda *a, **k: vision_calls.append(a) or "")
    resp = app.chat(app.ChatRequest(
        message="[รูปภาพ]", shop=_P2B5_SHOP, platform="shopee",
        images=["https://img.example/x.jpg"], use_v2=True,
        history=[], conversation_id="fx-conv-p2b5-v2img",
        ticket_state="open", limit=5, test_source="phase2b5"))
    _assert_wait_only(resp)
    assert v2_calls == [], "active ticket must not reach chat_v2"
    assert vision_calls == [], "active ticket must not spend vision calls"
    assert captured.calls == []
    assert handoff_calls == []


def test_p2b5_v3_never_dispatched_when_locked(monkeypatch):
    """R4 — use_v3 + active ticket → lock fires before v3 dispatch."""
    _client, captured, handoff_calls = _install(monkeypatch, _p2b5_fx(
        conversation_id="fx-conv-p2b5-v3", ticket_state="pending"))
    from shopeechat import chatbotv3
    v3_calls = []
    monkeypatch.setattr(chatbotv3, "chat_v3",
                        lambda *a, **k: v3_calls.append(a) or {})
    resp = app.chat(app.ChatRequest(
        message="สวัสดีครับ", shop=_P2B5_SHOP, platform="shopee",
        use_v3=True, history=[], conversation_id="fx-conv-p2b5-v3",
        ticket_state="pending", limit=5, test_source="phase2b5"))
    _assert_wait_only(resp)
    assert v3_calls == [], "active ticket must not reach chatbotv3"
    assert handoff_calls == []


def test_p2b5_closed_states_still_dispatch_engines(monkeypatch):
    """R4 control — closed/resolved/bot bypass the lock: v2 and v3
    dispatch normally."""
    _client, _cap, _hc = _install(monkeypatch, _p2b5_fx(
        conversation_id="fx-conv-p2b5-disp", ticket_state="bot"))
    from shopeechat import chatbotv3
    from shopeechat import chat_v2 as _cv2
    v2_calls, v3_calls = [], []
    monkeypatch.setattr(
        _cv2, "chat_v2",
        lambda *a, **k: v2_calls.append(a) or {
            "answer": "v2-ok", "products": [], "shop": _P2B5_SHOP,
            "model": "stub"})
    monkeypatch.setattr(
        chatbotv3, "chat_v3",
        lambda *a, **k: v3_calls.append(a) or {
            "answer": "v3-ok", "products": [], "shop": _P2B5_SHOP,
            "model": "stub"})
    for state in ("closed", "resolved", "bot"):
        app.chat(app.ChatRequest(
            message="สวัสดีครับ", shop=_P2B5_SHOP, platform="shopee",
            use_v2=True, history=[], conversation_id="fx-conv-p2b5-disp",
            ticket_state=state, limit=5, test_source="phase2b5"))
        app.chat(app.ChatRequest(
            message="สวัสดีครับ", shop=_P2B5_SHOP, platform="shopee",
            use_v3=True, history=[], conversation_id="fx-conv-p2b5-disp",
            ticket_state=state, limit=5, test_source="phase2b5"))
    assert len(v2_calls) == 3, f"closed states must reach chat_v2: {v2_calls}"
    assert len(v3_calls) == 3, f"closed states must reach chatbotv3: {v3_calls}"


def test_p2b7_video_placeholder_persists_has_image(monkeypatch):
    """2B.7 regression pin — [วิดีโอ] turn on a collecting episode persists
    canonical image evidence through the real path (app.chat → legacy SM →
    _claim_transition → fake Mongo): has_image=True, same episode, and the
    removed has_video alias never appears in persisted state."""
    fx = _p2b5_fx(
        conversation_id="fx-conv-p2b7-vid", ticket_state="bot",
        claim_state_seed={"stage": "collecting", "episode_id": "ep-vid",
                          "customer_name": "สมชาย ใจดี"},
        turns=[{"text": "[วิดีโอ]"}],
        synthetic_pii=["name"])
    _records, _cap, _client = _replay(monkeypatch, fx)
    claim = conversation_products.load_claim_state("fx-conv-p2b7-vid")
    assert claim and claim.get("episode_id") == "ep-vid", \
        "video evidence must merge into the same open episode"
    assert claim.get("stage") == "collecting"
    assert claim.get("has_image") is True, \
        "[วิดีโอ] placeholder must persist as canonical has_image evidence"
    assert "has_video" not in claim, \
        "persisted claim_state must never carry the removed has_video field"


# ── harness self-tests (Phase 0C): prove doubles/tripwires actually work ─────

def _locked_fx():
    return {"id": "selftest-locked", "status": "positive", "levels": [3],
            "expected": {"action": "locked"}}


def _locked_rec(**resp_kw):
    base = dict(chat_engine="legacy", handoff_to_admin=False,
                handoff_reason=None, routing_decision={"path": "human_wait"},
                answer="รอแอดมิน")
    base.update(resp_kw)
    return {"resp": SimpleNamespace(**base), "llm_calls": [],
            "handoffs": []}


def test_harness_selftest_locked_accepts_wait_only():
    """A genuine wait-only response must pass action=locked."""
    fails = _expectations_met(_locked_fx(), [_locked_rec()], SimpleNamespace())
    assert fails == [], f"wait-only response wrongly failed: {fails}"


def test_harness_selftest_locked_rejects_handoff_flag():
    """handoff_to_admin=True is a NEW-handoff command — must fail locked."""
    fails = _expectations_met(
        _locked_fx(), [_locked_rec(handoff_to_admin=True)], SimpleNamespace())
    assert any("handoff_to_admin" in f for f in fails), fails


def test_harness_selftest_locked_rejects_handoff_path():
    """routing path 'handoff' is a handoff command — must fail locked."""
    fails = _expectations_met(
        _locked_fx(), [_locked_rec(routing_decision={"path": "handoff"})],
        SimpleNamespace())
    assert any("routing" in f for f in fails), fails


def test_harness_selftest_locked_rejects_recorded_handoff():
    """A recorded handoff POST on the locked turn must fail action=locked."""
    rec = _locked_rec()
    rec["handoffs"] = [{"reason": "post_handoff_waiting"}]
    fails = _expectations_met(_locked_fx(), [rec], SimpleNamespace())
    assert any("handoff POST" in f for f in fails), fails


def _validator_mod():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "validate_legacy_turn_fixtures",
        ROOT / "docs" / "test" / "validate_legacy_turn_fixtures.py")
    vmod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(vmod)
    return vmod


def test_harness_validator_rejects_unasserted_keys():
    """meta: the fixture validator must reject expectation keys that have no
    assertion — otherwise any claim is a false-green."""
    vmod = _validator_mod()
    base = {"id": "meta-x", "status": "positive", "levels": [3],
            "turns": [{"text": "test"}]}
    errs = vmod.check_row({**base, "expected": {
        "action": "answer", "selected_magic_product": [3002]}})
    assert any("selected_magic_product" in e for e in errs), errs


def test_meta_validator_semantics():
    """validator mutations: action enum, L3-only expected, catalog id check."""
    vmod = _validator_mod()
    ok = {"id": "meta-ok", "status": "positive", "levels": [3],
          "shop": "MetaShop", "turns": [{"text": "test"}],
          "catalog": [{"item_id": 1001.0, "shopname": "MetaShop"}]}
    # nonsense action must be rejected
    errs = vmod.check_row({**ok, "expected": {"action": "nonsense"}})
    assert any("action" in e for e in errs), errs
    # expected block is an L3 contract — level 2-only fixture must reject it
    errs = vmod.check_row({**ok, "levels": [2],
                           "expected": {"action": "answer"}})
    assert any("expected" in e for e in errs), errs
    # forbidden/control ids must exist in the catalog — fake id 999999
    errs = vmod.check_row({**ok, "expected": {
        "action": "answer", "llm_must_not_item_ids": [999999]}})
    assert any("999999" in e for e in errs), errs
    # llm_card_status keys are item ids — same catalog check
    errs = vmod.check_row({**ok, "expected": {
        "action": "answer",
        "llm_card_status": {"999999": ["active"]}}})
    assert any("999999" in e for e in errs), errs
    # declared non-catalog reason is the documented escape hatch
    errs = vmod.check_row({**ok, "noncatalog_item_reason": "probe absent id",
                           "expected": {"action": "answer",
                                        "llm_must_not_item_ids": [999999]}})
    assert not errs, errs


def test_harness_fetch_shop_boundary(monkeypatch):
    """fake fetch must not leak docs across shops — nonmatching shop → []."""
    fx = next(f for f in ALL_FX if f.get("catalog") and f.get("shop"))
    _install(monkeypatch, fx)
    leak = product_store.fetch_products(None, "x", shop_filter="NoSuchShop999")
    assert leak == [], f"cross-shop leak: {len(leak)} docs returned"
    own = product_store.fetch_products(None, "x", shop_filter=fx["shop"])
    assert own, "matching shop filter must return fixture docs"


def test_harness_urlopen_allowlist(monkeypatch):
    """handoff endpoint is captured offline; unrelated URLs trip the guard —
    the failure must come from the tripwire, never a real request."""
    fx = next(f for f in ALL_FX if f.get("catalog") and f.get("shop"))
    _install(monkeypatch, fx)
    req = urllib.request.Request(
        "http://127.0.0.1:3000/api/v1/admin/bot-handoff", data=b'{"a":1}')
    assert json.loads(urllib.request.urlopen(req).read()) == {}
    from _pytest.outcomes import Failed
    with pytest.raises(Failed, match="OFFLINE LEAK.*urlopen"):
        urllib.request.urlopen("https://example.com/unrelated")


def test_offline_guard_blocks_dotenv_aliases():
    """meta-test: all three load_dotenv bindings (provider + module-bound
    aliases created by `from dotenv import load_dotenv` in app.py /
    knowledge_base.py) must fail fast — never silently return False, never
    touch a real .env."""
    from _pytest.outcomes import Failed
    dummy = Path("never-read.env")
    for name, fn in (("dotenv", dotenv.load_dotenv),
                     ("app", app.load_dotenv),
                     ("knowledge_base", knowledge_base.load_dotenv)):
        with pytest.raises(Failed, match="OFFLINE LEAK"):
            fn(dummy)


def _synthetic_rec(products=(), answer="รับทราบค่ะ", handoff=False,
                   handoff_reason="", web_used=False):
    """minimal L3 record for _expectations_met mutations."""
    return [{"resp": SimpleNamespace(
        handoff_to_admin=handoff, handoff_reason=handoff_reason,
        web_search_used=web_used, products=[], answer=answer,
        chat_engine="legacy"),
        "llm_calls": [{"fn": "answer", "products": list(products),
                       "context": None, "qtype": None, "history": [],
                       "extra_context": None, "intent_result": None}],
        "handoffs": []}]


def _meta_fx(expected):
    return {"id": "meta", "status": "positive", "levels": [3],
            "turns": [{"text": "x"}], "conversation_id": "meta-x",
            "expected": expected}


def test_meta_action_answer_semantics():
    """action='answer' must fail on handoff or missing bot answer."""
    fx = _meta_fx({"action": "answer"})
    assert _expectations_met(fx, _synthetic_rec(handoff=True), None), \
        "answer expected but handoff passed silently"
    assert _expectations_met(fx, _synthetic_rec(answer=""), None), \
        "answer expected but empty bot answer passed silently"
    assert not _expectations_met(fx, _synthetic_rec(), None)


def test_meta_action_handoff_reason():
    """action='handoff' + wrong handoff_reason must fail."""
    fx = _meta_fx({"action": "handoff", "handoff_reason": "customer_angry"})
    rec = _synthetic_rec(handoff=True, handoff_reason="wrong_reason")
    assert _expectations_met(fx, rec, None), \
        "wrong handoff_reason passed silently"
    ok = _synthetic_rec(handoff=True, handoff_reason="customer_angry")
    assert not _expectations_met(fx, ok, None)


def test_meta_web_search_equality():
    """web_search must assert equality both ways."""
    fx_t = _meta_fx({"action": "answer", "web_search": True})
    assert _expectations_met(fx_t, _synthetic_rec(web_used=False), None), \
        "web_search=True want but False passed silently"
    fx_f = _meta_fx({"action": "answer", "web_search": False})
    assert _expectations_met(fx_f, _synthetic_rec(web_used=True), None)
    assert not _expectations_met(fx_t, _synthetic_rec(web_used=True), None)


def test_meta_llm_card_status_absent_item():
    """llm_card_status must fail when the expected item never reached LLM."""
    fx = _meta_fx({"action": "answer",
                   "llm_card_status": {"3001": ["discontinued"]}})
    rec = _synthetic_rec(products=[{"item_id": 3002.0,
                                    "catalog_status": "active"}])
    assert _expectations_met(fx, rec, None), \
        "expected item absent from llm input passed silently"


def test_harness_import_boundary_subprocess():
    """subprocess probe: importing shopeechat.app under the same
    neutralizations as collection must not touch network, Mongo, HF model
    download, or real dotenv — any leak exits non-zero."""
    import subprocess
    probe = (
        "import os, sys, socket, urllib.request\n"
        "os.environ['HF_HUB_OFFLINE'] = '1'\n"
        "os.environ['TRANSFORMERS_OFFLINE'] = '1'\n"
        "def leak(x): sys.exit('IMPORT LEAK: ' + x)\n"
        "socket.socket.connect = lambda s, a: leak(f'socket {a!r}')\n"
        "urllib.request.urlopen = lambda *a, **k: leak('urlopen')\n"
        "import pymongo\n"
        "pymongo.MongoClient.__init__ = lambda s, *a, **k: leak('MongoClient')\n"
        "import dotenv\n"
        "dotenv.load_dotenv = lambda *a, **k: False\n"
        "sys.path.insert(0, 'chatbot')\n"
        "import shopeechat.app\n"
        "print('IMPORT_OK')\n"
    )
    env = {**os.environ, "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"}
    out = subprocess.run([sys.executable, "-c", probe], cwd=str(ROOT),
                         capture_output=True, text=True, timeout=120, env=env)
    assert out.returncode == 0 and "IMPORT_OK" in out.stdout, (
        f"import leaked or crashed:\n{out.stdout}\n{out.stderr[-2000:]}")


def test_meta_validator_turn_decision_expect():
    """turn_decision_expect: per-user-turn TurnPlan expectations —
    validator must enforce count/shape/primary_action/needs enum."""
    vmod = _validator_mod()
    ok = {"id": "meta-td", "status": "positive", "levels": [3],
          "shop": "MetaShop", "turns": [{"text": "ทัก"}, {"text": "ถาม"}],
          "catalog": [{"item_id": 1001.0, "shopname": "MetaShop"}]}
    # valid block must pass
    errs = vmod.check_row({**ok, "turn_decision_expect": [
        {"primary_action": "clarify", "needs": [],
         "requires_clarification": True},
        {"primary_action": "execute_needs",
         "needs": [{"kind": "product", "operation": "describe"}],
         "flags_contains": ["cert_question"]}]})
    assert not errs, errs
    # unknown nested key rejected
    errs = vmod.check_row({**ok, "turn_decision_expect": [
        {"primary_action": "clarify"},
        {"primary_action": "clarify", "magic": 1}]})
    assert any("magic" in e for e in errs), errs
    # invalid primary_action rejected
    errs = vmod.check_row({**ok, "turn_decision_expect": [
        {"primary_action": "spin"}, {"primary_action": "clarify"}]})
    assert any("primary_action" in e for e in errs), errs
    # invalid need kind/operation rejected
    errs = vmod.check_row({**ok, "turn_decision_expect": [
        {"primary_action": "execute_needs",
         "needs": [{"kind": "bogus", "operation": "describe"}]},
        {"primary_action": "clarify"}]})
    assert any("kind" in e for e in errs), errs
    # count must equal user-turn count
    errs = vmod.check_row({**ok, "turn_decision_expect": [
        {"primary_action": "clarify"}]})
    assert any("turn" in e.lower() for e in errs), errs
    # flags_contains must be list[str]
    errs = vmod.check_row({**ok, "turn_decision_expect": [
        {"primary_action": "clarify", "flags_contains": "x"},
        {"primary_action": "clarify"}]})
    assert any("flags_contains" in e for e in errs), errs


def test_meta_validator_shop_settings_seed_schema():
    """shop_settings_seed rows must be well-formed (nested keys enforced)."""
    vmod = _validator_mod()
    ok = {"id": "meta-ss", "status": "positive", "levels": [3],
          "shop": "MetaShop", "turns": [{"text": "ทัก"}],
          "catalog": [{"item_id": 1001.0, "shopname": "MetaShop"}]}
    good = {"shopname": "MetaShop", "platform": "shopee",
            "post_handoff_exceptions": ["ทวนข้อมูล"]}
    errs = vmod.check_row({**ok, "shop_settings_seed": [good]})
    assert not errs, errs
    errs = vmod.check_row({**ok, "shop_settings_seed": [
        {**good, "unknown_key": 1}]})
    assert any("unknown_key" in e for e in errs), errs
    errs = vmod.check_row({**ok, "shop_settings_seed": [
        {**good, "post_handoff_exceptions": "ทวนข้อมูล"}]})
    assert any("post_handoff_exceptions" in e for e in errs), errs
    errs = vmod.check_row({**ok, "shop_settings_seed": [
        {**good, "post_handoff_exceptions": [123]}]})
    assert any("post_handoff_exceptions" in e for e in errs), errs
    errs = vmod.check_row({**ok, "shop_settings_seed": [
        {**good, "shopname": ""}]})
    assert any("shopname" in e for e in errs), errs


def test_meta_validator_rejects_vacuous_claim_state_exists():
    """claim_state_seed + claim_state_exists=true without final_claim_state
    is vacuous — the seed already makes it exist."""
    vmod = _validator_mod()
    ok = {"id": "meta-vc", "status": "positive", "levels": [3],
          "shop": "MetaShop", "turns": [{"text": "0812345678"}],
          "catalog": [{"item_id": 1001.0, "shopname": "MetaShop"}],
          "claim_state_seed": {"stage": "collecting"},
          "synthetic_pii": ["phone"]}
    errs = vmod.check_row({**ok, "expected": {
        "action": "claim_collect", "claim_state_exists": True}})
    assert any("vacuous" in e or "claim_state_exists" in e for e in errs), errs
    # same row with final_claim_state is a real assertion
    errs = vmod.check_row({**ok, "expected": {
        "action": "claim_collect",
        "final_claim_state": {"customer_phone": "0812345678"}}})
    assert not errs, errs
    # claim_state_exists:true + closed ticket is NOT vacuous — the executor
    # has a clear path (closed-ticket clear), so "still exists" is real.
    # But the clear path only executes when the warranty branch actually
    # runs with non-empty history — narrow the exception to that path.
    errs = vmod.check_row({**ok, "ticket_state": "closed",
                           "turns": [{"role": "model",
                                      "text": "รับทราบค่ะ"},
                                     {"text": "0812345678"}],
                           "expected": {
                               "action": "answer",
                               "claim_state_exists": True}})
    assert not errs, errs


def test_meta_validator_claim_exists_survival_path_is_narrow():
    """Seeded-state `claim_state_exists` survival assertions are only
    non-vacuous along the path where current code can actually clear
    (ticket_state=closed AND non-empty history via model/history_extra).
    Any other ticket state — or closed without history — must reject."""
    vmod = _validator_mod()
    ok = {"id": "meta-vc2", "status": "positive", "levels": [3],
          "shop": "MetaShop", "turns": [{"text": "สวัสดีครับ"}],
          "catalog": [{"item_id": 1001.0, "shopname": "MetaShop"}],
          "claim_state_seed": {"stage": "collecting"}}
    exp = {"action": "answer", "claim_state_exists": True}
    # open ticket — no clear path → vacuous
    errs = vmod.check_row({**ok, "ticket_state": "open", "expected": exp})
    assert errs, "open ticket must not bypass the vacuous guard"
    # closed but no model/history turn → clear branch unreachable → vacuous
    errs = vmod.check_row({**ok, "ticket_state": "closed", "expected": exp})
    assert errs, "closed without history must not bypass the vacuous guard"
    for other in ("handoff", "pending", "resolved", "bot"):
        errs = vmod.check_row({**ok, "ticket_state": other,
                               "expected": exp})
        assert errs, f"ticket_state={other} must not bypass"
    # closed + model history turn → real survival assertion
    errs = vmod.check_row({**ok, "ticket_state": "closed",
                           "turns": [{"role": "model",
                                      "text": "รับทราบค่ะ"},
                                     {"text": "สวัสดีครับ"}],
                           "expected": exp})
    assert not errs, errs
    # history_extra also establishes the executable path
    errs = vmod.check_row({**ok, "ticket_state": "closed",
                           "history_extra": [
                               {"role": "model", "text": "x"}],
                           "expected": exp})
    assert not errs, errs


def test_meta_validator_owner_taxonomy_three_axes():
    """Owner vocabulary: the combined legacy axis `claim_or_ticket_state`
    is retired — three independent axes replace it."""
    vmod = _validator_mod()
    ok = {"id": "meta-ow", "status": "positive", "levels": [3],
          "shop": "MetaShop", "turns": [{"text": "สวัสดีครับ"}],
          "catalog": [{"item_id": 1001.0, "shopname": "MetaShop"}]}
    for good in ("conversation_ownership", "claim_lifecycle",
                 "claim_field_acceptance"):
        errs = vmod.check_row({**ok, "expected_owner": good})
        assert not errs, f"new axis {good!r} should be accepted: {errs}"
    errs = vmod.check_row({**ok, "expected_owner": "claim_or_ticket_state"})
    assert errs, "combined legacy owner name must be rejected"
    errs = vmod.check_row({**ok, "secondary_owners":
                           ["claim_or_ticket_state"]})
    assert errs, "combined name must be rejected in secondary_owners too"


def test_meta_validator_rejects_vacuous_final_claim_state():
    """final_claim_state ที่ทุก key/value เท่ากับ seed อยู่แล้ว = vacuous —
    assert ไม่มีอะไร (state เดิมก่อน replay)."""
    vmod = _validator_mod()
    ok = {"id": "meta-vf", "status": "positive", "levels": [3],
          "shop": "MetaShop", "turns": [{"text": "0812345678"}],
          "catalog": [{"item_id": 1001.0, "shopname": "MetaShop"}],
          "claim_state_seed": {"stage": "resolved",
                               "customer_name": "สมชาย ใจดี"},
          "synthetic_pii": ["phone"]}
    # retained-seed subset → vacuous → reject
    errs = vmod.check_row({**ok, "expected": {
        "action": "claim_collect",
        "final_claim_state": {"customer_name": "สมชาย ใจดี"}}})
    assert any("vacuous" in e or "final_claim_state" in e for e in errs), errs
    # new value not in seed → real assertion → pass
    errs = vmod.check_row({**ok, "expected": {
        "action": "claim_collect",
        "final_claim_state": {"customer_phone": "0812345678"}}})
    assert not errs, errs
    # key absent from seed is NOT vacuous even when expected value is None —
    # seed.get(k)==None would false-positive without the `k in seed` guard
    ok2 = {**ok, "claim_state_seed": {"stage": "collecting"}}
    errs = vmod.check_row({**ok2, "expected": {
        "action": "claim_collect",
        "final_claim_state": {"customer_phone": None}}})
    assert not errs, errs


def test_meta_final_claim_state_checked_for_any_action(monkeypatch):
    """final_claim_state must be asserted for EVERY action, not only
    claim_collect — otherwise handoff+fcs expectations pass silently."""
    fx = _meta_fx({"action": "handoff", "handoff_reason": "claim",
                   "final_claim_state": {"stage": "collecting"}})
    rec = _synthetic_rec(handoff=True, handoff_reason="claim")
    monkeypatch.setattr(conversation_products, "load_claim_state",
                        lambda cid: {"stage": "resolved"})
    assert _expectations_met(fx, rec, None), \
        "handoff + mismatched final_claim_state passed silently"
    monkeypatch.setattr(conversation_products, "load_claim_state",
                        lambda cid: {"stage": "collecting"})
    assert not _expectations_met(fx, rec, None)
    # None value asserts field absence — old-case fields must not carry over
    fx_none = _meta_fx({"action": "handoff", "handoff_reason": "claim",
                        "final_claim_state": {"stage": "collecting",
                                              "customer_order_id": None}})
    monkeypatch.setattr(
        conversation_products, "load_claim_state",
        lambda cid: {"stage": "collecting", "customer_order_id": "X1"})
    assert _expectations_met(fx_none, rec, None), \
        "final_claim_state None-absence assertion skipped under handoff"
    monkeypatch.setattr(conversation_products, "load_claim_state",
                        lambda cid: {"stage": "collecting"})
    assert not _expectations_met(fx_none, rec, None)


def test_meta_validator_tde_current_divergence_key():
    """tde entry `current` declares the buggy action current code produces —
    incident rows only, and it must differ from the desired `action`."""
    vmod = _validator_mod()
    ok = {"id": "meta-tdc", "status": "incident", "levels": [3],
          "incident_levels": [3], "shop": "MetaShop",
          "turns": [{"text": "x"}],
          "catalog": [{"item_id": 1001.0, "shopname": "MetaShop"}],
          "expected_owner": "claim_lifecycle",
          "expected": {"action": "answer"}}
    errs = vmod.check_row({**ok, "turn_decision_expect": [
        {"primary_action": "execute_needs", "current": "clarify"}]})
    assert not errs, errs
    # current == primary_action is a no-op declaration → reject
    errs = vmod.check_row({**ok, "turn_decision_expect": [
        {"primary_action": "execute_needs", "current": "execute_needs"}]})
    assert errs, "current==primary_action must be rejected"
    # current not in primary_action enum → reject
    errs = vmod.check_row({**ok, "turn_decision_expect": [
        {"primary_action": "execute_needs", "current": "bogus"}]})
    assert errs
    # current on a positive row → reject (nothing diverges to declare)
    errs = vmod.check_row({**ok, "status": "positive",
                           "incident_levels": None,
                           "turn_decision_expect": [
                               {"primary_action": "execute_needs",
                                "current": "clarify"}]})
    assert errs, "'current' must be incident-only"


def test_meta_tde_entry_semantics():
    """strict TurnPlan expectation semantics shared by the contract
    test and the shadow sweep (validator-owned helper)."""
    from validate_legacy_turn_fixtures import tde_entry_error  # noqa
    chk = tde_entry_error
    # incident + declared current + actual==current → expected divergence
    assert chk({"primary_action": "execute_needs", "current": "clarify"},
               {"primary_action": "clarify"}, ["claim_resume"],
               incident=True) is None
    # incident + declared current + actual==desired → STALE incident
    assert chk({"primary_action": "execute_needs", "current": "clarify"},
               {"primary_action": "execute_needs"}, [], incident=True), \
        "incident whose desired primary_action now holds must fail (stale pin)"
    # incident + declared current + drifted actual → fail
    assert chk({"primary_action": "execute_needs", "current": "clarify"},
               {"primary_action": "handoff"}, [], incident=True)
    # positive + mismatch → fail
    assert chk({"primary_action": "execute_needs"},
               {"primary_action": "clarify"}, [],
               incident=False)
    # positive + match → pass
    assert chk({"primary_action": "execute_needs",
                "needs": [{"kind": "claim", "operation": "collect"}]},
               {"primary_action": "execute_needs",
                "needs": [{"kind": "claim", "operation": "collect"}]}, [],
               incident=False) is None
    # incident row WITHOUT current = current-pin — flags still asserted
    assert chk({"primary_action": "execute_needs",
                "flags_contains": ["claim_resume"]},
               {"primary_action": "execute_needs"}, [], incident=True), \
        "flags_contains on incident current-pins must not be exempt"


def test_meta_validator_turn_decision_nonstring_action():
    """primary_action ที่ไม่ใช่ string (list/dict/int) ต้อง reject ไม่ใช่ crash."""
    vmod = _validator_mod()
    ok = {"id": "meta-td2", "status": "positive", "levels": [3],
          "shop": "MetaShop", "turns": [{"text": "ทัก"}],
          "catalog": [{"item_id": 1001.0, "shopname": "MetaShop"}]}
    for bad_action in ([], {"x": 1}, 5):
        errs = vmod.check_row({**ok, "turn_decision_expect": [
            {"primary_action": bad_action}]})
        assert errs, f"primary_action={bad_action!r} should fail validation"


# ══════════════════════════════════════════════════════════════════
# Phase 5 closeout — mixed product+return-policy fail-closed defer
#   (R5: untyped prose blob cannot separate product/policy conclusions;
#   defer before the product LLM call — replacement = Phase 6/7/8)
# ══════════════════════════════════════════════════════════════════

def _r5_fx(fid):
    return next(f for f in L3_FX if f["id"] == fid)


def test_r5_mixed_model_item_defers_before_llm(monkeypatch):
    """return_policy + model → handoff transport exactly once, zero LLM
    calls, deterministic admin-review answer, typed decision kept."""
    records, captured, client = _replay(
        monkeypatch, _r5_fx("pos-policy-return-model-item"))
    rec = records[-1]
    resp = rec["resp"]
    from shopeechat import guards as _g
    assert rec["llm_calls"] == [], \
        f"product LLM ran on a mixed policy turn: {rec['llm_calls']}"
    assert len(rec["handoffs"]) == 1 and \
        rec["handoffs"][0]["reason"] == "policy_mixed_review"
    assert resp.handoff_to_admin is True
    assert resp.handoff_reason == "policy_mixed_review"
    assert resp.answer == _g._POLICY_TEXT_ADMIN_REVIEW
    for _t in (_g._POLICY_TEXT_ELIGIBLE, _g._POLICY_TEXT_INELIGIBLE):
        assert _t not in resp.answer
    pdec = (resp.routing_decision or {}).get("policy_decision") or {}
    assert pdec.get("outcome") == "ineligible"
    assert pdec.get("policy_type") == "return_exchange"


def test_r5_mixed_tagged_item_defers_with_cards(monkeypatch):
    """tagged-item + return_policy → same defer; the already-resolved
    tagged card stays attached (no extra retrieval)."""
    records, captured, client = _replay(
        monkeypatch, _r5_fx("pos-policy-return-tagged-item"))
    rec = records[-1]
    resp = rec["resp"]
    from shopeechat import guards as _g
    assert rec["llm_calls"] == []
    assert len(rec["handoffs"]) == 1
    assert resp.handoff_to_admin is True
    assert resp.answer == _g._POLICY_TEXT_ADMIN_REVIEW
    assert _card_ids(resp.products or []) == {5001}, \
        f"tagged card must remain attached: {resp.products}"


@pytest.mark.parametrize("outcome",
                         ["eligible", "ineligible", "unknown",
                          "admin_review"])
def test_r5_mixed_all_outcomes_defer_identically(monkeypatch, outcome):
    """every typed outcome takes the same deferred admin-review path —
    Phase 5 never auto-renders eligibility for mixed turns."""
    import copy
    fx = copy.deepcopy(_r5_fx("pos-policy-return-model-item"))
    if outcome == "unknown":
        # 'unknown' is a decision outcome — no matching rule may carry it;
        # empty record source resolves to unknown honestly.
        fx["policy_records"] = []
    else:
        for _r in fx["policy_records"]:
            _r["outcome"] = outcome
    records, captured, client = _replay(monkeypatch, fx)
    rec = records[-1]
    resp = rec["resp"]
    from shopeechat import guards as _g
    assert rec["llm_calls"] == []
    assert resp.handoff_to_admin is True
    assert resp.answer == _g._POLICY_TEXT_ADMIN_REVIEW
    for _t in (_g._POLICY_TEXT_ELIGIBLE, _g._POLICY_TEXT_INELIGIBLE):
        assert _t not in resp.answer
    assert ((resp.routing_decision or {}).get("policy_decision") or {}
            ).get("outcome") == outcome


def test_r5_mixed_handoff_failure_no_success_claim(monkeypatch):
    """failed transport → no flag, no admin-review wording, no LLM, no
    eligibility conclusion — existing HANDOFF_FAILED_REPLY contract."""
    fx = _r5_fx("pos-policy-return-model-item")
    client, captured, handoff_calls = _install(monkeypatch, fx)

    def _fail_send(req, ctx=None, *, reason="", **kw):
        handoff_calls.append({"reason": reason})
        return None
    monkeypatch.setattr(app, "_send_handoff", _fail_send)
    from shopeechat import responses as _resp_mod
    monkeypatch.setattr(_resp_mod, "_send_handoff", _fail_send)
    turn = fx["turns"][0]
    resp = app.chat(app.ChatRequest(
        message=turn["text"], shop=fx.get("shop"),
        platform=fx.get("platform", "shopee"), history=[],
        conversation_id=fx.get("conversation_id"), limit=5,
        simulate_assignment=True, test_source="phase0_replay"))
    from shopeechat import guards as _g
    assert captured.calls == []
    assert len(handoff_calls) == 1
    assert resp.handoff_to_admin is False
    assert resp.handoff_reason is None
    assert resp.answer == _resp_mod.HANDOFF_FAILED_REPLY
    assert _g._POLICY_TEXT_ADMIN_REVIEW not in resp.answer
    for _t in (_g._POLICY_TEXT_ELIGIBLE, _g._POLICY_TEXT_INELIGIBLE):
        assert _t not in resp.answer


def test_r5_pure_policy_still_deterministic(monkeypatch):
    """control — pure return_policy + authoritative ineligible →
    deterministic typed rendering, zero model calls, no handoff."""
    records, captured, client = _replay(
        monkeypatch, _r5_fx("tx-policy-wrong-model-filter"))
    rec = records[-1]
    resp = rec["resp"]
    from shopeechat import guards as _g
    assert rec["llm_calls"] == [], \
        f"pure return_policy must be zero-model: {rec['llm_calls']}"
    assert rec["handoffs"] == []
    assert resp.handoff_to_admin is False
    assert resp.handoff_reason is None
    assert resp.answer == _g._POLICY_TEXT_INELIGIBLE
    assert ((resp.routing_decision or {}).get("policy_decision") or {}
            ).get("outcome") == "ineligible"


def test_r5_ordinary_product_flow_unchanged(monkeypatch):
    """control — non-policy product turn still calls the product answer
    path exactly once and returns the canned reply."""
    records, captured, client = _replay(
        monkeypatch, _r5_fx("iss29-bare-model-catalog"))
    rec = records[-1]
    resp = rec["resp"]
    assert rec["llm_calls"] and rec["llm_calls"][-1].get("fn") == "answer"
    assert resp.handoff_to_admin is False
    assert (resp.routing_decision or {}).get("policy_decision") is None


# ══════════════════════════════════════════════════════════════════
# Phase 5 R6 — pure return_policy unknown/admin_review → authoritative
# handoff; eligible/ineligible → deterministic zero-model render.
#   (defect: unknown/admin_review reached answer_general — model call
#   discarded + admin-review promise without any handoff)
# ══════════════════════════════════════════════════════════════════

_R6_PURE_FX = {
    "id": "r6-pure-policy", "shop": "FilterShopTH", "platform": "shopee",
    "conversation_id": "fx-r6-pure", "catalog": [],
    "intent_result": {"intent": "general_question", "confidence": 0.9,
                      "general_qtype": "return_policy",
                      "policy_reason": "customer_wrong_model",
                      "policy_item_condition": "sealed"},
    "turns": [{"text": "ถ้าซื้อผิดรุ่นเอง ขอเปลี่ยนได้ไหมคะ"}],
    "llm_reply": "ห้ามถูกเรียก — pure policy turn ต้องไม่ใช้ LLM",
}


def _r6_fx(records=None):
    import copy
    fx = copy.deepcopy(_R6_PURE_FX)
    if records is not None:
        fx["policy_records"] = records
    return fx


def _r6_rule(outcome):
    return [{"rule_id": "r6-rule", "version": "fx-2026-01",
             "policy_type": "return_exchange", "outcome": outcome,
             "reason": "customer_wrong_model", "shops": ["FilterShopTH"],
             "priority": 10, "source": "fixture-policy"}]


def test_r6_pure_unknown_production_empty_rules_handoff(monkeypatch):
    """production `active_policy_rules()` is empty → outcome unknown →
    exactly one `policy_review_required` handoff, zero LLM calls."""
    records, captured, client = _replay(monkeypatch, _r6_fx())
    rec = records[-1]
    resp = rec["resp"]
    from shopeechat import guards as _g
    assert rec["llm_calls"] == [], \
        f"answer_general ran on pure unknown policy turn: {rec['llm_calls']}"
    assert len(rec["handoffs"]) == 1
    assert rec["handoffs"][0]["reason"] == "policy_review_required"
    assert resp.handoff_to_admin is True
    assert resp.handoff_reason == "policy_review_required"
    assert resp.answer == _g._POLICY_TEXT_ADMIN_REVIEW
    for _t in (_g._POLICY_TEXT_ELIGIBLE, _g._POLICY_TEXT_INELIGIBLE):
        assert _t not in resp.answer
    pdec = (resp.routing_decision or {}).get("policy_decision") or {}
    assert pdec.get("outcome") == "unknown"
    assert pdec.get("policy_type") == "return_exchange"


def test_r6_pure_admin_review_decision_handoff(monkeypatch):
    """explicit admin_review typed decision → same authoritative handoff."""
    records, captured, client = _replay(
        monkeypatch, _r6_fx(_r6_rule("admin_review")))
    rec = records[-1]
    resp = rec["resp"]
    from shopeechat import guards as _g
    assert rec["llm_calls"] == []
    assert len(rec["handoffs"]) == 1
    assert rec["handoffs"][0]["reason"] == "policy_review_required"
    assert resp.handoff_to_admin is True
    assert resp.answer == _g._POLICY_TEXT_ADMIN_REVIEW


def test_r6_pure_unknown_handoff_failure_no_success_claim(monkeypatch):
    """failed transport → HANDOFF_FAILED_REPLY, no flag/reason, no
    admin-review wording, zero LLM calls."""
    fx = _r6_fx()
    client, captured, handoff_calls = _install(monkeypatch, fx)

    def _fail_send(req, ctx=None, *, reason="", **kw):
        handoff_calls.append({"reason": reason})
        return None
    monkeypatch.setattr(app, "_send_handoff", _fail_send)
    from shopeechat import responses as _resp_mod
    monkeypatch.setattr(_resp_mod, "_send_handoff", _fail_send)
    turn = fx["turns"][0]
    resp = app.chat(app.ChatRequest(
        message=turn["text"], shop=fx.get("shop"),
        platform=fx.get("platform", "shopee"), history=[],
        conversation_id=fx.get("conversation_id"), limit=5,
        simulate_assignment=True, test_source="phase0_replay"))
    from shopeechat import guards as _g
    assert captured.calls == []
    assert len(handoff_calls) == 1
    assert resp.handoff_to_admin is False
    assert resp.handoff_reason is None
    assert resp.answer == _resp_mod.HANDOFF_FAILED_REPLY
    assert _g._POLICY_TEXT_ADMIN_REVIEW not in resp.answer
    for _t in (_g._POLICY_TEXT_ELIGIBLE, _g._POLICY_TEXT_INELIGIBLE):
        assert _t not in resp.answer


@pytest.mark.parametrize("outcome,text_key",
                         [("eligible", "_POLICY_TEXT_ELIGIBLE"),
                          ("ineligible", "_POLICY_TEXT_INELIGIBLE")])
def test_r6_pure_authoritative_outcome_no_handoff_no_llm(
        monkeypatch, outcome, text_key):
    """authoritative eligible/ineligible → deterministic text, zero model,
    no handoff, typed decision retained in routing_decision."""
    records, captured, client = _replay(
        monkeypatch, _r6_fx(_r6_rule(outcome)))
    rec = records[-1]
    resp = rec["resp"]
    from shopeechat import guards as _g
    assert rec["llm_calls"] == []
    assert rec["handoffs"] == [], \
        f"authoritative {outcome} must not handoff: {rec['handoffs']}"
    assert resp.handoff_to_admin is False
    assert resp.handoff_reason is None
    assert resp.answer == getattr(_g, text_key)
    assert _g._POLICY_TEXT_ADMIN_REVIEW not in resp.answer
    assert ((resp.routing_decision or {}).get("policy_decision") or {}
            ).get("outcome") == outcome
