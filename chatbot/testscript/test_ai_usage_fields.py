#!/usr/bin/env python3
"""test_ai_usage_fields.py — R5 contract: provider logs ต้องครบ fields
provider/model, safe key ref, tokens, cost, latency, attempt, outcome, correlation

รัน: python testscript/test_ai_usage_fields.py   (จาก chatbot/)
ไม่แตะ Mongo จริง — monkeypatch _admin_db เก็บ docs ใน memory
"""
import sys, types
sys.path.insert(0, ".")
sys.path.insert(0, "shopeechat")

import shopeechat.knowledge_base as kb
import shopeechat.llm as llm

DOCS: list[dict] = []


class _FakeColl:
    def insert_one(self, doc):
        DOCS.append(dict(doc))


class _FakeDB:
    def __getitem__(self, name):
        return _FakeColl()


kb._admin_db = lambda: _FakeDB()  # type: ignore

passed = failed = 0


def ok(cond, name, extra=""):
    global passed, failed
    if cond:
        passed += 1
    else:
        failed += 1
        print(f"FAIL {name} {extra}")


class _Usage:
    def __init__(self, p, c, cost=None):
        self.prompt_token_count = p
        self.candidates_token_count = c
        self.total_token_count = p + c
        if cost is not None:
            self.cost = cost


# ── 1. _persist_usage บันทึก contract fields ──
DOCS.clear()
llm._persist_usage("gemini-x", 100, 50, path="typed", elapsed_ms=1234,
                   provider="gemini", status="success", attempt=2, key_ref="k1")
d = DOCS[-1]
ok(d.get("provider") == "gemini", "persist provider", d)
ok(d.get("status") == "success", "persist status")
ok(d.get("attempt") == 2, "persist attempt")
ok(d.get("key_ref") == "k1", "persist key_ref")
ok(d.get("elapsed_ms") == 1234, "persist latency")
ok(d.get("prompt_tokens") == 100 and d.get("total_tokens") == 150, "persist tokens")
ok("est_cost_usd" in d, "persist cost")

# ── 2. error record — tokens 0, outcome=error ──
DOCS.clear()
llm._persist_usage("gemini-x", 0, 0, path="typed", provider="gemini",
                   status="error", error="429 quota", attempt=1, key_ref="k0")
d = DOCS[-1]
ok(d.get("status") == "error" and d.get("error") == "429 quota", "error outcome", d)
ok(d.get("total_tokens") == 0, "error tokens=0")

# ── 3. _record_tokens ส่ง provider/attempt/key_ref ต่อ ──
DOCS.clear()
resp = types.SimpleNamespace(usage_metadata=_Usage(200, 80))
llm._record_tokens("gemini-x", resp, path="answer", elapsed_ms=500,
                   provider="gemini", attempt=1, key_ref="k0")
d = DOCS[-1]
ok(d.get("provider") == "gemini" and d.get("attempt") == 1 and d.get("key_ref") == "k0",
   "record_tokens kwargs", d)
ok(d.get("prompt_tokens") == 200 and d.get("status") == "success", "record_tokens success")

# ── 4. openrouter call → ai_usage provider=openrouter ──
DOCS.clear()
orig_provider, orig_or = llm.get_provider, llm._openrouter_generate
try:
    llm.get_provider = lambda r: "openrouter"
    llm._openrouter_generate = lambda m, c, cfg: types.SimpleNamespace(
        text="ok", usage_metadata=_Usage(300, 100, cost=0.0012))
    llm._generate("gemini-test", "hello", {}, path="typed", role="answer")
    d = DOCS[-1]
    ok(d.get("provider") == "openrouter", "OR provider logged", DOCS)
    ok(d.get("prompt_tokens") == 300 and d.get("output_tokens") == 100, "OR tokens")
    ok(d.get("status") == "success" and d.get("path") == "typed", "OR outcome+path")
    ok(abs(d.get("est_cost_usd", 0) - 0.0012) < 1e-9, "OR real cost", d.get("est_cost_usd"))
finally:
    llm.get_provider, llm._openrouter_generate = orig_provider, orig_or

# ── 5. openrouter error → error record + gemini fallback ยังทำงาน ──
DOCS.clear()
try:
    llm.get_provider = lambda r: "openrouter"
    def _boom(m, c, cfg):
        raise RuntimeError("OR down")
    llm._openrouter_generate = _boom
    # stub gemini side เพื่อไม่ยิง network จริง
    orig_acq, orig_key, orig_client = llm._acquire, llm._next_api_key, llm._client
    llm._acquire = lambda m, e: m
    llm._next_api_key = lambda: "fake-key-1"
    class _C:
        class models:
            @staticmethod
            def generate_content(model, contents, config):
                return types.SimpleNamespace(
                    text="ok", usage_metadata=_Usage(50, 20))
    llm._client = lambda k: _C()
    llm._generate("gemini-test", "hi", {}, path="answer", role="answer")
    statuses = [d.get("status") for d in DOCS]
    providers = [d.get("provider") for d in DOCS]
    ok("error" in statuses and "success" in statuses, "OR error + gemini success", statuses)
    ok("openrouter" in providers and "gemini" in providers, "both providers", providers)
    err = next(d for d in DOCS if d.get("status") == "error")
    ok(err.get("provider") == "openrouter" and "OR down" in (err.get("error") or ""),
       "OR error doc", err)
finally:
    llm.get_provider, llm._openrouter_generate = orig_provider, orig_or
    llm._acquire, llm._next_api_key, llm._client = orig_acq, orig_key, orig_client

# ── 6. gemini ClientError → error record (ไม่ใช่เงียบ) ──
DOCS.clear()
try:
    llm._acquire = lambda m, e: m
    llm._next_api_key = lambda: "fake-key-1"
    class _Fail:
        class models:
            @staticmethod
            def generate_content(model, contents, config):
                raise llm.genai_errors.ClientError(500, {"error": {"message": "boom"}})
    llm._client = lambda k: _Fail()
    try:
        llm._generate("gemini-test", "hi", {}, path="intent")
        ok(False, "gemini error should raise")
    except Exception:
        ok(len(DOCS) >= 1 and DOCS[-1].get("status") == "error",
           "gemini error logged", DOCS)
    ok(DOCS[-1].get("provider") == "gemini" and DOCS[-1].get("path") == "intent",
       "gemini error fields", DOCS[-1] if DOCS else {})
finally:
    llm._acquire, llm._next_api_key, llm._client = orig_acq, orig_key, orig_client

# ── 7. correlation ctx ยังไหลลง doc ──
DOCS.clear()
tok = llm._ai_call_ctx.set({"shop": "S1", "conv_id": "C1", "request_id": "R1"})
try:
    llm._persist_usage("m", 1, 1, path="x")
    d = DOCS[-1]
    ok(d.get("conv_id") == "C1" and d.get("request_id") == "R1", "ctx correlation")
finally:
    llm._ai_call_ctx.reset(tok)

print(f"\n{passed} pass, {failed} fail")
sys.exit(1 if failed else 0)
