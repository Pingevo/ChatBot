from types import SimpleNamespace

import pytest

from shopeechat import knowledge_base, llm


@pytest.fixture
def usage_sink(monkeypatch):
    docs = []
    coll = SimpleNamespace(insert_one=lambda doc: docs.append(doc))
    monkeypatch.setattr(knowledge_base, "_admin_db", lambda: {"ai_usage": coll})
    monkeypatch.setenv("AI_USAGE_LOG", "1")
    monkeypatch.setattr(llm, "get_provider", lambda role: "gemini")
    monkeypatch.setattr(llm, "_acquire", lambda model, tokens: model)
    monkeypatch.setattr(llm, "_next_api_key", lambda: "test-key")
    monkeypatch.setattr(llm, "_active_keys", lambda: ["test-key"])
    token = llm._ai_call_ctx.set({"conv_id": "test-conv", "request_id": "test-request"})
    yield docs
    llm._ai_call_ctx.reset(token)


@pytest.mark.parametrize("fallback", [False, True])
@pytest.mark.parametrize("failure", [
    TimeoutError("sensitive-provider-detail"),
    llm.genai_errors.ServerError(503, {"error": {"message": "sensitive-provider-detail"}}),
])
def test_every_failed_provider_attempt_is_recorded(monkeypatch, usage_sink, fallback, failure):
    calls = []
    monkeypatch.setattr(llm, "_MODEL_FALLBACK", {"primary": "fallback"})

    def generate_content(*, model, contents, config):
        calls.append(model)
        if fallback and len(calls) == 1:
            raise llm.genai_errors.ClientError(429, {"error": {"message": "quota"}})
        raise failure

    monkeypatch.setattr(llm, "_client", lambda key: SimpleNamespace(
        models=SimpleNamespace(generate_content=generate_content)))
    with pytest.raises(type(failure)) as raised:
        llm._generate("primary", "offline", {}, path="typed", role="answer")
    assert raised.value is failure
    assert calls == (["primary", "fallback"] if fallback else ["primary"])
    assert len(usage_sink) == len(calls)
    assert [d["attempt"] for d in usage_sink] == list(range(1, len(calls) + 1))
    for doc in usage_sink:
        assert doc["status"] == "error" and doc["provider"] == "gemini"
        assert doc["usage_available"] is False and doc["est_cost_usd"] is None
        assert doc["conv_id"] == "test-conv" and doc["request_id"] == "test-request"
        assert doc["key_ref"] == "k0" and doc["elapsed_ms"] >= 0
    assert usage_sink[-1]["error"] == type(failure).__name__


@pytest.mark.parametrize("provider", ["gemini", "openrouter"])
@pytest.mark.parametrize("missing_attribute", [True, False])
def test_success_without_usage_still_records_the_call(
        monkeypatch, usage_sink, provider, missing_attribute):
    response = SimpleNamespace(text="offline answer")
    if not missing_attribute:
        response.usage_metadata = None
    monkeypatch.setattr(llm, "get_provider", lambda role: provider)
    monkeypatch.setattr(llm, "_openrouter_generate", lambda *a: response)
    monkeypatch.setattr(llm, "_client", lambda key: SimpleNamespace(
        models=SimpleNamespace(generate_content=lambda **k: response)))
    assert llm._generate("primary", "offline", {}, path="typed", role="answer") is response
    assert len(usage_sink) == 1
    doc = usage_sink[0]
    assert doc["provider"] == provider and doc["status"] == "success"
    assert doc["usage_available"] is False and doc["est_cost_usd"] is None
    assert doc["request_id"] == "test-request" and doc["attempt"] == 1
    assert doc["elapsed_ms"] >= 0


def test_reported_usage_retains_cost_and_token_accounting(monkeypatch, usage_sink):
    response = SimpleNamespace(usage_metadata=SimpleNamespace(
        prompt_token_count=10, candidates_token_count=3, cost=0.001))
    monkeypatch.setattr(llm, "_q_tok", {})
    llm._record_tokens("primary", response, provider="openrouter")
    assert len(usage_sink) == 1
    doc = usage_sink[0]
    assert doc["usage_available"] is True and doc["total_tokens"] == 13
    assert doc["est_cost_usd"] == 0.001
    assert llm._q_tok["primary"][-1][1] == 13
