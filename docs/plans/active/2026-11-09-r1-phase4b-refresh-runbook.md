# R1 — Phase 4B Evidence Generation Refresh Runbook

**Owner path:** `chatbot/shopeechat/scripts/` · **Publish owner:** `publish_generation.py` (validate → manifest finalize → fenced CAS → cleanup) · **Pointer:** `sellable_units_meta {_id:"active"}`

## Components (verified exist)

| Step | Script | Output |
|---|---|---|
| units docs | `build_sellable_units.py` → `sellable_units_<gid>` coll + JSONL | gen collections |
| image texts | `build_image_texts.py` → `image_texts_<gid>` | OCR evidence |
| embeddings | `build_embeddings.py` → `unit_embeddings.npz`, `product_embeddings.npz` | vectors |
| publish | `publish_generation.py --gen-dir exports/gen/<gid> --gid <gid>` | CAS pointer + cleanup 24h grace |
| rollback | `publish_generation.py --rollback --expected-active <gid>` | swap previous |

`mint_generation_id()` → `gYYYYMMDD-HHMMSS-<hex8>`; artifacts live `exports/gen/<gid>/`.

## Operator steps (first manual refresh)

```bash
# 1) mint gid + build (เวลา/ค่าใช้จ่ายจริง — บันทึก)
GID=$(python -c "from chatbot.shopeechat.generation_pointer import mint_generation_id; print(mint_generation_id())")
python chatbot/shopeechat/scripts/build_sellable_units.py --gid $GID
python chatbot/shopeechat/scripts/build_image_texts.py --gid $GID   # provider cost
python chatbot/shopeechat/scripts/build_embeddings.py  --gid $GID   # provider cost
# 2) validate + publish (CAS; expected=auto = pointer ปัจจุบัน)
python chatbot/shopeechat/scripts/publish_generation.py --gen-dir exports/gen/$GID --gid $GID --expected auto
# 3) verify: pointer doc + resolve_snapshot() returns new gid; rollback path:
#    publish_generation.py --rollback --expected-active $GID
```

## Schedule (09:00 daily — pending user approval of host)

Proposed crontab on bot host (not yet installed):
```
0 9 * * * cd /path/to/repo && ./scripts/r1_refresh.sh >> logs/r1_refresh.log 2>&1
```
`r1_refresh.sh` = steps above + timing/cost capture + on CAS conflict abort with `conflict:<gid>` log (no retry loop per contract).

## Safety invariants (from publish owner)

- Single fenced CAS publish; loser cleans own staged rows only
- Old generation retained as `previous` (rollback target); grace 24h before cleanup
- `image_texts_<gid>` per-gen published vs shared cache — resolver rejects cross-gen
- Never delete active/previous/<24h artifacts

## Remaining for R1 close

- [ ] First manual run on prod data — record wall time + provider cost per step
- [ ] Wrap steps in `r1_refresh.sh` (atomic stop-on-error)
- [ ] Install 09:00 cron after user approves host/timezone
- [ ] Post-runbook: confirm cleanup of >24h superseded gens
EOF
