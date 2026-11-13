# Mobile Console UX Redesign — Implementation Plan

**Date:** 2026-11-11

**Spec:** `docs/superpowers/specs/2026-11-11-mobile-console-ux-design.md`
**Workspace:** existing root on `feature-set-branch-n-go`; no new branch/worktree.

## Goal and audit

Implement a phone-specific presentation for all 40 existing ChatAdminWeb routes and shared auth/loading/error states while retaining each route's existing state owner, API calls, permission checks, handlers, confirmation and save semantics, filters, pagination, and destinations. No chatbot or chatlogic source is in scope.

The root UX problem is inconsistent page presentation: some routes already branch to a mobile view, while others expose dense desktop tables, forms, and controls at phone widths. The app shell has visual viewport sizing and safe-area utilities, but keyboard visibility is not modeled for the bottom navigation, route screens use mixed `md`/`lg` conventions, and some long pages can overflow horizontally. The workflow editor's current interaction is centered on React Flow's canvas, which is not usable as the only phone editing surface. Dashboard charts also need a phone-readable summary/data equivalent.

## Invariants

- Preserve the current routes, data/API flow, permission gates, actions, field coverage, and save/delete/approve/confirmation behavior.
- Keep maroon and navy as palette anchors; redesign the phone type scale with Thai system-font fallbacks.
- Mobile layout, typography, background surfaces, and motion may be redesigned freely for symmetry and calmer scanning; maroon and navy remain the core color anchors.
- Establish readable hierarchy, stable spacing, and familiar interactions before adding decorative motion.
- Preserve the current presentation at widths of 768 CSS px and above. Activate phone presentation below 768px and for the spec's short-height coarse-pointer landscape case; do not alter ordinary tablet/desktop behavior.
- Use vertical scrolling only; do not create horizontally scrolling page surfaces, filters, tabs, data rows, or workflow controls.
- Keep workflow node IDs, edge IDs, source handles/branch IDs, cycles, and serialized graph semantics unchanged.
- Keep heavy visual assets optional and route-local. The static dashboard content/art must work without GSAP, Three.js, or WebGL.
- Keep detailed progress in the user-approved scratch log outside the repository; reconcile to the two canonical waythrough files only at task closeout. Preserve other task changes already present in the working tree.

## Implementation sequence

### 1. Confirm framework constraints and capture baseline

- Read the relevant Next.js 16 guides from `ChatAdminWeb/node_modules/next/dist/docs/` before editing application code.
- Recheck route inventory, package lock/dependency state, and current shell/layout breakpoints; preserve the unrelated dirty files and their contents.
- Treat current route-owned state and callbacks as the only business behavior owners; no API handler or `chatbot/shopeechat` change is planned.

### 2. Shared phone shell and UI primitives

- Extend `src/components/layout/AppShell.tsx`'s existing `visualViewport` handling to expose phone keyboard-open state; use it to keep focused content visible and suspend bottom navigation while the keyboard is open. Keep route and form state untouched.
- Adapt `src/components/layout/MobileNav.tsx` so every current console destination is discoverable through its searchable, permission-filtered groups, including all test-chat platforms and analytics subpages. Retain current primary items, profile shortcut, logout confirmation, and result feedback.
- Build a distinct phone render tree for route screens that need it. Do not treat the desktop page as the phone design and then compress its table, toolbar, tabs, or side-by-side panels; reuse only the route's existing data/state/actions. Keep the desktop render tree and normal 768px+ presentation intact.
- Keep a persistent search field only on long searchable lists; leave it in normal flow on forms, details, and short summaries. Keep a single profile destination while leaving user identity/logout visible.
- Center blocking alerts and confirmations; fit long edit forms into scrollable phone sheets, keep detail drawers full-screen, and place non-blocking toasts near the safe-area edge.
- Use a small `src/components/mobile/` presentation layer for phone-specific navigation, page header, list rows/cards, form groups, filter panel, empty state, and chat composer. Shared components receive route-owned values/callbacks; they do not own feature logic.
- Define a deliberate phone type scale and Thai-capable system font stack. Use semantic phone component classes instead of global selectors that resize all legacy text, buttons, switches, or form controls. Give each switch a 44px hit area while keeping its visible track at its intended 18–24px height.
- Put modal dialogs at a viewport-level host on phones, lock all background route scrollers while a modal is open, and let only the dialog content scroll. Use centered compact confirmations, bottom sheets for long forms, full-screen detail drawers, and safe-area toasts.
- Add only narrow safe-area/focus/keyboard rules needed in `src/app/globals.css` and `src/app/layout.tsx`. Ensure input text is at least 16px on phones, touch targets meet spec, focus remains visible, and safe-area/keyboard action bars remain reachable.
- Add phone-aware treatment for `/login`, root redirect, and the global loading/error/global-error/not-found states without changing auth or error recovery behavior.

### 3. Dashboard and analytics routes

- Adapt `src/app/(console)/dashboard/page.tsx` and the analytics routes (`/analytics`, `/analytics/live`, `/analytics/performance`, `/analytics/admin-activity`) to use stacked phone summaries/cards while retaining existing statistics and loading/empty/error states.
- Reuse `src/components/charts/StatsCharts.tsx` and existing Recharts data; ensure phone charts have legible labels and an accessible text/data equivalent, and platform/topic breakdowns never require horizontal scrolling.
- Add an original small pixel-art cat-girl asset for the dashboard and appropriate friendly empty/help moments. It stays out of active conversations, serious errors, destructive actions, and dense forms.
- Add GSAP and Three.js as dependencies because the user explicitly requested them. Dynamically load GSAP for subtle dashboard motion and Three.js only for an optional 2.5D stage using the original sprite as its character plane. Preserve the static image first and skip WebGL/motion for reduced motion, data-saver, unsupported WebGL, or low-capability devices.
- Keep the generated pixel-art character as the model; add depth with layered stage elements, gentle parallax, and a soft shadow. Do not replace the character with a geometric voxel model. Do not import a Sketchfab model unless its license and attribution terms have been checked and documented.

### 4. Conversation, assignment, and test-chat routes

- Adapt `/tickets`, `/botworker`, `/shadow-inbox`, `/chats`, `/live-assignment`, `/replay-compare`, `/test-assignment`, `/test-chat/shopee`, `/test-chat/tiktok`, `/test-chat/lazada`, `/test-chat-result`, and `/admin-chat-result` as list → detail/conversation phone flows where applicable.
- Adapt `/contacts` and `/backlog` as vertically stacked cards with existing row actions, bulk actions, sorting, filters, result counts, and pagination.
- Preserve message send/review/assignment/approval/image/copy/status behavior. Keep drafts, selected conversation, filters, and list scroll when opening/closing details or the keyboard. The composer stays above the keyboard; the mascot never overlaps live work.
- For phone inboxes, use a purpose-built list → conversation → info flow that keeps search/filter/status/actions discoverable without shrinking the desktop header. Keep customer avatars supportive (about 40px in the list, 36px in the conversation header, and 28px beside message groups); message content and customer identity remain the visual priority.
- Reuse existing partial mobile views where present and correct their responsive behavior instead of adding a second state owner.

### 5. Process, knowledge, shop, and administration routes

- Adapt `/triggers`, `/workflows`, `/quick-replies`, `/knowledge`, `/zaapi-kb-mapping`, `/generations`, `/persona`, `/shop-settings`, `/shops`, `/team`, `/users`, `/admin-config`, `/config`, `/llm`, `/roles`, `/logs`, `/settings`, and `/help` with stacked records, wrapped controls, labeled sheets, keyboard-safe actions, and visible validation.
- Preserve route-specific fields, filters, import/export, role gating, destructive confirmations, pagination, and save/retry behavior. Long identifiers wrap and expose the existing copy/detail behavior where available.
- Adapt `/test-results` and `/admin-review-kpi` with the same readable data-card/chart patterns without changing metric definitions or review actions.

### 6. Workflow phone editor

- Extend the existing owner in `src/components/workflow/WorkflowEditor.tsx` with a phone presentation: vertical node outline; inline per-node configuration; explicit source-node, output/branch, and target-node connection editor; readable edge list with add/remove actions.
- Reuse the existing node/edge arrays, callbacks, validation, import/binding panels, and save serialization. Do not introduce a parallel graph model or new workflow semantics. Canvas positions remain desktop layout data.
- Keep node palette, duplicate/delete, import preview, binding resolution, structural/capability validation, and workflow settings reachable in stacked sections/sheets.

### 7. Responsive and interaction pass

- Review all 40 route surfaces plus auth/root/loading/error states against the phone portrait widths 320/360/390/430px and coarse-pointer landscape dimensions 667×375 and 844×390.
- Review keyboard cases for chat, search, forms, date selection, and navigation; verify focus, safe areas, scroll restoration, orientation changes, reduced motion, and no horizontal page movement.
- Confirm ordinary 768px+ presentation remains unchanged. Keep any implementation-driven correction within the mobile presentation scope and preserve all non-UI working-tree changes.

## Main files in scope

- Shell and shared presentation: `ChatAdminWeb/src/app/globals.css`, `src/app/layout.tsx`, `src/components/layout/AppShell.tsx`, `src/components/layout/MobileNav.tsx`, `src/components/layout/Sidebar.tsx`, `src/components/ui/*`, and new `src/components/mobile/*` only where shared behavior is needed.
- Route pages: all 40 existing `src/app/(console)/**/page.tsx` files named in the design spec; login and shared app states under `src/app/`.
- Dashboard/charts: `src/components/charts/StatsCharts.tsx` plus a dashboard-only lazy visual module and original raster asset if needed.
- Workflow: `src/components/workflow/WorkflowEditor.tsx` and existing workflow presentation components.
- Documentation: this plan, the approved design spec, and the two canonical waythrough files at closeout only.

## Review risks and controls

- A shared primitive can accidentally hide fields or change form behavior. Each mobile view must render from the existing route state/callbacks, and all existing actions remain discoverable.
- A broad breakpoint change can alter tablet/desktop. Keep phone markup and styling explicitly scoped below the phone breakpoint and preserve non-phone classes and render paths.
- Keyboard resize differs by browser. Use the existing `visualViewport` hook and focused-element context; don't use orientation locking or broad gesture suppression.
- Workflow edges have branch-specific source handles. Map the phone connection choices directly to current `sourceHandle` values and keep existing save serialization/validation as the authority.
- GSAP/Three increase download weight. They must be dynamically imported by dashboard-only code, have failure/fallback paths, and not enter route bundles that do not use them.
- The existing branch has unrelated documentation changes. Do not reset, stage, or rewrite those files; no commit/push/PR is part of this plan.

## Correction round — 2026-11-11

The first implementation leaned too much on global phone CSS around existing desktop markup. Live phone review exposed stretched switch controls (the global 44px button minimum also changed the switch's visible height), inconsistent type scale, and dialogs that did not lock the nested route scroll surfaces. Correct this at shared presentation owners and route-level phone composition: independent phone view trees backed by the same route state/actions, 44px switch targets with a separate visual track, a measured Thai type scale, viewport-level modal hosting with background scroll lock, and intentional chat avatar sizes. This supersedes any earlier implication that global table/button overrides alone constitute a phone redesign.

## Acceptance evidence

- Every route in the spec has its required phone presentation and current action coverage.
- Phone portrait and specified short-landscape layouts have no horizontal overflow or hidden primary action.
- Keyboard open/close and orientation changes preserve route-owned input/selection/filter state.
- Workflow phone edits preserve serialized graph identifiers and semantics.
- Dashboard data remains understandable without animation/3D, including empty/loading/error/no-real-data states.
- Existing non-phone presentation and permission-filtered navigation remain intact.
- Motion/art failures, reduced motion, data-saver, or missing WebGL leave all operational content usable.

## Not in scope

- Any change to `chatbot/shopeechat/`, other chatbot logic, API business behavior, schemas, permissions, route inventory, or database.
- Branch creation, worktree creation, commit, push, pull request, deployment, or canonical log rewrite.
