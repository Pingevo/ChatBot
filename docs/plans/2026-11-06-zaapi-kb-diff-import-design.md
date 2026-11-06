# Zaapi KB — Search Coverage + Diff-Import Redesign Audit & Contract

**Status:** rev5 — fourth independent-review findings addressed → STOP
GATE. No production changes. Date: 2026-11-06.
Session: เดิม on `feature-botlogic-kb-workflow` @ c289371.

**Goal (locked):** (1) ค้นครบตามขอบเขตที่พิสูจน์; (2) re-upload ไฟล์เต็ม
→ เปลี่ยนเฉพาะที่แก้จริง; (3) import log ย้อนตรวจได้; (4) เก็บประวัติ;
(5) Zaapi = pool source อิสระ — ไม่หลอม facts ลง Mongo/units, ไม่แอบใช้
legacy; (6) พิสูจน์ด้วยคำตอบลูกค้าจริง.

**rev4 changes vs rev3 — contradictions reproduced then fixed:**
- **R1 reproduced:** keep-prior record's `row_content_fp` ≠ new
  snapshot row's fp → prior record can NEVER prove membership under
  the new file → default becomes **hold-publish** (manifest unmoved,
  customer served prior revision, log records row+reason). keep-prior /
  `stale_reason` / `stale_count` mechanisms removed.
- **R2 reproduced:** rev3 P4 accepted `rec:WRONG` — it checked uid
  presence but never `record_id ∈ row_map[uid]` → membership
  validator now includes the record_id check (§6).
- **row_uid unified:** opaque `{source_id}:r{n}` for ALL modes;
  declared key column = match aid only; `key_map {key_value: row_uid}`
  in registry; confirmed rename → **same uid persists** (record content
  change = `changed` event, not deactivate+add); key collision → STOP.
- **Combined probe** `/tmp/zaapi_combined_probe_v5.py` — continuous
  scenario Q1–Q9, assert-hard, exit 0 (supersedes split probes).

**rev5 changes vs rev4 — two more contradictions reproduced + fixed:**
- **A reproduced:** quarantined NEW row leaves `(fp,shop,platform)`
  tuples in `expected` but absent from `delivered` →
  `validate_manifest_records` fails → rev4 quarantine can't pass its
  own validator. Fix: `revision.quarantined[]` bound inside the
  revision doc (hashed into revision_id) — validator accepts
  `expected == delivered ∪ quarantined-expansion` with disjointness.
- **B reproduced:** key_map on a separate registry doc mutates at
  rename-confirm → extraction fail → hold-publish → **registry ahead
  of manifest** → retry of old file can't match old key → uid churn.
  Fix: `key_map` lives **inside the revision doc** — "active mapping" =
  active revision's map, consistent by construction; registry keeps
  only `uid_next` + `staged` (crash-resume) + `lease` (concurrency).
- Combined probe upgraded to `/tmp/zaapi_combined_probe_v5.py` —
  Q1–Q9 continuous, exit 0 (incl. staged-resume, precas-crash,
  CAS-conflict, rename+fail atomicity).

**rev6 changes vs rev5 — three findings reproduced + fixed (mechanism
delta +0):**
- **F1 reproduced:** process restart empties the importer's `uid_fp`
  cache → an edited EXISTING row is classified NEW → lands in
  quarantine → publish **silently drops a previously-delivered row**.
  Fix: classification is durable — `EXISTING = row_uid ∈
  active_revision.row_map`; in-process caches may memoize extraction
  but are never classification authority.
- **F2 reproduced:** ghost `quarantined.row_uid` (fp/reason kept) →
  fp×account set coverage accepted it. Fix: validator works per-UID —
  quarantined uid must exist in the active snapshot with matching fp +
  non-empty reason; `row_map ∩ quarantined = ∅`; duplicate quarantined
  uids rejected; coverage is counted per `(uid × account)`, never
  fp-set deduped.
- **F3 reproduced:** old Q8 rewound the manifest pointer by hand and
  had an `or True` assertion. Deeper flaw: a single shared `staged`
  slot let importer A's file_fp-mismatch **discard importer B's pinned
  diff**, so B re-based cleanly and no CAS conflict could ever occur.
  Fixes: `expected_rev` pinned at match time and persisted inside
  `staged`, which is now keyed per importer tag; CAS loser discards
  only its own staged attempt and re-bases — no pointer rewind, no
  hand-edited state, no always-pass checks.
- Probe → `/tmp/zaapi_combined_probe_v5.py` Q1–Q12 continuous, exit 0
  (restart-HOLD, six quarantine-membership rejections, true CAS race,
  quarantined-row refail/success).

**rev7 changes vs rev6 — two findings reproduced + fixed (mechanism
delta +0):**
- **A reproduced:** forged candidate moving a DELIVERED uid from
  `row_map` into `quarantined` (content edited, fp matches the new
  snapshot) validated clean — the validator checked within-revision
  membership but never lineage. Fix: validator rejects any quarantined
  uid present in `revisions[expected_rev].row_map` (the revision's
  diff base) — delivered→quarantined is forbidden; the importer path
  already holds instead.
- **B reproduced:** same-file re-import emitted a second `published`
  event AND rewrote the stored revision doc (`expected_rev` audit
  mutated None→revX — attempt N rewrote attempt 1's history). Fixes:
  identical-file-fp import → `noop` (no extraction calls, no write,
  pointer unmoved, `noop_reimport` logged); revision-doc write is
  insert-only — same rev_id+same payload = reuse untouched, same
  rev_id+different payload = reject (never overwrite).
- Probe → Q1–Q15 continuous, exit 0 (adds forged-lineage reject,
  noop/idempotency incl. zero extractor calls, collision reject,
  insert-only reuse, precas-retry no-overwrite).

**rev8 changes vs rev7 — noop predicate root-caused (mechanism +0):**
- **Review reproduced:** same file + quarantined row → `noop`, row
  never publishes; same file + new account → `noop`, account gets no
  records. Root cause: the rev7 noop predicate compared **file_fp
  only**. Fix: noop requires the FULL active contract — file fp ∧
  `scope_fp` (accounts, mirrored from `account_scope_fingerprint`) ∧
  `model_version` ∧ `prompt_version` ∧ `schema_revision` ∧
  `quarantined == []` ∧ no pending own staged. Anything else runs the
  import path; a retry that converges to the identical active revision
  logs `noop_reimport{reason:retry_converged}` instead of a fake
  publish. `scope_fp` moves into the hashed revision payload (it was
  already in the doc schema — probe only lacked it).
- Probe → Q1–Q17 continuous, exit 0 (same-file quarantine retry
  fail/success, ±account scope delta, identical-rows-new-fp stable
  ids).

**rev9 changes vs rev8 — K0 review, two holes (mechanism +0):**
- **Scope sim reproduced:** probe hashed account **ids only** → shop
  rename (same id, same file) → `noop`, while production
  `account_scope_fingerprint()` (`kb_zaapi_schema.py:74`) hashes
  `(id, canonical_delivery_scope(name, platform))` → fp changes.
  Fix: probe calls the REAL owner function; rename/platform edit now
  publishes — renamed account's records re-mint (delivery scope
  changed), other accounts byte-stable, 0 extractor calls.
- **D2 contract corrected** `[โค้ด]`:`capability_asks` is stamped
  **only on product-kind needs** (`turn_decision.py:798-816`) and
  policy producers emit `refs`-only needs (`:766-781`) →
  asks+facts-both-empty → `no_query` persists. Locked contract:
  `TurnNeed.query_excerpts` = **producer-stamped, source-grounded
  excerpt** — non-productish producers (policy/faq/note/troubleshoot)
  stamp the normalized question text that fired them (producers
  already hold `norm`; no new regex/keyword tables); product needs
  keep `capability_asks`; retrieval forms `semantic_query` from the
  need's excerpts — empty excerpt ⇒ honest `no_query`, never
  fabricated. Acceptance uses a real `decide()` need.

**rev10 changes vs rev9 — K0 review, retrievable≠answerable +
taxonomy (mechanism +0):**
- **Answer-chain gap mapped `[โค้ด]`:** serving non-productish needs
  requires FOUR owner changes, not one: `kb_zaapi.py:61-63` (prodish-
  only request loop — `zaapi_no_productish_need`), `answer_context.py:
  650` (`idxs &= prodish_idx` strips binding), `:587` (`rt==
  troubleshooting` hard-reject in `_kb_zaapi_need_ok`), `:1030-1035`
  (non-productish → `UnansweredNeed(deferred)`, no NeedTask). §7.3
  now names consumer/owner + acceptance per kind; `claim`/`order`/
  `human` declared out of Zaapi scope (other owners).
- **Taxonomy corrected `[โค้ด]`:** `TurnNeedKind` (:98) has no `faq`/
  `note` — those are RECORD kinds. D1 restated: need kinds
  `{policy, troubleshoot}` → record kinds `{policy, faq, note,
  troubleshooting}`.

**rev11 changes vs rev10 — K0 review, attribution + compose authority
(mechanism +0):**
- **Fifth choke point `[โค้ด]`:** `needs_for_request`
  (`retrieval_selection.py:191-228`) filters EVERY branch through
  `prodish`; the `kb`+refs branch (:218-225) matches by exact
  ref-equality → a policy need carrying `subject_refs` issues a
  `ch:kb:<i>` request that attributes to NOTHING → `req_needs` link
  broken upstream of `_attribute`.
- **NeedTask contract retracted `[โค้ด]`:** `compose_answer` (:2376)
  already has a deterministic policy authority — `policy_decision`
  (`policy_resolver`, fail-closed before boundary per locked test
  `test_phase7_answer_context.py:599`, which also locks
  `policy ∉ task.tasks`). rev10's "served need → NeedTask" violated
  both. Correct contract: served need covered by
  `DomainResult(domain=kind, origin="zaapi", text=record body)` at
  `compose_answer`; `policy_decision` covers first (typed outcome =
  action semantics), Zaapi fills only when no decision; unbound →
  `deferred` unchanged.

**rev12 changes vs rev11 — K0 review, render path + early return
(mechanism +0):**
- **Sixth/seventh choke points `[โค้ด]`:** `_render_composition`
  (`app.py:760`) renders `domain=="policy"` via
  `policy_outcome_text(r.outcome)` — `r.text` IGNORED (empty outcome
  → admin-review wording) → Zaapi result domain corrected to
  `"zaapi"` (non-policy → `r.text` verbatim — no renderer change).
  `app.py:2030-2152` — `return_policy` `_pdec` branches all
  `return` before grouped retrieval → Zaapi never searched.
- **Question-class split locked `[โค้ด]`:** class-E eligibility
  (return_policy + `_subject_cards`/`_pd_mixed`/policy need w/
  product refs) → `_pdec` owns 100%, Zaapi never competes; class-I
  informational (policy need, no eligibility context) → Zaapi-served;
  `_pdec` unknown/admin_review handoff DEFERRED past compose for
  class-I — bound evidence → answer; unbound → identical handoff
  (no-evidence behavior preserved byte-for-byte).

All /tmp probes = **design simulation** `[sim]` — GREEN must re-run
through the real importer/schema/generation owners post-implementation.

---

## 0. Evidence key

`[โค้ด]` verified in source · `[ไฟล์]` verified on disk/export ·
`[Mongo สด]` live read-only census · `[log เดิม]` ledger ·
`[ยังไม่พิสูจน์]` declared-unverified · `[sim]` design simulation.

---

## 1. FREEZE (rev3 recheck)

frozen 8,624 lines `a67b…` ✓ · active prefix 1..11895 `cc82…` ✓ ·
EOF = baseline · dirty: ledger+active+2 plans only · no secret reads ·
no Mongo/provider/config writes.

---

## 2. CENSUS

### 2.1 Files `[ไฟล์]` — unchanged from rev2
118 items ≡ repo copy, 118/118 sha256 OK, 113 xlsx + 5 txt,
`version_count`=1, accounts 1–68/source, URLs as cell text.

### 2.2 Key ledger — **rev3: candidates, not "stable keys"**
(`[ไฟล์]` `/tmp/zaapi_keyledger.py` → `/tmp/keyledger.json`)

Declaration rule: a column is a candidate only after passing
**100% complete AND normalized-unique** (whitespace-collapse + casefold)
across **every sheet of the file** — checked at declaration AND
re-validated every import. `ชื่อสินค้า`/ลิงก์/รายละเอียด-class columns
that are unique *today* are **mutable-value keys**: allowed as declared
key, but editing the key value is an identity change → preview shows a
**rename proposal** for human confirm — never auto-applied; on confirm
the same `row_uid` persists (§4.2).

| class | files | notes |
|---|---|---|
| column-mode candidates | **66** | 24 modelish (`รุ่น/SKU/รหัส`), 32 name-mutable (`ชื่อสินค้า`), 7 text-mutable (`คำถาม/ปัญหา`), 2 link-volatile, 1 other |
| assigned-mode | **52** | 45 no-viable-key (incl. 5 txt) + **6 Products-Balance files whose `ชื่อสินค้า` fails normalized-uniqueness** (whitespace/case-only dups — found only by the stricter check) |

Per-source ledger fields (`/tmp/keyledger.json`, all 118): source_id,
proposed key cols, completeness, norm_uniq, volatility class, mode,
human-confirm item. Auto-adopted keys forbidden: `#`/sequence,
row_index, filename. **"73" was a single-snapshot candidate count —
declaration is per-source and human-confirmed.**

### 2.3 Mongo `[Mongo สด]` — unchanged
`zaapi_kb` 8,600 legacy · `zaapi_kb_raw_sources` 8,600 (118 src,
`active:false`) · `zaapi_kb_records` **0** · generations coll absent ·
`kb_source=legacy`. In-Mongo ≠ searchable.

---

## 3. FINDINGS — verified verbatim, then designed

### 3.A 1 raw row → N canonical records **[โค้ด] PRODUCTION code**

`import_zaapi_kb.py:313-330` — one extraction output, then
`from_extraction(..., shop=a["name"], platform=a["platform"])`
**per account**. Probe on the real dataclass: 1 row × 2 accounts →
2 record_ids (`rec:42f2…`, `rec:e8e7…`) sharing `scope_fingerprint`
+ `source_snapshot_id`. Sources run 1–68 accounts → records are up to
68× rows. **Any `row_uid → record_id` scalar map is factually wrong —
must be `{row_uid: {account_key: record_id}}`.**

### 3.B "73 stable keys" — single-snapshot candidates with mutable values
Corrected §2.2: 66 pass 100%-complete + normalized-unique; 6 big
Products-Balance files fail normalization (invisible dups); name/link/
text keys are mutable → proposal-on-edit semantics (§4.2).

### 3.C Changed-row extraction failure could silently erase prior data
v1 was accidentally safe (all-or-nothing → old revision stays). rev2's
quarantine-as-written had the hole: a previously-resolved row whose edit
fails extraction would drop out of the new revision → row vanishes from
active view **silently**. Contract fix §5.2.

### 3.D Reused record keeps OLD file provenance while manifest points NEW
**[โค้ด] verified with the real schema** — `validate_manifest_records`
(lines 506-510) requires record doc `source_fingerprint /
scope_fingerprint / source_revision` **equal** the pointer's → a v1
record under a v2 pointer is rejected by construction
(probe: `mismatch=True`). Record docs are immutable, so their
file-bound fields can only ever be *first-seen* provenance. v2
membership proof must live in `revision.row_map` + raw index (§6.2),
not in doc fields.

### 3.E Standing verified causes (rev1, unchanged)
CE1 file-fp identity churn · CE3/CE4 checkpoint-key file-fp orphaning ·
CE5 blank-row renumbering · CE6 silent header removal · CE7
identity-required publish wall · CE8 productish-only adapter + missing
query text on non-productish needs · stale `zaapiKbReady` counting
legacy docs.

---

## 4. ROW IDENTITY + FILE-DIFF CONTRACT (v2, rev3-fixed)

### 4.1 Modes + uid model (rev4)

`row_uid` = **opaque `{source_id}:r{n}`** for every mode — minted once,
never derived from mutable data. The declared key column is a **match
aid only** (finds which row is which across files), never the identity
itself — so key-value edits become `changed` events on the same uid
after confirmation, not identity changes.

`zaapi_kb_source_registry` (rev5 — no active mapping here):
`{source_id, key_mode, key_columns, volatility_class, uid_next,
staged: {importer_tag: {file_fp, adds: {key: uid}, expected_rev,
confirmations}}, lease: importer_tag | null, declared_by,
declared_at}` — `staged` is per-importer attempt (rev6: a shared slot
let one importer wipe another's pinned diff); `expected_rev` inside it
is the CAS base pinned at match time. Column-mode (66 candidates,
human picks per-source) or assigned-mode (52).
**The active key→uid mapping lives in the revision doc** (§4.3);
registry holds only the allocator + in-flight stage. Forbidden match
aids: `#`, row_index, filename, columns failing 100%-complete or
normalized-unique. Re-validated on **every** import.

### 4.2 Diff semantics — mutable-key rule added

| case | detection | action |
|---|---|---|
| unchanged | same row_uid + same `row_content_fp` | reuse record+vector |
| field changed | same uid, fp differs | `update`, field diff |
| field cleared | field absent under existing header | `clear` |
| row added | new key/uid | `add` |
| row removed | uid absent | `deactivate` — preview-only, needs confirm |
| **key value edited** (mutable key) | old key gone + new key, counts equal | **rename proposal** — human confirms; uid persists (row = `changed` event via new content fp); confirm updates `key_map{new_key: uid}` + drops old key; collision with another mapped key → STOP |
| rows gone + new rows, counts differ | — | separate `add` + `deactivate` proposals |
| dup/blank key | column mode | **STOP** |
| header removed/renamed | header-set diff | **STOP** |
| header added | header-set diff | `field_added` updates |
| sheet removed | — | review |
| ±account | accounts **exact-set** diff | scope_add/scope_remove — only that account's records change (P1) |
| txt edit | text diff | whole-doc update |

`assigned` mode: (1) exact `row_content_fp` → inherit uid
(position-free); (2) leftovers → positional proposal, human confirm;
ambiguous → STOP.

### 4.3 Record identity v2 — field split (unchanged from rev2)

Identity-hashed: `source_id, row_uid, sheet, row_content_fp,
shop, platform, record_type, topic, model_codes, aliases, item_id,
model_id, subject_id, target_id, facts, answer_text, steps, readiness,
model_version, prompt_version, schema_revision`.

Provenance-unhashed (= **first-seen only**, immutable doc keeps the
values of the import that created it): `source_fingerprint,
source_revision, source_snapshot_id, scope_fingerprint, source_row,
created_in_batch`.

**`revision` doc (rev5):** `{source_id, source_fingerprint,
source_revision, scope_fingerprint, row_map: {row_uid: {account_key:
record_id}}, key_map: {key_value: row_uid}, quarantined: [{row_uid,
row_content_fp, reason}], model_version, prompt_version,
schema_revision, expected_rev}` —
`revision_id = fp(all except expected_rev)`;
`expected_rev` is audit-only (which base it diffed against — rev6).
`key_map` embedded here = the active mapping is always the active
revision's map (finding B fix); `quarantined` bound here = coverage is
provable per-revision (finding A fix). Records still
per-(shop,platform); extraction per-row shared across accounts.

### 4.4 Checkpoint v2 — unchanged
`fp(source_id, scope_fp, model, prompt)`; row cache by
`row_content_fp` → edited file re-extracts only changed rows.

### 4.5 D1 scope-only resolution — unchanged
`resolved` w/o identity for `{faq,policy,note}` (±troubleshooting) →
semantic-channel-only records.

### 4.6 One-time migration — rev4 uid model
`zaapi_kb_row_map`: v1 raw rows ordered `(sheet,row_index)` → mint
opaque `{source_id}:r<n>` for **all** sources; column-mode sources also
seed `key_map[keyval]=uid` from declared keys; v1 docs untouched; first
v2 import diffs against v1 baseline via the map.

---

## 5. FAILURE POLICY (rev4 — hold-publish; finding C + R1)

R1 proof: a prior record's `row_content_fp` can never equal the edited
row's fp in the new snapshot → keep-prior under a new file is
**unprovable** membership — removed. Defaults:

| failure class | semantics | customer answer | visibility |
|---|---|---|---|
| **NEW** row fails extraction/validation | **revision-bound quarantine**: revision publishes minus it; `quarantined[{row_uid, row_content_fp, reason}]` inside the revision doc (hashed, immutable) | row absent (never existed) — coverage gap, provable per-revision | preview + log `quarantined_new`; validator per-UID delivered-XOR-quarantined (§6) |
| **EXISTING** row edited, then extraction/validation fails | **HOLD PUBLISH**: no new revision; manifest stays on prior revision | **prior revision fully served** — customer gets old data for the whole source until fixed | log `hold_publish{rows, reason}` |
| key ambiguous / header removed / key collision / assigned-match ambiguous | **STOP** entire source | prior revision served | log `stopped` |
| mid-apply crash | manifest CAS unmoved | prior revision served | resume via checkpoint |

**Row classification is durable (rev6, F1):** a row is **EXISTING**
iff `row_uid ∈ active_revision.row_map`. A uid in
`active_revision.quarantined` stays **NEW-class** (it never answered a
customer) — re-upload: refail → quarantined again under the SAME uid;
success → moves into `row_map`; content-changed + fail → quarantined
with the new fp. Extraction caches (`uid_fp`/`uid_sem`) may memoize
work but are NEVER the classification authority — a process restart
cannot reclassify a previously-delivered row into NEW.

**Lineage invariant (rev7, A):** quarantine may only hold uids that
have NEVER been delivered. Formally: `candidate.quarantined ∩
revisions[candidate.expected_rev].row_map = ∅` — a uid delivered in
the diff base can transition to delivered (changed content) or the
import holds; it can NEVER transition to quarantined. The validator
enforces this retroactively on the active revision, so even a forged
or corrupt activated doc is rejected.

**Idempotency invariant (rev8 — file fp alone ≠ "no work"):**
`noop ⟺ file_fp == active_rev.fp ∧ scope_fp == active_rev.scope_fp
∧ model_version == active_rev.model_version ∧ prompt_version ==
active_rev.prompt_version ∧ schema_revision == active_rev.
schema_revision ∧ active_rev.quarantined == []` — the predicate reads
the **active revision's stored contract**, not the file alone.
`scope_fp` IS `account_scope_fingerprint(accounts)` (owner
`kb_zaapi_schema.py:74`) — hashes `(id, canonical_delivery_scope(name,
platform))`; a shop rename or platform change IS a scope change →
publish (that account's records re-mint; others byte-stable), never
noop.
Anything else enters the import path (state-transition table §5.3).
A run whose computed revision converges to the identical active
rev_id (e.g. quarantined row fails again) logs
`noop_reimport{reason:retry_converged}` — honest retry, not a fake
publish. The revision doc is **insert-only**: `rev_id` exists + same
hashed payload → reuse untouched; different payload → reject
(collision — never overwrite). `expected_rev` records the diff base
of the creating attempt and is never mutated by later attempts.
Note: `source_revision` is a lineage label, not part of the predicate
— filename and per-upload counters are never identity inputs.

### 5.3 State-dimension transition table (rev8 — census of ALL inputs)

| dimension changed (others equal) | outcome | extractor calls | log event |
|---|---|---|---|
| file_fp same + contract same + quarantined ∅ | **noop** | 0 | `noop_reimport{identical_contract}` |
| file_fp same + quarantined pending, retry fails | converged noop; uid stays quarantined | pending rows only | `noop_reimport{retry_converged}` |
| file_fp same + quarantined retry succeeds | publish; uid moves into row_map | pending rows only | `published` |
| file_fp same + account added | publish; only new account's records minted, others byte-stable | 0 (unchanged rows reuse) | `published` + `scope_added` |
| file_fp same + account removed | publish; that account's membership dropped, others byte-stable | 0 | `published` + `scope_removed` |
| file_fp same + model/prompt/schema changed | publish; NOT noop — extraction contract changed; uids stable, rows re-evaluated per extraction-owner policy | per extraction owner | `published` |
| file_fp same + own staged pending | resume staged (same uids + same pinned base), then apply above | per path | — |
| file_fp new + rows identical | publish new rev (fp hashed in); uids/record_ids byte-identical | 0 changed rows | `published` |
| file_fp new + row content changed | diff → changed/new/deactivate per row | changed rows only | `published` |
| delivered→quarantined (forged/corrupt) | validator rejects active state | — | — |

Atomic unit = manifest CAS; revision+records insert-once immutable →
failed apply leaves orphaned docs at worst, never a half-swapped
pointer. Rollback = prior pointer/revision (`rollback` fields in log).

**No "fail-closed" glossing:** every path states whether the customer
gets old data, partial-new data, or no data — and the log records it.

### 5.1 Rejected alternative — hold-publish for new-row failures
Simplest mechanism (nothing new), but one malformed new row would block
every other change in the file — the same all-or-nothing wall as CE7,
against the locked workflow ("เพิ่ม 1–3 สินค้าต้องเพิ่มเฉพาะรายการ
นั้น"). Revision-bound quarantine keeps the publish provable AND
progressing; cost = 1 revision field + 1 validator clause.

### 5.2 Atomicity + recovery (finding B — rev5)

State classes and write order per import:

| state | where | class |
|---|---|---|
| raw snapshot rows | `zaapi_kb_raw_sources` | immutable (insert-once + readback) |
| uid allocator `uid_next` | registry | monotonic; **gaps harmless** (uids opaque) |
| `staged` {tag: {file_fp, adds, expected_rev}} | registry | per-IMPORTER working set — written BEFORE extraction; other importers may never discard it |
| revision doc (row_map + key_map + quarantined) | `zaapi_kb_records` | immutable, inactive until pointed |
| manifest pointer | `zaapi_kb_records` `active:manifest` | CAS fenced on expected_rev |
| import log | `zaapi_kb_import_log` | append |

Write order: (1) lease source (single importer) → (2) match via ACTIVE
revision's `key_map` and **pin `expected_rev` = the revision diffed
against** + stage new uid allocations under the importer's own tag
(persisted before any extraction — crash/resume keeps uids AND the
diff base; retry does not re-mint) → (3) extract changed/new rows →
changed-row failure = hold-publish (own staged kept for same-file
retry) → (4) write revision doc (**insert-only**: absent→insert;
same-id+same-payload→reuse; same-id+diff-payload→reject) →
(5) manifest CAS fenced on the pinned `expected_rev` → (6) clear own
staged → log. Step 0: full-contract noop predicate (§5.3) → `noop`
(no extraction, no write, `noop_reimport` log).

- CAS conflict (concurrent imports): lease prevents same-source races
  in normal flow; if bypassed, the CAS fence fires — loser's publish
  fails because the manifest moved past its pinned `expected_rev`;
  loser discards only its own staged attempt, re-reads the new active
  revision, re-diffs; **loser's staged keys never reach active
  mapping** because mapping only materializes via the winning revision
  doc. The pointer is never rewound (rev6: proven by the true
  staged-resume race, not by editing state).
- Crash anywhere before CAS: manifest unmoved → customer sees prior
  revision; staged persists per-tag → same-file, same-importer rerun
  resumes uids and the original diff base.
- Active registry/manifest divergence is structurally impossible:
  the only "active" mapping is inside the pointed revision.

---

## 6. PROVENANCE VALIDATION (v2 — finding D)

### 6.1 Membership chain — one validator, every link (rev4)

```
active raw snapshot row ──(row_uid, row_content_fp)──┐
      accounts[] (shop,platform exact-membership)     ├─► record
revision.row_map[row_uid][account_key] = record_id ──┘
```

`validate_record_provenance` v2 checks **all of** (R2 fix — rev3's sim
omitted step 4 and provably accepted a wrong record_id):
1. `record.row_uid` ∈ raw index of the **active** snapshot — ghost/foreign uid rejected
2. `record.row_content_fp` == that raw row's fp — raw tamper + wrong-uid rejected
3. `(record.shop, record.platform)` ∈ snapshot `accounts` — cross-shop rejected
4. `record.record_id ∈ revision.row_map[record.row_uid].values()` **and**
   `row_map[row_uid][account_key(shop,platform)] == record_id` —
   wrong/mis-bound record_id rejected; 1:N honored (one uid → K
   account-keyed record_ids)
5. `validate_manifest_records` per-UID coverage (rev6 — finding F2):
   every `(row_uid × account_key)` in the active snapshot is delivered
   XOR quarantined:
   - each `revision.quarantined[]` entry's `row_uid` must exist in the
     active raw snapshot AND its `row_content_fp` must equal that
     row's fp — ghost uid and uid-swapped-same-fp both rejected;
     `reason` non-empty; duplicate quarantined uids rejected;
     `row_map ∩ quarantined = ∅` (a delivered uid can never be
     quarantined — quarantine cannot mask a previously-delivered row's
     failure)
   - lineage (rev7, A): each quarantined uid must be ABSENT from
     `revisions[rev.expected_rev].row_map` — a uid delivered in the
     diff base can never be quarantined by the next revision;
     delivered→quarantined transitions reject even when activated
   - delivered membership: `row_map[uid][account_key] == record_id`
     for every mapped uid × declared account
   - counting is per-UID: entries keyed by uid cannot collapse under
     fp-set dedupe (same-fp different-uid can't arise under
     declared-key mode anyway — identical full content = identical key
     = duplicate-key STOP at import)

### 6.2 Where provenance lives

| field set | location | mutability | meaning |
|---|---|---|---|
| `source_fingerprint`, `source_revision`, `source_snapshot_id`, `created_in_batch` | record doc (unhashed) | **immutable first-seen** | which import created the record — NOT "which file is current" |
| `row_uid`, `row_content_fp` | record doc (hashed) + raw docs | immutable | identity anchors for membership checks |
| `source_fingerprint`, `scope_fingerprint`, `source_revision`, `row_map`, `quarantine_count` | revision + manifest pointer | per-revision | which file/scope is ACTIVE |

A reused record therefore carries its original creation provenance
(old file fp — historical truth) while the pointer documents the new
file. Validators compare row_uid+content-fp+scope (facts about the
ROW), never doc.file-fp vs pointer.file-fp (facts about HISTORY).

### 6.3 Probe-verified `[sim]` (`/tmp/zaapi_combined_probe_v5.py` Q9)

clean revision → validates · wrong record_id → `!= expected` ·
retro-edited raw → `raw fp mismatch` · ghost uid → `uid absent` ·
foreign-source uid → `uid absent` · valid reuse → OK.
Raw tamper also blocked at write time by `_persist_immutable`
(insert-once + readback).

---

## 7. SEARCH COVERAGE CONTRACT — publishable ≠ answerable

### 7.1 Three-layer contract per content class

| corpus content | publish wall today | query path today | contract target |
|---|---|---|---|
| product spec/stock/link rows (identity OK) | publishes once extraction resolves | typed channels + semantic via capability_asks | unchanged |
| product rows missing identity | blocks whole source (CE7) | — | quarantine §5 |
| faq/policy/note rows (no identity) | blocked (CE7) | semantic-only reachable, but no query text produced (§3.E) | D1 publish + D2 query_excerpt |
| troubleshooting w/ model | blocked (CE7) | typed subject channel works once gate widened | D1+D2 |
| troubleshooting/policy w/o model | blocked | nothing — no refs, no text | D1 publish + D2 query_excerpt → semantic |
| txt/manual_input docs | blocked | nothing | D1+D2 |
| wrong-shop questions | — | `in_scope` exact shop+platform → 0 hits (by design) | keep |

### 7.2 Missing contract — declared

Non-productish needs have **no query-text producer**:
`semantic_query=" ".join(n.capability_asks)` but `capability_asks` is
docstring-scoped "stamp เฉพาะ product-kind needs" (turn_decision:152-155)
and produced only via `_rc.intent_fact_scope(intent)`. Policy needs DO
carry `subject_refs` (:768-781) → typed channels work for
model-mentioning questions today; model-less policy/FAQ questions get
`no_query`. `retrieve()` itself already accepts semantic-only input
(:312) — the gap is production, not retrieval.

**Proposal (smallest owner):** `TurnNeed.query_excerpts: tuple[str,..]`
stamped by each served need's own producer site (policy/troubleshoot
`_add_need` calls attach a source-grounded excerpt — same
producer-side validation vs message as capability_asks). Adapter:
`semantic_query = " ".join(n.query_excerpts or n.capability_asks)`.
No free-text turn scan; no new keywords/regex. Owner change on
turn_decision + adapter — requires approval (D2). Rejected alternative:
reusing `capability_asks` on policy needs — violates its typed semantic.

### 7.3 Need-kind → record-kind → answer contract

`TurnNeedKind` (turn_decision:98) = `{product, compare, compat,
policy, order, troubleshoot, claim, human}` — `faq`/`note` are
**record** kinds, not need kinds; no need producer emits them.

| need.kind | producer (owner) | record kinds served | chain today | verdict |
|---|---|---|---|---|
| product/compare/compat | intent/product needs | product, compatibility | typed channels → evidence → NeedTask | works `[โค้ด]` |
| policy | warranty_duration, general_question, shipping (:762-781) | policy, faq, note | 7 choke points below → deferred | served after chain lands (T45a-I) |
| troubleshoot | troubleshoot detector | troubleshooting, faq, note | same + rt=troubleshooting reject | served after chain lands (T45b) |
| claim | claim/warranty flow | — | owner = claim flow, not KB | out of Zaapi scope (declared) |
| order | order intent | — | order_store | out of scope |
| human | handoff | — | handoff | out of scope |

**Retrievable ≠ answerable — seven choke points `[โค้ด]`:**
1. `retrieval_selection.py:218-225` — `needs_for_request` `kb`+refs
   branch matches prodish-only by exact ref-set equality; a served
   need carrying refs attributes to nothing (bare `kb` = context
   channel, already covers all needs)
2. `kb_zaapi.py:61-63` — request loop is prodish-only; non-productish
   needs never issue a retrieval request (`zaapi_no_productish_need`)
3. `answer_context.py:650` — `idxs &= prodish_idx` strips evidence→
   need binding even if evidence reached the pool
4. `answer_context.py:587` — `rt == "troubleshooting"` → `return
   False` in `_kb_zaapi_need_ok` (reserved for a tips/policy owner
   absent from this path)
5. `answer_context.py:1030-1035` + `:2376-2380` — non-productish →
   `deferred` (no NeedTask — LOCKED, `test_phase7:599`), and policy
   needs have an existing deterministic authority
   (`policy_decision`/`policy_resolver`, fail-closed before the
   boundary): Zaapi must fill, never compete
6. `app.py:760` (`_render_composition`) — `domain=="policy"` renders
   `policy_outcome_text(r.outcome)`, `r.text` ignored → Zaapi results
   MUST NOT use `domain="policy"`; `domain="zaapi"` renders `r.text`
   verbatim under the existing contract
7. `app.py:2030-2152` — `return_policy` `_pdec` →
   `unknown/admin_review` → handoff `return`, `eligible/ineligible` →
   deterministic `return`; all before grouped retrieval → Zaapi is
   unreachable on this branch as written

**Required owner changes (acceptance contracts — prod code, T45):**
- adapter (`kb_zaapi.py`): request loop admits the shared allow-set
  (prodish ∪ served kinds); served needs query via
  `semantic_query = " ".join(n.query_excerpts)` — the D2 field;
  per-need `ch:kb:<i>` requests carry the need's own refs
- `needs_for_request` (`retrieval_selection.py`): the `kb`+refs
  branch matches the shared allow-set (prodish ∪ served), not
  prodish-only — same frozenset, one owner
- `_attribute`: for `kind == "kb_zaapi"` evidence only, allowed idx
  set = adapter-issuing needs (prodish ∪ served); all other evidence
  kinds keep `prodish_idx`
- `_kb_zaapi_need_ok`: record-type admission per need kind — policy
  need admits `{policy, faq, note}`; troubleshoot need admits
  `{troubleshooting, faq, note}`; the troubleshooting reject is
  lifted only for served needs
- `compose_answer`: served need WITH bound `kb_zaapi` evidence →
  `DomainResult(domain="zaapi", origin="zaapi", text=record body)`
  — NEVER a NeedTask, NEVER `domain="policy"` (renderer reads
  `outcome`, not `text`). Authority ordering: `policy_decision`
  covers policy needs first (typed outcome carries action semantics —
  handoff/admin-review); Zaapi fills only needs no decision covered.
  Duplicate/conflict rule: a need covered by `policy_decision` must
  not also emit a zaapi result (the `covered` set already enforces
  first-writer). Unbound served needs → `deferred`, unchanged.
  `compile_answer_task` untouched — `policy ∉ task.tasks` invariant
  (`test_phase7:599`) stays green.
- `_render_composition` — NO change: `domain="zaapi"` already falls
  into the `r.text` verbatim branch (`app.py:760`); `_DOMAIN_ORDER`
  missing-key fallback keeps deterministic ordering (primary key =
  need_index).
- `app.py` `_pdec` gate — question-class split on typed context:
  **class-E** (eligibility: `return_policy` + `_subject_cards`/
  `_pd_mixed`/policy need with product refs) → `_pdec` owns every
  outcome incl. `unknown→handoff` — Zaapi never competes, unchanged;
  **class-I** (informational: policy need, no eligibility context) →
  `_pdec` unknown/admin_review handoff is DEFERRED past compose:
  zaapi-bound → answer with record body; unbound → the identical
  handoff proceeds (no-evidence behavior preserved; a decision
  outcome, if one ever arises on class-I, still wins — Zaapi never
  overrides a decision).

`_PRODUCTISH` → shared allow-set owned in ONE place (adapter +
`_attribute` read the same frozenset — not two literals).

### 7.4 Negative cases (contract behaviors)

| case | expected |
|---|---|
| wrong shop | `in_scope` false → 0 hits; units path unaffected |
| wrong model | typed refs miss; same-shop policy may still hit via semantic (correct — warranty is shop-scoped not model-scoped) |
| topic mismatch | semantic can surface wrong-type records → record_type in meta; composer decides (provenance visible) |
| Zaapi has no product | 0 typed hits; units/Mongo continue; Zaapi never fabricates a card |
| Zaapi vs Mongo fact conflict | both emitted w/ provenance — never silently merged; rendering rule = D3 |
| Zaapi-internal conflict | `_fact_conflicts` → conflicted → not published |

### 7.5 Honest unanswerable list (after contract lands)

- `unresolved`/`invalid`/`conflicted` rows — logged, not silent.
- Admin `manual_edit` legacy docs under `kb_source=zaapi` (D6).
- `semantic_unavailable` on model-pin mismatch.
- Promotion expiry/freshness — data problem, not retrieval.

---

## 8. LOG + PREVIEW + READINESS — unchanged except

- `zaapi_kb_import_log` diff block gains:
  `quarantined_new[{row_uid, reason}]`,
  `proposals[{type:"rename"|"deactivate", from, to/rows, needs_confirm}]`,
  `hold_publish{rows, reason}` (event class on the same doc),
  `scope_added/removed[{account_id}]`,
  `noop_reimport{revision}` (identical-file upload — no publish).
- Pointer gains `quarantine_count` only (stale mechanism removed).
- Write classes: preview = active-data 0 / audit 1 / provider 0.
- `/internal/zaapi-kb/status` probe design (D4a) unchanged.

---

## 9. RED TEST PLAN + IMPLEMENTATION — consistency pass

### 9.1 RED matrix (rev3: T6 changed, T17 split, T23–T26 added)

| # | case | behavioral asserts |
|---|---|---|
| T1 | identical re-upload | noop: 0 extractor calls, doc byte-identical, pointer unmoved, `noop_reimport` logged |
| T2 | one-cell edit | changed=1; other ids byte-stable; extract=1 |
| T3 | +1–3 rows | added=N; row_map gains only new uids |
| T4 | renamed file | unchanged=N |
| T5 | insert row | neighbors stable |
| T6 | **mutable-key rename** | preview emits rename proposal; apply refused w/o confirm; after confirm → **same row_uid persists** (changed event), `key_map` updated, old key removed |
| T7 | dup key | STOP; 0 writes |
| T8 | blank under header | cleared=1 |
| T9 | header removed | STOP; 0 writes |
| T10 | row removed | deactivation preview; refused w/o confirm |
| T11 | header added | field_added events |
| T12 | **±1 account (1:N)** | scope counts; other accounts' record_ids byte-stable — verifies P1 |
| T13 | legacy manual edit + re-upload | unaffected; divergence reported |
| T14 | mid-apply kill | raw committed, pointer unmoved; resume converges |
| T15 | rerun | idempotent |
| T16 | txt edit | whole-doc update |
| T17a | NEW row fails extraction | quarantine; others publish; coverage logged |
| T17b | **EXISTING row edit fails extraction** | **HOLD PUBLISH**: no new revision; manifest stays prior; log `hold_publish{row,reason}`; answer serves prior revision |
| T18 | policy need w/o model | query_excerpt → semantic evidence (D1+D2) |
| T19 | wrong-shop | 0 hits; units unaffected |
| T20 | cross-source conflict | conflicted → excluded+logged |
| T21 | real customer answer | golden QA diff = edited fact only |
| T22 | readiness probe | status endpoint green ⇔ artifacts load |
| **T23** | **multi-account row** | 1 row × K accounts → K record_ids in row_map; all resolve to same row_uid |
| **T24** | **mutable-key re-key** | normalized-dup declaration refused (T7-variant); edit→proposal flow |
| **T25** | **provenance mismatch** | tampered raw / cross-shop / ghost uid / **record_id not in row_map** → validator rejects (S7) |
| **T26** | **raw retro-edit** | manual edit of stored raw → next validate fails closed |
| **T27** | **key collision** | two rows resolve to same uid (rename target collides with mapped key) → STOP |
| **T28** | **foreign-source record** | record_id of another source in row_map → validator rejects |
| **T29** | **quarantine coverage** | new-row fail → revision validates per-UID: delivered XOR quarantined; entry has matching fp+reason; row_map∩quarantined = ∅ |
| **T30** | **crash after staged alloc** | rerun same file+importer → same uids (no re-mint); own different file → own staged discarded, uid gap only |
| **T31** | **crash before manifest CAS** | manifest unmoved; rerun converges; orphaned revision doc never activates |
| **T32** | **concurrent same-source imports** | lease excludes second importer; bypassed lease → stale `expected_rev` → CAS conflict; pointer never rewound; loser discards own staged and re-bases; loser's keys never active |
| **T33** | **process restart** | restart → edited EXISTING row fails → HOLD-PUBLISH (classification = active_rev.row_map, not in-process cache); prior revision still served |
| **T34** | **quarantine membership tamper** | ghost uid / wrong fp / row_map∩quarantined / duplicate entry / empty reason / dropped entry → validator rejects each |
| **T35** | **quarantined-row retry** | refail → quarantined again, same uid; success → delivered into row_map, quarantine list cleared |
| **T36** | **delivered→quarantined** | forged/corrupt active revision moving a base-delivered uid to quarantined → validator rejects via lineage check |
| **T37** | **idempotent reimport** | identical file fp → noop: doc byte-identical, zero extractor calls, single publish event, `noop_reimport` log |
| **T38** | **immutable rev doc** | same rev_id+diff payload → reject, stored doc untouched; same id+same payload → reuse; precas-crash retry reuses doc (no overwrite) |
| **T39** | **same-file quarantine retry** | file_fp same + quarantined pending → import runs; refail → converged noop (uid stays, `retry_converged` log); success → published, uid into row_map |
| **T40** | **same-file ±account** | +account → publish, new account's records only, others byte-stable, 0 extractor calls; −account → that account's membership only dropped |
| **T41** | **same-file model/prompt/schema change** | NOT noop — full import path (prod contract; probe can't model version fields — acceptance for owner test) |
| **T42** | **new fp, identical rows** | new rev publishes; uids + record_ids byte-identical — filename/fp alone never re-keys |
| **T43** | **scope rename via owner fp** | same file + shop name/platform change (same account id) → publish, NOT noop; renamed account's records re-minted, others byte-stable |
| **T44** | **D2 excerpt contract** | real `decide()` policy need → `query_excerpts` non-empty → semantic channel; need with no firing text → `no_query` (prod-owner acceptance, not probe-modeled) |
| **T45a-I** | **informational policy Q @ `app.chat()`** | "นโยบายคืนสินค้าของร้านเป็นอย่างไร" (no subject) + Zaapi policy/faq record → final answer CONTAINS record body text; no handoff; `policy ∉ task.tasks` stays green |
| **T45a-E** | **eligibility policy Q @ `app.chat()`** | "เครื่องนี้คืนได้ไหม" w/ subject → `_pdec` owns (deterministic outcome or unknown→handoff); Zaapi result ABSENT from answer; decision never diluted |
| **T45a-∅** | **informational + no evidence** | class-I question, no matching record → identical pre-change outcome (unknown→handoff); nothing fabricated |
| **T45b** | **troubleshoot need end-to-end** | same DomainResult(zaapi) chain for troubleshoot need; `rt=troubleshooting` admitted only for troubleshoot needs — productish needs still reject it (line-587 invariant narrowed, not deleted) |
| **T45c** | **policy need WITH subject_refs** | `decide()` model-mentioning policy question → `ch:kb:<i>` request carries need refs → `needs_for_request` attributes (allow-set, not prodish) → evidence `need_indices` ∋ the policy need |

### 9.2 Changed-file manifest — same as rev2 + importer diff engine
gains hold-publish + proposal flows; schema gains 1:N row_map +
revision-embedded `key_map` + `quarantined` + registry
`uid_next`/`staged`(per-tag)/`lease` + `quarantine_count` on pointer +
registry/row_map validators.

### 9.3 Mechanism delta (net, rev4-corrected)

- helpers +7 (uid mint/validators, row_content_fp, diff engine,
  migration cmd, status handler, log writer, proposal emitter)
- guards +6 (dup/blank-key STOP, header STOP, ambiguity/collision STOP,
  preview-binding refuse, token check, **membership-chain validator
  incl. record_id∈row_map**)
- regex/keyword tables +0
- owner changes: `_PRODUCTISH`→allow-set, `query_excerpts` producers,
  `zaapiKbReady`→probe client (3)
- schema: opaque row_uid, row_content_fp, provenance set,
  **row_map 1:N**, **revision.key_map + revision.quarantined**,
  registry `uid_next`+`staged`+`lease`, `quarantine_count` on pointer,
  SCHEMA_REVISION 2
- collections: registry, row_map, import_log (3)
- **removed since rev3:** stale_reason/stale_count/keep-prior fields —
  hold-publish needs no new mechanism (manifest CAS already exists)
- **rev6 corrections (F1–F3): net +0** — helpers/guards/heuristics/
  functions/regex/keyword-tables/decision-owners/collections unchanged.
  Corrections reuse existing owners: row classification reads
  `active_revision.row_map` (durable state already present); the CAS
  `expected_rev` moves inside the existing `staged` entry, now keyed
  per importer tag (same field, per-attempt shape — fixes the
  shared-slot discard that destroyed the loser's pinned diff); the
  validator gains clauses inside the same membership check, not new
  guards.
- **rev7 corrections (A–B): net +0** — the lineage check reads
  `revisions[expected_rev].row_map` (the audit field already in the
  revision doc); the noop path and insert-only write are importer
  write-order logic, no new owner/collection/flag; `noop_reimport` is
  a log event on the existing `zaapi_kb_import_log`.
- **rev8 corrections (noop predicate): net +0** — `scope_fp` fills the
  `scope_fingerprint` slot the revision schema already declared; the
  predicate is read-comparison inside the importer's existing
  early-exit; `retry_converged` is a reason field on the existing
  `noop_reimport` log event; D1–D6 lock options already on the table —
  no new owner, collection, table, or flag.
- **rev9 corrections (scope owner + D2): net +0** — probe now calls the
  production `account_scope_fingerprint` directly (stronger evidence,
  not a mechanism); D2 locks `query_excerpts` = producer-stamped
  excerpt (the field already proposed; producers already hold the
  firing text — no new scanner/table).
- nothing added for cosmetic counts.
- nothing added for cosmetic counts.

### 9.4 Rollout — unchanged: schema v2 → canary `6acf5df0` → family
batches → probe-gated flip (separate approvals).

---

## 10. STOP GATE — remaining approvals

### 10.1 Decision table (rev8 — defaults locked w/ acceptance, not "รอเลือก")

| # | decision | locked default (safe, consistent w/ existing owners) | acceptance |
|---|---|---|---|
| D1 | non-productish needs | need kinds `{policy,troubleshoot}` admit scope-only resolve — no product ref required; record kinds `{policy,faq,note,troubleshooting}` mapped per §7.3; claim/order/human NOT Zaapi-served (other owners) | T45a–c: real `decide()` need → retrieval → bound evidence → `DomainResult(origin=zaapi)` → answer (never NeedTask) |
| D2 | `query_excerpts` producer | need **producer** stamps source-grounded excerpt = the normalized question text that fired it (policy/troubleshoot need producers — faq/note are record kinds); `capability_asks` stays product-only — no new regex/keyword tables | `decide("ร้านรับคืนสินค้าไหม")` → policy need with non-empty excerpt → semantic_query built; empty excerpt ⇒ honest `no_query` |
| D3 | conflict rendering | exclude + log (existing contract) — never merge or pick silently | conflicted record absent from evidence + `conflict` log row |
| D4a | status endpoint auth | env-configured bearer token on internal route + 2s timeout + fail-closed (not-ready ≠ broken data) | status green ⇔ `load_active_generation`+canary succeed; 401 w/o token |
| D6 | manual edits | legacy-KB only; Zaapi canonical pool is file-sourced — admin edits are reported as divergence, never merged | manual edit + re-upload: file rows win; divergence logged |

Remaining genuinely-preference questions for user: none blocking —
all five have evidence-consistent defaults; flip any before RED if
disagreed. (D5 resolved: hold-publish = provable-provenance rule.)

### 10.2 Three states are NOT equal (locked — rev8)

1. **import revision correct** — manifest points at a revision whose
   validator passes (membership + coverage + lineage)
2. **generation/artifacts built+validated** — embedding/generation
   derived from that revision load successfully
3. **runtime ready** — retrieval path actually serves Zaapi evidence

A published revision does NOT imply (2) or (3): import success must
never be reported as "Zaapi พร้อมใช้งาน". Readiness = the status
probe proving all three.

### Unproven `[ยังไม่พิสูจน์]`

- Per-source key declarations (ledger exists; human pick pending).
- `query_excerpts` excerpt quality + retrieval ranking on
  non-productish needs.
- Merged-cell/multi-header sheets (none seen; not exhaustive).
- Incremental vector reuse cost at ~8.6K digests.
- Real customer answers (T21) — no generation exists.
- **All /tmp probes = design simulation** — GREEN requires the real
  importer/schema/generation owners post-implementation.

---

## 11. Executable evidence appendix

**Production code (not sim):** finding A — `from_extraction` per
account → 2 recs/2 accounts, shared scope_fp+snapshot_id. finding D —
`doc(v1-fp)` vs `pointer(v2-fp)` equality mismatch → reuse rejected.

**`zaapi_census2.py`/`zaapi_keyledger.py`:** 66 column candidates /
52 assigned; 6 normalized-dup Products-Balance files; volatility
classes.

**`zaapi_diff_probe.py` `[sim]`:** T1 1-cell→changed=1 extract=1 ids
stable; insert/rename/+3/dup-STOP; assigned inherit-on-move.

**R1/R2 reproduction (ran):** prior fp ≠ new snapshot fp (keep-prior
unprovable → hold-publish); rev3 P4 accepted `rec:WRONG` → fixed chain.

**`zaapi_combined_probe_v5.py` `[sim]` — continuous, exit 0:**
Q1 baseline 2×2 1:N map · Q2 new-row fail → revision-bound
quarantine validates · Q3 changed-row fail → hold-publish, manifest
unmoved · Q4 rename-confirm + fail → hold, active key_map unchanged
(revision-embedded — no registry divergence) · Q5 retry → uid
persists · Q6 crash-after-stage → resume same uid · Q7 crash-precas
→ rerun converges · **Q8 true CAS race (rev6)** — B stages + pins
`expected_rev` to the shared base, stalls; A wins CAS; B resumes →
`cas_conflict`, pointer never rewound, active map == winner's, loser's
staged uids never active — surfaced + fixed the shared-staged-slot
discard flaw (another importer's file_fp mismatch wiped the pinned
diff) and removed the hand-rewound pointer + `or True` assertion ·
Q9 membership rejects wrong-id/ghost/foreign · **Q10 restart** →
edited EXISTING row fails → HOLD-PUBLISH (durable classification via
active_rev.row_map — was quarantined under rev5) · **Q11** ghost uid /
wrong fp / row_map∩quarantined / duplicate entry / empty reason /
dropped coverage → all rejected per-UID · **Q12** quarantined row
**Q12 (rev8)** same file + pending quarantine → retry runs → refail =
converged noop (uid stays); success → delivered same uid ·
**Q13 (rev7 A)** forged activation moving base-delivered uid to
quarantined → lineage reject; importer path still HOLDs ·
**Q14 (rev7 B)** clean same-file reimport → noop: doc byte-identical,
zero extractor calls, single publish event · **Q15** rev_id collision
→ reject + doc untouched; same id+payload → reuse + CAS move; precas
retry reuses doc (no overwrite) · **Q16 (rev8)** same file +account →
publish, only new account's records, existing byte-stable, 0 calls;
−account → only that membership dropped · **Q17** new file fp +
identical rows → new rev, uids+record_ids byte-identical.
**Q16b (rev9)** shop rename same id → publish via REAL owner
`account_scope_fingerprint` — renamed account re-minted, other
byte-stable, 0 calls.
Limitations `[sim]`: model_version/prompt_version/schema_revision not
modeled (T41 = prod-owner acceptance); cold-process extraction reuse
not modeled (uid_fp cache is per-process); `query_excerpts` producer
and the entire evidence→DomainResult answer chain are turn-side,
outside importer probe scope (T44/T45 = prod-owner acceptance — the
seven choke points at `retrieval_selection.py:218-225`,
`kb_zaapi.py:61-63`, `answer_context.py:650/:587/:1030-1035+2376`,
`app.py:760`, `app.py:2030-2152`
are verified `[โค้ด]` but their widening is unproven until
implementation).
(Probe bugs self-corrected during build: rename-confirm paren-trap,
rename-key re-mint clobber, stale-baseline compare, staged per-tag
keying, setdefault-vs-update on resume, deactivation-gate ordering,
stray module ref — kept honest.)
