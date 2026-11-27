"""Order tracking fields exposed to the order panel and customer answer context."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat import order_store  # noqa: E402


def test_order_lookup_and_answer_context_keep_document_tracking_fields(monkeypatch):
    tracking_info = {"status": "PICKED_UP", "description": "พัสดุเข้ารับแล้ว"}
    document = {
        "order_sn": "2611256XT",
        "order_status": "SHIPPED",
        "shopname": "BlackShark",
        "shipping_carrier": "SPX Express",
        "tracking_no": "TH262256426917E",
        "tracking_info": tracking_info,
        "package_list": [{"logistics_status": "LOGISTICS_PICKED_UP"}],
        "item_list": [],
    }

    class OrderCollection:
        def find_one(self, query):
            assert query == {"order_sn": "2611256XT", "shopname": "BlackShark"}
            return document

    monkeypatch.setattr(order_store, "_get_order_collection", lambda: OrderCollection())

    order = order_store.lookup_order("2611256XT", shop_filter="BlackShark")
    assert order is not None
    assert order["tracking_no"] == "TH262256426917E"
    assert order["tracking_numbers"] == ["TH262256426917E"]
    assert order["tracking_info"] == tracking_info

    context = order_store.build_order_context(order)
    assert "เลขพัสดุ: TH262256426917E" in context
    assert "PICKED_UP" in context
    assert "พัสดุเข้ารับแล้ว" in context


def test_tracking_lookup_matches_document_level_tracking_number_with_shop_filter(monkeypatch):
    document = {
        "order_sn": "2611256XT",
        "order_status": "SHIPPED",
        "shopname": "BlackShark",
        "tracking_no": "TH262256426917E",
        "package_list": [{"logistics_status": "LOGISTICS_PICKED_UP"}],
        "item_list": [],
    }
    queries = []

    class OrderCollection:
        def find_one(self, query):
            queries.append(query)
            if query.get("order_sn") == document["order_sn"] and query.get("shopname") == "BlackShark":
                return document
            tracking_filter = {"tracking_no": document["tracking_no"]}
            if query.get("shopname") == "BlackShark" and tracking_filter in query.get("$or", []):
                return document
            return None

    monkeypatch.setattr(order_store, "_get_order_collection", lambda: OrderCollection())

    order = order_store.lookup_by_tracking("TH262256426917E", shop_filter="BlackShark")
    assert order is not None
    assert order["order_sn"] == "2611256XT"
    assert order["tracking_no"] == "TH262256426917E"
    assert queries[0]["shopname"] == "BlackShark"
