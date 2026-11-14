# Full-Device Console UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Track each task with `- [ ]` and verify its deliverable before continuing.

**Goal:** Redesign all 40 ChatAdminWeb routes for phone, tablet, and laptop/desktop with full-viewport frames, clear hierarchy, and selective 2.5D motivation while preserving every existing feature and flow.

**Architecture:** Keep `AppShell` responsible for the full viewport and device navigation; let `PageShell` and route-specific workspace owners set one inner content gutter; let route components retain their existing data, permissions, and actions. Build a shared responsive typography/surface contract, then apply it to page families and the high-risk chat, analytics, workflow, and generation workspaces.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS 4, existing global CSS, Recharts, existing GSAP/Three dependencies only where already used. No new dependency or external font fetch is planned.

**Spec:** `docs/superpowers/specs/2026-11-13-laptop-tablet-console-ux-design.md`

## Global Constraints

- Cover all 40 authenticated routes plus shared login, SSO, loading, empty, error, confirmation, and not-found states.
- Preserve every route, permission gate, field, data source, API request, action, callback, confirmation, save behavior, navigation destination, and route-owned state.
- Do not edit `chatbot/`, ChatLogic behavior, database schemas, permission rules, route contracts, or API business logic.
- Redesign phone, tablet, and laptop/desktop presentations; phone is not frozen to the existing composition.
- Keep navy and maroon as core brand anchors; preserve each administrator's light/dark preference and semantic status colors.
- Keep the background canvas full viewport; align hero and card-group edges to one page column and use a consistent local inset inside cards. Use 16px phone, 20–24px tablet, and 24–32px laptop as starting page gutters.
- Use role-based type sizes: metadata 11–12px, supporting 12–13px, body 14–16px, section 16–19px, title 20–28px, key metric 28–44px when it is the page focus.
- Support touch, mouse, trackpad, keyboard, portrait, landscape, safe areas, and on-screen keyboard. No action may rely on hover alone.
- Use 2.5D pixel-art selectively; do not turn each route into a decorative card or make motion compete with operational data.
- Keep active generation mascot motion aligned to progress and the established 30 fps target; respect reduced motion and keep static fallback content usable.
- Inspect and adapt the current uncommitted UX changes; do not discard them or edit `chatbot/`.
- Do not add or run tests unless the user asks. Use type-check, diff validation, and visual/interaction review as implementation evidence.

## Review Focus

1. **Phone keyboard open with a chat composer or focused form:** the navigation may yield space, but the current draft, active field, send/save action, and page scroll must remain usable. Visual-check in the ticket/chat task at 390×844 with the keyboard state active.
2. **Coarse-touch tablet landscape versus fine-pointer laptop at similar widths:** the tablet must keep its distinct layout and never clip the floating dock, back action, or primary workspace. Check both input modes at 1024×768.
3. **Long Thai titles, account names, IDs, errors, and dense table columns:** labels should wrap or truncate within their own control without shifting siblings or causing page-level horizontal scrolling. Check in route-family review and representative LLM/API Keys and management tables.
4. **Per-admin dark mode and reduced-motion preference:** surfaces, chart labels, focus states, and pixel art must retain contrast; disabled motion must not hide state or break progress. Check settings, dashboard, and generations.
5. **Ticket info open/close, workflow unsaved Back, and generation empty/build/complete states:** the current selection/draft, unsaved confirmation, progress and actions must remain bound to their existing state owners. Check the owning route task before visual sign-off.

---

## File and Responsibility Map

- `ChatAdminWeb/src/app/layout.tsx` — root font variables and viewport metadata; adjust only if required for one Thai-capable font stack or safe-area behavior.
- `ChatAdminWeb/src/app/globals.css` — existing theme tokens, responsive type roles, full-frame rules, scoped route/workspace surfaces, and motion/reduced-motion styling. Avoid widening existing broad selectors.
- `ChatAdminWeb/src/components/layout/AppShell.tsx` — full-height frame and navigation/content slots.
- `ChatAdminWeb/src/components/ui/PageShell.tsx` — one route heading and one inner content gutter for standard pages.
- `ChatAdminWeb/src/components/layout/Sidebar.tsx`, `MobileNav.tsx`, `MobilePageNavigation.tsx`, `ChatAdminWeb/src/components/mobile/MobilePresentation.tsx` — permission-filtered navigation, profile entry, back behavior, and device presentation.
- Dashboard/analytics: `ChatAdminWeb/src/app/(console)/dashboard/page.tsx`, the four `/analytics` page owners, `ChatAdminWeb/src/components/charts/StatsCharts.tsx`, `ChatAdminWeb/src/components/dashboard/DashboardCompanion.tsx`.
- Inbox: `ChatAdminWeb/src/app/(console)/tickets/page.tsx`, `ChatAdminWeb/src/components/chat/TicketChatPanel.tsx`, `ChatAdminWeb/src/components/chat/ChatWindow.tsx`, `ChatAdminWeb/src/app/(console)/shadow-inbox/page.tsx`.
- Generation: `ChatAdminWeb/src/app/(console)/generations/page.tsx`, `ChatAdminWeb/src/components/generations/BuildProgressCat.tsx`, `ChatAdminWeb/src/components/generations/GenTracks.tsx`, existing mascot sprites under `ChatAdminWeb/public/mascot/`.
- Workflow: `ChatAdminWeb/src/components/workflow/WorkflowEditor.tsx`, `ChatAdminWeb/src/app/(console)/workflows/page.tsx`, `ChatAdminWeb/src/app/(console)/workflows/[workflowId]/page.tsx`.
- Other route page owners are changed only where inventory/visual review shows they bypass the shared frame or a reusable family still violates the spec. Route inventory is the 40-path list in the spec, Section 8.
- Task notes: append only to `getoutofmywaybotkaikrook2.md`; summarize the exact task range and update `docs/waythrough-ledger.md` at closeout. Keep the frozen log read-only. Do not change integrity metadata until the closeout entry is indexed and prefix hash is recomputed.

## Task 1: Inventory all route shells and current branch changes

**Files:**
- Read all 40 route page files under `ChatAdminWeb/src/app/(console)/` listed in the spec.
- Read and preserve the current uncommitted UI diff in the files named in the map above.
- Update this plan or the spec only if the route inventory reveals a route missing from the 40-path list.

- [x] **Step 1: Classify each route by owner and page family.** Record whether it uses `PageShell`, a full-screen workspace, a custom editor, a table/list, or authentication/error presentation. Record its existing top-level actions and secondary-detail path without changing handlers.
- [x] **Step 2: Map high-risk controls to current owners.** For tickets, shadow inbox, workflow and generations, list the state variables/callbacks that own back, selection, draft, info pane, save/unsaved confirmation, build mode, and progress.
- [x] **Step 3: Compare the dirty worktree with the approved scope.** Preserve valid tablet composition, menu routing, container sizing, pixel sprites, and reduced-motion behavior; mark the places that must change to satisfy full-viewport frames and all-device redesign.
- [x] **Step 4: Record the route-family matrix in the task notes.** Keep all 40 paths and representative interaction paths identifiable through implementation and review.

**Deliverable:** A route-to-owner matrix and a file-level change list. No UI source change in this task.

## Task 2: Establish the full-frame and typography system

**Files:**
- Modify `ChatAdminWeb/src/components/layout/AppShell.tsx`.
- Modify `ChatAdminWeb/src/components/ui/PageShell.tsx`.
- Modify `ChatAdminWeb/src/app/globals.css`.
- Modify `ChatAdminWeb/src/app/layout.tsx` only if needed to unify the local/system Thai font stack or viewport handling.

- [ ] **Step 1: Make the shell own the viewport edge.** Remove compounded outer padding, border, and corner radius from `main[data-app-content]`; retain full-height overflow containment and keyboard/safe-area behavior.
- [ ] **Step 2: Make PageShell own the standard content inset.** Keep its header aligned to the route frame; put one responsive gutter around content objects; retain sticky search/filter and add-action positions without duplicating the header.
- [ ] **Step 3: Add shared role tokens.** Define metadata, supporting, body, section, title, and metric sizes/line-heights at the root and adapt them with `clamp()` or a small set of breakpoints. Use a consistent Thai-capable local/system stack across all sizes; do not import another remote font.
- [ ] **Step 4: Apply shared theme surfaces.** Give light mode a quiet tinted background and navy/maroon focal contrast; preserve dark theme and semantic status variables. Keep route workspaces full-bleed and avoid nested card borders.
- [ ] **Step 5: Visually inspect the standard frame.** Check `/dashboard`, `/settings`, and one dense config page at 390×844, 768×1024, 1024×768, and 1366×768 in light and dark modes. Confirm one page title, one content inset, legible Thai text, no page overflow, and no shifted keyboard layout.

**Deliverable:** Every standard route can share a consistent frame, type hierarchy, and one-gutter rule without changing data/action owners.

## Task 3: Rebuild navigation and persistent profile access

**Files:**
- Modify `ChatAdminWeb/src/components/layout/Sidebar.tsx`.
- Modify `ChatAdminWeb/src/components/layout/MobileNav.tsx`.
- Modify `ChatAdminWeb/src/components/layout/MobilePageNavigation.tsx` only if required to preserve the established history/back fallback.
- Modify `ChatAdminWeb/src/components/layout/AppShell.tsx` and `globals.css` for navigation/frame coordination.

- [ ] **Step 1: Keep device presentations distinct.** Use input capability and available width for phone bottom navigation, coarse-touch tablet dock, compact laptop rail, and wide laptop sidebar; avoid overlapping `md`/`lg` visibility rules.
- [ ] **Step 2: Move profile/settings access outside More.** Put the current signed-in user's profile/settings action in a persistent navigation location at phone/tablet and in the existing sidebar identity area at laptop widths. Preserve the individual route and current auth data.
- [ ] **Step 3: Preserve the full searchable menu.** Keep the floating rounded dock order หน้าแรก → แชท → เมนู → สถิติ → โปรไฟล์. Show More as a centered floating dialog with a dimmed backdrop; move logout under “ทั่วไป” and retain its confirmation. Use one circular X close control. Match the supplied iPad proportions with a fixed header/footer and a flexing body region whose scale does not collapse when the menu has few items.
- [ ] **Step 4: Preserve navigation and keyboard interactions.** Exercise direct links, current-route state, browser back, PageShell back, Escape for overlays, and phone keyboard hiding the bottom nav without hiding composer actions.
- [ ] **Step 5: Check screen/input modes.** Review 320×568 and 390×844 phone portrait; 768×1024 tablet portrait and 1024×768 touch landscape; 1280×800 fine-pointer laptop. Confirm profile is visible and the menu remains reachable and scrollable.

**Deliverable:** One coherent, permission-safe route system with profile access outside More and an obvious back path on deep pages.

## Task 4: Apply the shared frame to all page families

**Files:**
- Audit and update standard route owners as needed under `ChatAdminWeb/src/app/(console)/`: `admin-chat-result`, `admin-config`, `admin-review-kpi`, all four `analytics` routes, `backlog`, `botworker`, `chats`, `config`, `contacts`, `help`, `knowledge`, `live-assignment`, `llm`, `logs`, `persona`, `quick-replies`, `replay-compare`, `roles`, `settings`, `shop-settings`, `shops`, `team`, `test-assignment`, all three `test-chat` routes, `test-chat-result`, `test-results`, `triggers`, and `users`.
- Reuse `PageShell` and current table/form components; modify `globals.css` only through explicit page-family classes.

- [ ] **Step 1: Normalize each route header.** Keep one route title, contextual back action where appropriate, one primary action, and a clear hierarchy for supporting text. Do not add a global duplicate header.
- [ ] **Step 2: Normalize list/table density.** Keep only scan-critical information visible by default where disclosure already exists; retain full record details, filters, sorting, selection, pagination, bulk actions, and row actions.
- [ ] **Step 3: Normalize forms and settings.** Use a single column until the content container is wide enough; keep labels/validation aligned and save/apply reachable. Preserve every field and handler.
- [ ] **Step 4: Make touch filter/sort controls usable.** Audit every route family for phone/tablet dropdown rows; use viewport-contained touch sheets with generous option targets for shared filters, and collapse crowded filter groups into reachable controls while preserving each route's current values and handlers.
- [ ] **Step 5: Inspect all 40 routes at the route-frame level.** Use the route matrix to visit every page at a phone, tablet, and laptop representative width; confirm frame/header/gutter and no horizontal overflow. Exercise detailed interactions on representative list, filter, form, config, analytics, and editor pages.
- [ ] **Step 6: Keep one-off layout exceptions scoped.** If a route is a full-screen workspace or canvas, document why it does not use the standard content gutter and keep its own object inset consistent with the frame contract.

**Deliverable:** All 40 route shells share the same spatial and typographic language while preserving page-specific controls.

## Task 5: Repair ticket, chat, and shadow-inbox workspaces

**Files:**
- Modify `ChatAdminWeb/src/app/(console)/tickets/page.tsx`.
- Modify `ChatAdminWeb/src/components/chat/TicketChatPanel.tsx` and `ChatAdminWeb/src/components/chat/ChatWindow.tsx` only for presentation/control placement.
- Modify `ChatAdminWeb/src/app/(console)/shadow-inbox/page.tsx`.
- Modify scoped workspace rules in `ChatAdminWeb/src/app/globals.css`.

- [ ] **Step 1: Make the workspace fill its frame.** Align list/chat/detail panels to the page bounds; add controlled inner spacing around message bubbles, customer objects, and tools.
- [ ] **Step 2: Show one info-pane exit control for each mode.** Resolve the md–lg state where both Back-to-chat and Collapse-panel are visible. Use a single context-sensitive action in overlay/narrow-pane mode and the appropriate persistent collapse affordance only when a side pane is truly persistent.
- [ ] **Step 3: Keep task actions grouped and reachable.** Present claim, close/reopen, assignment, and responder status in a compact unified status/action region without hiding any permission-gated action.
- [ ] **Step 4: Preserve route-owned state.** Open/close info and change list/detail presentation while preserving selected conversation, draft, filter, message scroll, and existing API/action callbacks.
- [ ] **Step 5: Review interactions.** Check phone keyboard open, tablet portrait/landscape, and laptop widths. Verify no double header, no hidden composer, one info close/back control, and no page-level horizontal scroll.

**Deliverable:** A full-width, readable conversation workspace with the same ticket/chat behavior and a single predictable detail-pane exit.

## Task 6: Make dashboard and analytics charts the visual focus

**Files:**
- Modify `ChatAdminWeb/src/components/charts/StatsCharts.tsx`.
- Modify `ChatAdminWeb/src/app/(console)/dashboard/page.tsx` and the four analytics route owners only for chart presentation/layout.
- Modify `ChatAdminWeb/src/components/dashboard/DashboardCompanion.tsx` only to place the existing pixel-art object as a restrained 2.5D focus element.
- Modify scoped chart/hero styling in `ChatAdminWeb/src/app/globals.css`.

- [ ] **Step 1: Render readable daily bars at every data length.** Keep the current data, date range, tooltip formatter, and API call; make multi-point daily trend a bar chart as requested.
- [ ] **Step 2: Balance metric and chart hierarchy.** Keep the graph visible, legible, and correctly sized in tablet portrait/landscape and laptop containers; preserve labels, legend, tooltips, breakdowns, and text equivalents.
- [ ] **Step 3: Add restrained 2.5D pixel-art depth to the dashboard focal area.** Reuse existing companion/art assets; use layered light/shadow and a small depth treatment, with no decoration in front of chart data or controls.
- [ ] **Step 4: Check light/dark and low-motion states.** Confirm contrast for axes/tooltips/status, static fallback visibility, and that reduced motion leaves all data/action paths intact.

**Deliverable:** Dashboard and all analytics pages show their data hierarchy and trend graph consistently; the mascot supports rather than competes with the task.

**Added from screenshot review:** Dashboard date-range calendar is clipped by the hero section on tablet. Fix the picker’s positioning/containing block and verify every preset and custom-date selection at phone, tablet portrait/landscape, and laptop widths.

**Added user's dashboard design:** Group inbound messages, replies, and platform counts together. Keep the combined `received + replied` total, but show the reply ratio as `replied / received` (not a share of the combined total); label 100% as equal replies and received messages. Show Shopee/TikTok as horizontal bars scaled against the largest platform count, keeping the existing API values. The latest correction supersedes the earlier ratio wording.

## Task 7: Make workflow actions and generation progress fit every device

**Files:**
- Modify `ChatAdminWeb/src/components/workflow/WorkflowEditor.tsx` and scoped workflow CSS.
- Modify `ChatAdminWeb/src/app/(console)/generations/page.tsx`, `ChatAdminWeb/src/components/generations/BuildProgressCat.tsx`, `ChatAdminWeb/src/components/generations/GenTracks.tsx`, and scoped generation CSS.
- Reuse existing `ChatAdminWeb/public/mascot/` assets and installed GSAP/Three code only where already loaded on the relevant route.

- [ ] **Step 1: Make the compact workflow view show the actual graph path.** Reuse ReactFlow nodes and edges (or an edge-accurate path preview); do not present nodes as a disconnected long list. Keep node selection/config reachable. Workflow list cards should show a short path derived from real edges and move secondary metadata out of the initial scan.
- [ ] **Step 2: Simplify the compact editor toolbar.** Keep Back and Save easy to reach; group validation, settings, import/export, delete, and publish actions under a compact tools control while retaining every action and unsaved-change confirmation.
- [ ] **Step 3: Unify generation cat rendering.** Use the same pixel-art sprite/action implementation at phone, tablet, and laptop widths; remove the current sprite-versus-SVG visual split without changing pipeline state ownership.
- [ ] **Step 4: Use one progress position calculation.** Bind cat location to the current step/percent from the same input used by the progress track. Keep track status/lanes tied to backend data and existing daily/weekly behavior.
- [ ] **Step 5: Add depth without losing readability.** Use a compact night-road progress surface, layered lamp lighting, contact shadow and selective 2.5D sprite treatment; retain labels and build controls. Keep movement aligned and use the established 30 fps target during active motion; completed/idle behavior stays still unless its existing selected action requires motion.
- [ ] **Step 6: Check all states and reduced motion.** Review empty, pending, building, success, failed, and expanded-detail states in both themes. Confirm no clipping, no invented lane, and that GSAP/Three remains optional and off unrelated routes.

**Added from iPad screenshot review:** Shared atlas clipping, night-road lane, progress lights, and lamp beams must render beyond phone breakpoints. Current source scopes these decorations to max-width 767px, leaving tablet with the entire sprite sheet and no road/lamps.

**Deliverable:** Workflow back/save controls remain visible; generation progress and pixel-art motion look consistent and stay attached to real build progress.

## Task 8: Cross-route visual and interaction review

**Files:**
- Review all changed `ChatAdminWeb/` files and all 40 authenticated routes from the spec.
- Append outcome to `getoutofmywaybotkaikrook2.md` only after visual/type verification.
- Update `docs/waythrough-ledger.md` with exact active-log line ranges and verified evidence; keep semantic coverage `partial`.

- [ ] **Step 1: Review target matrix.** Cover 320×568, 390×844, 768×1024, 820×1180, 1024×768, 1280×800, 1366×768, and 1440×900; include phone/tablet portrait and landscape, coarse/fine pointer, light/dark, and reduced-motion behavior.
- [ ] **Step 2: Walk all 40 route entries.** Record each route as visually reviewed or blocked by authentication/data. For each, inspect page frame, route title, primary action, inner gutter, overflow, and navigation/back affordance.
- [ ] **Step 3: Exercise representative interactions.** Check permission-filtered menu and profile, ticket selection/info/draft, chart tooltips/date selection, form validation/save, workflow unsaved back and toolbar actions, and generation controls/progress.
- [ ] **Step 4: Run implementation checks.** Run `npx tsc --noEmit --pretty false` from `ChatAdminWeb/` and `git diff --check` from the repo root. Do not add or run a test suite unless the user asks.
- [ ] **Step 5: Inspect changed files and scope.** Confirm no `chatbot/`, ChatLogic, API contract, permission, or unrelated data-flow change; identify any viewport/state that could not be exercised honestly.
- [ ] **Step 6: Close the append-only work log.** Append a concise verified/remaining-work record, index the exact new tail in the ledger, then advance active integrity prefix to EOF and compute the new prefix SHA. Do not update the prefix before the task's last log append is indexed.
- [ ] **Step 7: Present the source diff, route/viewport evidence, checks, and touched files for user review before the first commit.** Do not stage/commit/push/open a PR before that review.

**Deliverable:** Reviewable evidence of all 40 route shells, representative feature flows, responsive states, and exact UI-only change scope.

## User steering — laptop and PC visual simplification (2026-11-14)

The user asked for the laptop and PC presentation to be redesigned across the console because it still feels cluttered, while preserving every original capability. This stays within the already-approved full-device redesign scope.

The user clarified that UX quality takes priority over visual simplification. Each screen must make the primary task, next action, and important state easy to find; visual restraint is a means to reduce cognitive load, not a reason to bury controls or information. Motion and polish must reinforce feedback and orientation.

**Root cause from the live 1280×720 review:** shared `Card` styling gives almost every panel the same border, radius, and shadow, while several page families put many similar panels and metadata blocks in the first viewport. This flattens hierarchy and makes the layout feel like repeated boxes. Some workspace panel visibility also mixes viewport `lg:` rules with container-query sizing, so laptop width plus the sidebar can force panes into a too-narrow content area.

**Implementation direction:** retain the current route/data/action owners; simplify laptop/PC using a consistent page column and typography roles, reduce repeated card chrome, place one primary task/metric first, keep secondary metadata and advanced actions reachable through existing disclosure/menus, and make workspace pane transitions depend on available content width. Keep the compact laptop navigation rail; keep tablet and phone presentations separate. Do not hide or delete fields, filters, charts, actions, or permission gates. Do not edit `chatbot/` or ChatLogic.

**Review scope:** use live laptop/PC captures at the available 1280×720 viewport for standard pages and representative workflows; verify tablet/coarse-pointer separately where the emulator can represent it, and report unsupported physical-device states honestly. Existing phone/tablet work remains in scope and must not regress.

**Workflow editor refinement:** the desktop toolbar showed Back, Node, Settings, Validate, Import, Export, Publish-disabled, Save, Delete, state badges and a permanent usage hint at once; the always-open node palette also reduced canvas space. Keep Back, Add Node, Save and current save state visible. Group the remaining tools under one clearly labeled menu at every screen size and open the node palette only when requested, preserving all existing handlers, disabled reasons, and unsaved-change safeguards.

**Ticket workspace follow-up audit:** the three-pane shell mixes viewport `lg:flex` visibility with container-query breakpoints. At desktop viewport widths, a workspace container below 900px can still force all panes into a narrow row; on containers above 1160px, the details button is hidden even after the right pane is collapsed, leaving no way to reopen it. Fix pane visibility from the ticket container width and existing `mobileView`/`rightCollapsed` state: a single-pane back flow below 900px, the existing overlay from 900–1159px, and a persistent details pane above 1160px with a reopen button only when collapsed. Preserve all callbacks and data flow; CSS presentation only.

**Generation desktop audit:** desktop showed three equal bordered summary cards, and its Build control had no visible text. Group active generation, next build and its existing mode/action, and last build into one clearly ordered summary surface with a named Build action. Keep the same values, permission condition, mode state, confirmation, and API callback.

**Desktop navigation audit — 2026-11-14:** the live PC view keeps a 256px sidebar with every route visible, and the collapsed state still reserves a 60px rail. This permanently consumes content width and puts all destinations in the user's peripheral view. Replace only the fine-pointer desktop/laptop sidebar with a compact draggable round launcher. Clicking it opens a viewport-clamped floating menu; users choose a category, then a route, and the existing route link performs navigation. Reuse the existing permission-filtered nav groups and preserve menu search, profile, help, and confirmed logout. Keep tablet rail and phone floating bottom navigation unchanged. The content frame should reclaim the full viewport at desktop sizes. Dragging must be pointer- and keyboard-accessible, clamp to viewport after resize, and persist only the launcher position; Escape, outside click, and route change close the menu. Check that launcher/menu avoid primary controls and never cover workflow canvas actions, add docks, or chat composer.

**Desktop dark-mode visual audit — 2026-11-14:** once the user's dark theme was active in the live browser, the inbound count and category icons used the fixed light-theme navy token (#0b2340) on dark surfaces and lost contrast. Replace those two component-level foregrounds with theme-aware text tokens; retain maroon/semantic colors. Increase the launcher default bottom inset so it does not overlap the Next.js development affordance in local review.

**Cross-route theme audit — 2026-11-14:** user reports intermittent text/icon colors disappearing after switching light/dark across all screen sizes. Inventory all changed route/page-family styles for fixed light-theme foregrounds and theme-dependent icons, correct shared foreground tokens at their owning components, then inspect all 40 authenticated routes in light and dark mode at representative phone/tablet/laptop/PC widths. Keep semantic status/platform colors distinct and verify primary text, iconography, focus, chart axes, selected/disabled states, and empty/error states. Do not claim full coverage for any route/device/theme combination not actually reviewed.

**Per-page visual identity audit — 2026-11-14:** user requested a generated, small 2.5D image mark in each page header that reflects the page's purpose. Keep the existing UX hierarchy and compact header dimensions; do not add a hero card or large illustration. Use a small, coherent set of transparent local art by semantic page family, with the existing route-specific Lucide mark retained as the precise semantic foreground where useful. Apply through the shared `PageShell` plus custom workspace headings so all routes are covered; lazy-load static assets and preserve text/title accessibility. Keep each page's meaning explicit through its route icon/title rather than repeating a generic decorative mascot.

**Cross-route light/dark source audit — 2026-11-14:** independent read-only reviews found a shared token pairing defect: dark mode changes semantic `*-soft` backgrounds but leaves `*-dark` text colors in their light-theme shades. This affects status labels/icons across help, workflow validation, tests, admin review, and toast/badge components. Additional cases: several `text-*-soft` foreground classes use background tokens; dashboard mobile headings/metrics, phone back/fallback icons, mobile ticket resolve, generation count, and date-range middle cell hardcode navy; chart ticks use low-contrast gray on light surfaces; analytics series include near-black colors on dark surfaces; Lazada dashboard meters and admin-selected chat bubble colors need contrast review. Plan: repair shared foreground token pairs and replace only foreground uses of soft tokens; use theme-aware chart tick/series tokens; correct the calendar and responsive CSS foregrounds; calculate contrasting bubble text for arbitrary admin-selected colors in both preview and rendered botworker messages. Review light/dark for the reported route families and sample every route/device class; do not claim visual confirmation outside actually exercised routes/viewports.

**2.5D header-mark source map — 2026-11-14:** generate transparent, family-specific static marks for dashboard/analytics, inbox/chat, workflow, knowledge, generation, testing, management, settings, and help. Keep them inside the existing header emblem footprint, lazy-loaded and optimized by Next Image; add the current route's Lucide mark as a small semantic badge. Resolve custom headings in dashboard, tickets/shadow inbox, generation, workflow editor, and other page headers that do not use `PageShell`; preserve the original heading/back/action structure.
