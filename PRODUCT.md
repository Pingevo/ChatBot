# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

- **Chatbot engine:** Python FastAPI (`chatbot/shopeechat/`) — LLM-powered, MongoDB-backed, deployed via Docker
- **Admin console:** Next.js 16 + React 19 + Tailwind CSS 4 (`ChatAdminWeb/`) — App Router, zustand state, SSO auth
- **Flow builder:** @xyflow/react (React Flow) for visual workflow editor
- **Charts:** Recharts for analytics
- **Database:** MongoDB (product DB read-only, admin DB read-write)
- **Deploy:** Docker Compose (Caddy reverse proxy + auto SSL), MongoDB on host
- **SSO:** Organization SSO (IT Showroom / ITSR) — no local signup

## Users

- **Primary: Internal ops team at IT Showroom** — manages chatbots across multiple shops spanning Shopee, TikTok, and Lazada. Admins handle live chat tickets, superadmins manage config/team/users, devs test and debug bot behavior. The team monitors bot quality, steps in when conversations need human handling, and iterates on bot logic through workflows, triggers, knowledge base, and persona settings.
- **Roles:** superadmin (full access), admin (tickets + read on most), dev (everything). Permission model is page-based per role.

## Product Purpose

ChatBotProductMS is the organization's unified chat operations platform — like Zaapi but built in-house for IT Showroom. It aggregates customer chats from all e-commerce platforms (Shopee, TikTok, Lazada) into one console. An AI chatbot handles routine questions automatically (product specs, warranty, shipping). When a conversation meets certain conditions — customer wants to buy, complex issue, escalation — a human admin takes over. The platform exists to let a small ops team manage high-volume customer chat across many shops and platforms with bot-first, human-when-needed efficiency.

## Positioning

A neighboring product like Zaapi could not truthfully claim: seamless human+bot collaboration on a per-conversation basis with a full testing/QA pipeline (shadow inbox, replay compare, test assignment, KPI review) — measuring and improving bot answer quality before and after going live, all within one console tied to the organization's SSO and multi-platform shop infrastructure.

## Operating Context

- **Multi-platform:** Shopee (live), TikTok + Lazada (placeholder — not yet implemented in chatbot engine)
- **Multi-shop:** One organization runs chatbots for many shops; flows/personas are per-shop or shared
- **Bot-first workflow:** Bot answers first via LLM + knowledge base + product store; humans intervene via triggers/workflows/assignment
- **Testing pipeline:** Shadow mode (bot generates replies alongside live), replay compare (bot vs Zaapi), test assignment, KPI review — all for measuring bot quality
- **Workflow builder:** Visual flow editor (trigger → condition → action → wait) with multi-branch conditions, variable interpolation, and retry/timeout logic
- **Knowledge base:** RAG-based product knowledge from MongoDB + web search fallback
- **SSO:** Organization login via IT Showroom SSO — no local accounts
- **Docker deploy:** `docker compose up -d --build` — Caddy handles SSL, MongoDB runs on host

## Capabilities and Constraints

- **Live chat:** Ticket inbox with assignment, labels, notes, close history
- **Bot testing:** Shadow inbox, replay compare, test chat (per-platform), test assignment, test results, admin review KPI, admin/test chat results
- **Process automation:** Triggers (keyword-based), workflows (visual flow builder), quick replies, knowledge base (RAG), persona (per-shop bot name), shop settings
- **Analytics:** Live stats, admin activity, performance dashboards
- **Management:** Shops, contacts/customers, team & assignment, users (role management)
- **Config:** Admin config, system config, logs
- **Constraints:**
  - Product DB (`dbWallet`) is read-only — never write
  - `.env` files are secrets — never read or commit
  - `lazadachat/` and `tiktokchat/` are placeholders — no real implementation yet
  - `app.py` is ~4,300 lines — nested functions in `chat()` are scope-limited
  - MongoDB admin DB uses `ADMIN_MONGO_*` env, product DB uses `MONGO_*` env

## Brand Commitments

- **Company name:** IT Showroom
- **Current palette (not binding):** Maroon `#8b1e28`, navy `#0b2340`, grey-blue `#bfd7ea`, coral `#ff5a5f` — present in code but explicitly not fixed; can evolve
- **Logo:** To be generated for "IT Showroom"
- **Voice:** Thai-language interface (admin console UI is in Thai); bot persona uses ค่ะ/นะคะ (female, polite)

## Evidence on Hand

- `docs/SRS_SSD.md` — primary system reference (must update when functions change)
- `docs/schema.md` — DB schema
- `docs/function and process.md` — function/process documentation
- `docs/DEPLOY.md` — Docker + Caddy deploy guide
- `ChatAdminWeb/docs/DATA_SCHEMA.md` — chat data schema from sellcenter
- `getoutofmywaybotkaikrook.md` — waythrough log history (read-only, frozen) — `getoutofmywaybotkaikrook2.md` — active waythrough log (mandatory reading before any work; write here)
- `exports/product_embeddings.npz` — product embeddings for RAG
- No customer testimonials, case studies, or press — do not fabricate

## Product Principles

1. **Bot-first, human-when-needed** — the bot handles routine; humans step in only when conditions demand it. Design for the handoff, not just either side.
2. **Quality is measurable** — every bot answer can be tested, compared, replayed, and scored. The testing pipeline is a first-class feature, not an afterthought.
3. **One console, all platforms** — ops team should never context-switch between Shopee/TikTok/Lazada tools. Unified inbox, unified config, unified analytics.
4. **Per-shop flexibility, shared infrastructure** — persona, knowledge, and workflows can be per-shop or shared. The system scales by reuse, not by duplication.
5. **Thai-first, production-grade** — the interface is in Thai for a Thai ops team. Internationalization is not a priority; clarity and speed in Thai is.

## Accessibility & Inclusion

- Thai-language UI — text must remain readable at Thai font sizes (typically larger than English equivalents)
- Icon-only buttons require `aria-label` (ongoing audit — ~60+ fixed, some may remain)
- Role-based access ensures admins only see what they can act on
