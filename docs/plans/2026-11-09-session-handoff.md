# Session handoff — R0 next steps
1. เช็ค R1 build: `tail /tmp/r1_run.log` + `ls exports/gen/g20261109-091914-c06ea7fd/` — ครบ 3 artifacts (sellable_units.jsonl, image_texts.jsonl, unit_embeddings.npz) → รัน `publish_generation.py --gen-dir exports/gen/<gid> --gid <gid> --expected auto` + record time/cost
2. R0 instrumentation: เพิ่ม ai_usage collection — log prompt_tokens/candidates_tokens/model/latency/cost ต่อ answer call (ที่ llm.py usage boundary)
3. R0 measurement: baseline ก่อนลด prompt — median/p95 tokens, answer-call count/turn, cost/turn
