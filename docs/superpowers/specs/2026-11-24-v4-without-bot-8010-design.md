# v4 without Python bot port 8010

## Status

Implementation is authorized by the user's request to carry out the six agreed work items. This design records the source contracts to preserve before implementation.

## Root cause

The global `chat_engine` already sends answer calls to ChatBlackshark when it is `v4`, but the admin UI still treats the Python Shopee service as a shared backend. Shop options, Test Chat session storage/logs, generation status, and file-backed Zaapi operations still use Python endpoints. Answer routing is spread across Test Chat, Assignment, Shadow Inbox, and the compatibility proxy; Workflow and BotWorker use `botCallService.callBot`. Replay Compare selects the global engine explicitly, but its Python script maintains its own transport implementation.

## Invariants

- Keep the existing `SystemConfig.chat_engine` selector and its meanings: `legacy`, `v2`, and `v3` call the configured Python service; `v4` calls ChatBlackshark.
- Preserve workflow/trigger precedence, answer prompts and policy, assignment and handoff outcomes, limits, history/media shape, replay metadata, and each caller's existing side effects.
- Keep the Test Chat collection, ObjectId string IDs, document field names, admin ownership/legacy visibility rules, script-test visibility, message ordering, title generation, close/reopen status, and best-effort action logging. Do not migrate or duplicate existing documents.
- Keep product catalog shop-name identity and casing from the read-only product DB. Do not substitute Admin Mongo transport IDs or Admin shop rows for catalog names.
- Keep admin Persona and Shop Settings records in Admin Mongo. Their current shop-option source is the product catalog, not the bot runtime.
- Generation build/publish/rollback and file-backed Zaapi import/export/bind remain Python-owned tools for Python engines. In v4, show them as unavailable and do not forward their requests to port 8010. Continue to expose shared Mongo-backed knowledge management.
- Do not read environment secret files or use live provider/customer traffic during verification.

## Design

### Shared data APIs

Add an authenticated Next.js catalog-shop endpoint backed by the existing read-only `productService`/dbWallet client. It returns the legacy `{ shops: string[] }` contract derived from distinct catalog `shopname` values. Persona, Shop Settings, and Test Chat consume that endpoint instead of the generic chatbot proxy. The selector keeps catalog names; no browser Mongo access is introduced.

### Test Chat persistence

Add authenticated Next.js APIs for session list/create/load/update/delete, message append, close/reopen, and action-log listing. They use the existing `COLLECTIONS.testChatSessions` and the existing `test_chat_logs` collection in Admin Mongo. Preserve the Python API's response shapes and data behavior while taking actor identity from the authenticated Next.js session. Move the client to these APIs; ratings, uploads, buffer, and dispatch remain on their existing Next.js APIs.

### Engine dispatch

Use `dispatchChatEngine` as the shared transport owner for all TypeScript answer calls. `botCallService.callBot` remains the higher-level owner used by Workflow/BotWorker and delegates transport to it; Test Chat, Test Assignment, Shadow Inbox, live-assignment simulation, and the compatibility chat proxy use the dispatcher directly where their payload and side-effect contracts differ. Retain caller-specific preparation and result mapping so trigger orchestration, simulation namespaces, limits, metadata, and handoff persistence do not drift. Replay Compare keeps one global selector in the Next route and calls the protected internal dispatcher bridge from its Python child; v4 calls ChatBlackshark and legacy/v2/v3 call the configured Python URL. Any transport change must preserve this replay/test isolation contract.

### Python-only admin tools

Route the global generation badge through an engine-aware Next endpoint: it returns no pending work for v4 and reads Python generation state only for legacy/v2/v3. The Generations page must not load or mutate Python generations in v4 and should explain the supported engine requirement. Gate file-backed Zaapi list/toggle/import/export/rollback/bind and import-log calls in the server routes when v4 is active; the UI should avoid issuing those calls and explain that they require a Python engine. Keep Admin Mongo-backed Zaapi KB content and mappings available.

### Test Chat feedback

Feedback currently only logs to the Python process and is non-persistent. Move the best-effort feedback sink to a small authenticated Next.js endpoint using server logging, keeping the current accepted ratings (`up`, `down`, `clear`) and response contract without adding a database collection.

## Acceptance evidence

- With the answer engine set to v4 and an outbound-fetch spy that fails on any configured Python bot URL, shared shop options, Test Chat session operations/logs/feedback, answer dispatch, generation badge/page, and file-backed Zaapi UI/routes must complete or show the documented unavailable state without contacting Python.
- With legacy, v2, and v3 selected, answer calls must use the configured platform Python URL and send explicit selector flags. Existing Workflow/BotWorker behavior remains on `callBot`.
- Verify exact persistence and API behavior using isolated Mongo/fetch doubles; run relevant existing Test Chat, engine, workflow, and type-check scripts. No real database writes or provider calls.

## Scope limits

This work does not move Python generation/Zaapi processing to a new service, change chatbot answer logic, alter production conversation data, or claim full historical waythrough coverage. The manual integration-health action remains an explicit infrastructure probe.
