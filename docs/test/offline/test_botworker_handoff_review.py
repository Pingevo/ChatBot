from __future__ import annotations

from types import SimpleNamespace

from shopeechat import responses


def test_botworker_handoff_is_review_request_without_transport(monkeypatch):
    def fail_transport(*_args, **_kwargs):
        raise AssertionError("BotWorker must not assign before reviewer approval")

    import urllib.request
    monkeypatch.setattr(urllib.request, "urlopen", fail_transport)
    req = SimpleNamespace(conversation_id="conv_1", shop="Shop", platform="shopee",
                          simulate_assignment=True, test_source="botworker")
    outcome = responses._send_handoff(req, reason="human_request")
    assert outcome["outcome"]["state"] == "review_pending"
    assert outcome["assigned_to"] is None


def test_v3_handoff_keeps_botworker_source(monkeypatch):
    from shopeechat.chatbotv3 import engine

    seen = {}

    def capture(req, *_args, **_kwargs):
        seen["test_source"] = req.test_source
        return {"outcome": {"state": "review_pending"}}

    monkeypatch.setattr(responses, "_send_handoff", capture)
    assert engine._send_handoff_to_admin("conv_1", "Shop", "shopee", "human_request",
                                         simulate=True, test_source="botworker")
    assert seen["test_source"] == "botworker"
