# Session handoff — R0 next steps
1. เช็ค R1 build: `tail /tmp/r1_run.log` + `ls exports/gen/g20261109-091914-c06ea7fd/` — ครบ 3 artifacts (sellable_units.jsonl, image_texts.jsonl, unit_embeddings.npz) → รัน `publish_generation.py --gen-dir exports/gen/<gid> --gid <gid> --expected auto` + record time/cost
2. R0 instrumentation: เพิ่ม ai_usage collection — log prompt_tokens/candidates_tokens/model/latency/cost ต่อ answer call (ที่ llm.py usage boundary)
3. R0 measurement: baseline ก่อนลด prompt — median/p95 tokens, answer-call count/turn, cost/turn

## Handoff v2 — R1 resume (no sandbox access needed)

**Permission note:** `exports/` is gitignored → agent file-read tools may be blocked.
Do NOT read files under exports/ — use these commands instead (shell works):

- Check artifacts exist: `ls -la exports/gen/g20261109-091914-c06ea7fd/`
- Read OCR counts: `cat exports/gen/g20261109-091914-c06ea7fd/image_texts.counts.json` via shell
- Build units: `python chatbot/shopeechat/scripts/build_sellable_units.py --export exports/ShpProducts.export.json --image-texts exports/gen/<gid>/image_texts.jsonl --out exports/gen/<gid>/sellable_units.jsonl`
- Build embeddings: `python chatbot/shopeechat/scripts/build_embeddings.py --units --units-path exports/gen/<gid>/sellable_units.jsonl --out exports/gen/<gid>/unit_embeddings.npz --gid <gid>` and same for `--description` → product_embeddings.npz
- Publish (wait for separate approval): `publish_generation.py --gen-dir exports/gen/<gid> --gid <gid> --expected auto`

gid = g20261109-091914-c06ea7fd. Do NOT re-run image_texts (cost paid). Fix runbook+wrapper same commit. Everything else is in ledger/register.
