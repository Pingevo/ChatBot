# Customer answer quality: scoped correction plan (2026-11-18)

## Authorization and scope

The user approved implementation after reviewing the read-only audit. Work on `fix/zaapi-answer-evidence`; preserve its existing replay diff. Change only the legacy `chat()` answer path and existing typed owners. Do not expand semantic keywords, phrases, or regex without separate direct approval. Product-to-product compatibility remains deferred: unknown must never become a positive claim.

## Baseline and root causes

1. **Spec/compare:** The model can see context cards and KB evidence while `guards._spec_fact_grounded` checks attached `resp.products`, typed measured facts, or unscoped grounding text. `spec_measured` is empty on many product turns. Multiple subject IDs deliberately fail closed because free-form model prose has no claim-to-product identity. This yields false-positive spec rewrites and sometimes removes the answer paragraph. Do not cure this by broadening unscoped guard authority.
2. **Claim follow-up:** `warranty_flow._handle_first_message_claim` and the legacy first-claim block return `CLAIM_STATUS_REPLY` on `already_handed`, before new symptom/attempt questions are considered. Some turns do reach supplemental tips, but equivalent claim-routed turns do not. Human ownership and no duplicate POST must remain.
3. **Troubleshooting fallback:** `warranty.malfunction_safe_check` uses charging advice for every malfunction, including watch controls. KB retrieval may fail when product identity is absent. Advice must be grounded to the product/symptom; without it, give neutral intake and handoff wording rather than irrelevant charging steps.
4. **Related routes:** Named-product compare may attach sibling models; physical-fit asks may be classified as device compatibility. Keep these in regression scope. Only change a typed owner when an executable failure proves its root cause.

## Implementation sequence

1. Create executable behavioral RED cases using existing offline fixtures: (a) correct spec from model-visible evidence survives guard only when identity matches, including multi-subject isolation; (b) post-handoff new symptom receives relevant supplemental answer without transition/POST, while status-only remains status; (c) watch control symptom never receives charger-specific fallback, while charger malfunction keeps its safe-check; (d) compat/compare, return/refund, frustration and transport truth controls continue to pass.
2. For each RED, trace the original data through the existing typed owner. Fix one cause at a time. Prefer changing `answer_context`/`_finalize_answer` for evidence identity, `warranty_flow` for claim turn ownership, and `warranty` only for generic safe-check scope. No new decision owner, helper, guard, regex, or keyword table without a separately justified contract and explicit approval where required.
3. Update SRS §6 for every changed core function, including calls/called-by and error/fallback. Run syntax, focused behavioral tests, then the offline suite. Compare fixed and negative controls on final answers. Use the 200-chat replay only once it reaches `done`; its 15-chat running snapshot is not a population score. Do not treat an LLM judge error as answer-quality evidence.
4. Verify handoff `assigned`/`queued`/`failed` states against the existing transport seam, and report actual downstream delivery as unverified unless observed. Do not send to customers or write Product DB.
5. Close the append-only log, index its exact new range in the ledger, advance the active integrity prefix after the final append, and report the net change of helpers, guards, regexes, keyword tables and decision owners. Request diff/test/file review before the first commit; no PR until the task is ready.

## Stop conditions

- A positive compatibility claim lacks a typed product-and-target verdict.
- A spec claim is accepted from another product's evidence.
- A new symptom triggers a duplicate handoff or a product-sales answer during an open claim.
- Refund or customer frustration is silently converted into a product/troubleshoot answer.
- A test cannot distinguish the proposed fix from a change that merely hides the failure.
