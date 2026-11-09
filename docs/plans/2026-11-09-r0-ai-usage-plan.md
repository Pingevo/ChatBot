# R0 — ai_usage instrumentation + prompt distillation plan

## Verified baseline (checked before writing — no guessing)

- **Token usage exists** at ~7 call sites in `llm.py` (lines ~920, 1333, 1558, 1632, 1766, 1881) — extracted from `usage_metadata` (prompt/candidates/total)
- **NOT persisted anywhere** — `admin_logs`/`test_chat_logs` have no token/cost fields; only used transiently (quota tracker `_q_tok` deque)
- **`_gemini_cost` exists** (line 24, rates in `$/M`) but never called → cost math available but unused
- **Latency** — `bot_elapsed_ms` in shadow_replies p95=46.5s (39k samples) — this IS persisted ✓
- **Prompt size unknown** — SYSTEM_INSTRUCTION + product cards + history assembled per call; never measured

## Design (minimal, mirrors existing patterns)

New collection `ai_usage` (admin db) — one doc per LLM call:
```
{ts, model, path: "answer"|"vision"|"typed"|"description"|..., shop, conv_id,
 prompt_tokens, output_tokens, total_tokens, est_cost_usd, elapsed_ms,
 cache_hit?, request_id}
```
- Log via single helper `_log_usage(...)` in llm.py — called at each usage_metadata extraction site
- Fire-and-forget (match admin_logs pattern), no request-path blocking
- Env kill-switch `AI_USAGE_LOG=0`

## Steps

1. Add `_log_usage()` + wire the ~7 call sites (same commit, verify py_compile + one live call writes doc)
2. Wait 1-2 days production data → measure: tokens/call by path, cost/day, p50/p95 prompt size
3. THEN distill prompt — target biggest contributors only (never guess)

## Explicitly not doing

- No prompt changes until data exists (per spec: measure before reduce)
- No new external service — reuse admin Mongo + existing write pattern
