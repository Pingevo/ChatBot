# R3 — Bot-worker production canary plan

## Scope (verified: send path still mock — no real delivery exists)

Inbound real (read messages_shp) → bot draft → shadow_replies → human review. Outbound = mockSendService only. Canary = prove pipeline under real traffic, not real sends.

## Gates (all must pass)

1. **Cost stop**: ai_usage docs/day bounded; alert if >N calls/day (uses R0 ai_usage)
2. **Concurrency 1**: bot_worker processes one conversation at a time (config bot_worker_concurrency=1)
3. **One-shop admission**: bot_worker_platforms/shops whitelist → single shop only (setBotWorkerPlatformEnabled CAS)
4. **Forced stop**: disable flag → in-flight settles, no new claims; dormant messages stay dormant (verified mechanism)
5. **Restart/recovery**: kill worker mid-claim → restart → reconcile-only recovery (verified earlier Test C)
6. **Deployment gate**: review admin id set + can_review verified per shop

## Evidence required before enabling

- [ ] canary shop name + approval (USER DECISION)
- [ ] baseline: ai_usage cost/day, claim latency, dormant rate 3 days
- [ ] kill test on prod-equivalent worker
- [ ] rollback: flags off → zero new claims (verified)

## NOT in scope

- Real platform sends (no API wired; separate workstream)
