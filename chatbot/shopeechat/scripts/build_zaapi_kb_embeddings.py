"""build_zaapi_kb_embeddings.py — backfill vec ของแถว zaapi_kb ที่ active.

logic จริงอยู่ kb_zaapi_files.backfill_stale_vecs — script นี้ wire
admin db + embedding จริงเท่านั้น (รันจาก generation build step
`zaapi_kb_embeddings`; รันมือได้เช่นกัน)

usage:
    .venv/bin/python chatbot/shopeechat/scripts/build_zaapi_kb_embeddings.py
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))


def main() -> int:
    from chatbot.shopeechat import embedding as _emb
    from chatbot.shopeechat import knowledge_base
    from chatbot.shopeechat import kb_zaapi_files as zkf
    zkf.backfill_stale_vecs(
        knowledge_base._admin_db(), embed_texts=_emb.embed_texts,
        mid=_emb.model_identity(), log=lambda m: print(m, flush=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
