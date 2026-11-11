# Mobile Console UX Redesign — Design Spec

**Status:** Ready for user review
**Scope:** Mobile presentation for the existing ChatAdminWeb console
**Design decision:** A dedicated phone presentation layer that shares each route's existing data, state, permissions, and actions

## 1. Product intent

Make the admin console comfortable to use one-handed on a phone, including during live chat and while the software keyboard is open. The interface should feel calm, clear, and welcoming while keeping every current page, action, permission, and workflow available.

The visual direction is **Pocket Ops Companion**: the existing bright white surfaces, deep navy text, maroon brand accents, platform colors, and semantic status colors, with generous touch spacing and a small pixel-art cat-girl mascot. The mascot adds warmth to low-pressure moments; it never competes with customer messages, warnings, or actions.

The desktop presentation remains as it is. Mobile views are distinct components, not a scaled-down desktop layout. Route owners continue to own business state and actions so desktop and phone cannot silently diverge.

## 2. Scope and invariants

- Support phone portrait and phone landscape. The landscape layout is recognized by a short viewport with a coarse pointer, even when its CSS width is greater than the portrait breakpoint.
- Keep page movement vertical. No page, card, table, tab strip, filter row, code block, or workflow canvas may require a horizontal swipe. Long text wraps; long identifiers expose a copy action and a readable detail view.
- Keep the current route behavior, API requests, data values, role checks, save/delete/approve semantics, confirmation requirements, pagination, filters, and navigation destinations.
- Keep the desktop and tablet presentation unchanged at widths of 768 CSS px and above unless a short-height, coarse-pointer landscape viewport is identified as a phone.
- Keep the current desktop palette and font stack. Do not introduce a dark-only theme or a new brand palette.
- Avoid forcing device orientation or disabling browser zoom.

## 3. Mobile shell and navigation

### Page frame

- Use a compact page header with a readable title, current page context, and one prominent action. Put secondary actions in a clearly labeled action menu; never remove an action because the header is narrow.
- Use one primary vertical content column in portrait. In landscape, reflow independent content into two columns only when it improves scanning and leaves enough height for the current task.
- Retain the current bottom navigation destinations: **หน้าแรก**, **แชท**, **สถิติ**, and **เพิ่มเติม**. Preserve the active route indicator, permission filtering, searchable grouped menu, profile shortcut, and logout confirmation.
- Ensure every existing route is findable through the mobile navigation, subject to the same page permissions. Nested-page back actions return to the prior list and preserve its filters and scroll position.
- Hide the bottom navigation while the software keyboard is open. Restore it after the keyboard closes without changing the route or losing form state.

### Scroll and safe areas

- The document and all mobile surfaces fit the viewport width; only vertical scrolling is needed. Use safe-area insets for top and bottom controls.
- Sheets and long menus scroll vertically inside their own bounds. Opening a sheet does not move the page behind it.
- Keep pinch zoom available. Avoid broad gesture rules that block text selection, native input behavior, or assistive technology.

## 4. Interaction and component language

Create phone-only components in a mobile presentation layer. Each page-specific view receives the same route-owned state and action callbacks used by its current view. Shared controls standardize phone behavior without taking over feature logic.

| Mobile component | Design behavior |
| --- | --- |
| `MobilePageHeader` | Thai-first title and context; one clear primary action; wraps without overlap in landscape. |
| `MobileCard` / `MobileDataCard` | Clear label-value hierarchy; all fields remain available; secondary details expand vertically. |
| `MobileButton` | Minimum 48 CSS px high for primary touch actions; clear text labels; loading and disabled states. |
| `MobileAlert` | Plain-language status, next step, and inline retry when the existing flow supports retry. Severity is conveyed by text/icon as well as color. |
| `MobileSheet` / `MobileConfirmDialog` | Full-width, vertically scrollable, safe-area aware, keyboard aware, dismissible with a clear close action; destructive actions remain explicit. |
| `MobileFormField` | Persistent visible label, helper text where useful, inline validation beside the field, correct input mode, and retained values on validation errors. |
| `MobileFilterPanel` | Filters stack or wrap. Large filter sets open in a sheet with selected count, Apply, and Reset actions. |
| `MobileEmptyState` | Explains what is missing and offers the next available action; optional small mascot for friendly, non-critical states. |
| `MobileChartCard` | Responsive 2D chart, text summary, readable labels, and an equivalent accessible data list/table. |
| `MobileChatComposer` | Message field and send/action controls remain visible above the keyboard and safe area; the conversation itself scrolls independently. |

All interactive targets have a visible focus state and at least 44 CSS px hit area; frequent primary actions use 48 CSS px. Leave at least 8 CSS px between adjacent targets. Do not rely on hover or icon-only affordances.

## 5. Mobile-specific page patterns

### Conversation work

- Ticket, bot-worker, shadow-inbox, live-assignment, and replay-compare screens use a list → conversation/detail flow on portrait phones. Selecting a conversation opens a full-height conversation view; Back returns to the same list position and filters.
- On wider phone landscape, list and conversation may share the screen if the keyboard is closed. When the keyboard opens or available height becomes short, prioritize the active conversation and composer; list/detail metadata moves into a sheet.
- The message composer remains above the keyboard. The latest focused message or input remains visible when the viewport resizes. Closing the keyboard must not discard a draft or reset the conversation position.
- Keep existing send, assignment, approval/rejection, review, image-viewing, copy, and status actions and their confirmations intact. Do not place the mascot over a customer message or message composer.

### Lists, tables, and filters

- Replace dense tables with vertically stacked cards. Each card exposes the fields and actions represented in the current row. Secondary fields expand in place; pagination, sorting, selection, bulk actions, and row-level actions remain available wherever the page currently supports them.
- Convert tab bars and filter chips to wrapped controls or a labeled select/sheet. Do not create horizontal carousels or horizontally scrolling toolbars.
- Keep search, active filter count, clear filters, result count, and loading state visible and understandable.

### Forms and settings

- Use a full-screen sheet for multi-section forms and a compact dialog only for short decisions. Keep Save/Apply and Cancel reachable above the keyboard; otherwise put them in a safe-area-aware bottom action bar that yields while the keyboard is open.
- Use a minimum 16 CSS px font size in text inputs to prevent iOS focus zoom. Use the appropriate `inputmode`, autocomplete, and native input type for each existing field.
- Scroll the active field into view after focus/validation. Inline error text explains what to correct. If a save fails, preserve entered values and show the existing retry path.
- Read-only, disabled, and editable states continue to follow the current role and feature flags.

### Workflow editor

The phone view replaces the desktop canvas interaction with a vertical workflow outline and a dedicated connection editor. It must preserve the graph rather than flattening it into a linear sequence:

1. Show every node as a labeled card in a readable vertical outline, including its type, enabled state, and current outgoing connections.
2. Add nodes from the existing node palette. Selecting a node opens its existing configuration fields in a sheet; duplicate, delete, save, import, validation, and workflow settings retain current behavior.
3. Edit a connection by selecting a source node, its output handle/branch, and a target node. This supports ordinary edges, true/false conditions, multi-branch handle IDs, and cycles exactly as represented by the current graph.
4. Show each edge with source, branch label, and target. Add/remove edge actions use existing graph state and validation. No canvas drag is required on a phone.
5. Keep import preview, binding resolution, structural/capability validation, and save results accessible as stacked sections or sheets.

Node canvas coordinates are a desktop layout detail and may remain untouched by phone editing. All node data, edge IDs, branch IDs, and saved workflow semantics remain unchanged.

## 6. Dashboard and graphs

Preserve the dashboard's date-range presets/custom range, five conversation KPI cards, two message KPI cards, trend series, platform breakdown, topic breakdown, and current empty/loading/error behavior. Do not change the statistics source or definitions.

On phones:

- Place the date-range control near the page title and open a compact vertical picker with the same presets and custom date selection.
- Show the five conversation KPIs as compact readable cards (two columns in portrait when each card still has room for its label and value; one column in narrow/short layouts). Keep both message KPIs as a separate labeled section.
- Give the trend chart the strongest visual emphasis. Use a responsive 2D line/area chart, a clear period title, compact axis labels, and a tap/focus tooltip with the exact value. Include a text summary and accessible data list so color or hover is never the only way to read it.
- Present platform breakdowns as labeled value + proportional bar rows. Present topic breakdowns as wrapped rows/cards with both topic and count, never a horizontally scrolling chip strip.
- Preserve the current `has_real_data` status and distinguish unavailable/stale data from zero without inventing data.

Use GSAP only for short, useful transitions such as the dashboard's initial card entrance, sheet entry, or a save confirmation. Keep content visible if animation code fails; use transforms/opacity, avoid layout animation, stop offscreen work, and honor `prefers-reduced-motion`.

Three.js is a progressive visual accent only: a small, decorative, pixel-styled companion scene around the dashboard mascot. It is never the chart, never encodes unique data, and never blocks dashboard interaction. Load it only after the dashboard has rendered and the visual is near the viewport (and the browser is idle when possible). Keep the crisp static pixel-art image as the immediate and permanent fallback. Skip the 3D scene for reduced-motion, data-saver, unsupported WebGL, or low-capability devices, and release its renderer when it leaves view.

GSAP and Three.js must be code-split and absent from the initial bundles of routes that do not use them. The dashboard and all its data remain usable if either library fails to download.

## 7. Pixel-art cat anime-girl mascot

- Create an original, small pixel-art cat-girl mascot in navy, maroon, cream, and a few existing semantic accents. Use crisp pixel edges and an optimized transparent raster asset; do not use emoji or a borrowed character.
- Place it in the dashboard welcome area, friendly empty states, and selected low-stress help/onboarding moments. Keep it out of active conversations, destructive confirmations, serious errors, permissions failures, and dense forms.
- Pair it with one short friendly line only when that helps the user understand what to do next. The art never carries operational information by itself.
- Decorative instances are hidden from screen readers; meaningful linked/help instances receive concise Thai alternative text and a normal text label. Keep the asset small and load it only on screens where it appears.
- Any blink/idle animation is brief and subtle. It stops when offscreen and is disabled under reduced motion. Static art remains complete and clear.

## 8. Visual system

Reuse the current CSS tokens from `ChatAdminWeb/src/app/globals.css`:

- Maroon brand: `#8b1e28`; dark/light/soft aliases remain the existing values.
- Deep navy: `#0b2340`; navy soft/light remain existing values.
- White and neutral surfaces: `#ffffff`, `#fafbfc`, `#f4f6f8`, `#e9edf2`, `#d6dde5`.
- Existing success, warning, error, info, and Shopee/TikTok/Lazada colors.
- Existing Geist sans/mono font variables, radius, and shadow scale.

Favor white surfaces, navy headings, maroon primary actions, restrained borders, and one level of card elevation. Avoid frosted-glass layers and decorative gradients that reduce text contrast or make dense work slower to scan. Verify text contrast against the actual token pairs during implementation.

## 9. Route coverage

These are the 40 existing console route pages. Mobile redesign adds no route and removes none.

| Group | Existing routes |
| --- | --- |
| Overview and analytics | `/dashboard`, `/analytics`, `/analytics/live`, `/analytics/performance`, `/analytics/admin-activity` |
| Inbox and operations | `/tickets`, `/botworker`, `/shadow-inbox`, `/chats`, `/contacts`, `/backlog` |
| Process, knowledge, shops, and administration | `/triggers`, `/workflows`, `/workflows/[workflowId]`, `/quick-replies`, `/knowledge`, `/zaapi-kb-mapping`, `/generations`, `/persona`, `/shop-settings`, `/shops`, `/team`, `/users`, `/admin-config`, `/config`, `/llm`, `/roles`, `/logs`, `/settings`, `/help` |
| Bot testing and review | `/test-chat/shopee`, `/test-chat/tiktok`, `/test-chat/lazada`, `/test-assignment`, `/live-assignment`, `/replay-compare`, `/test-results`, `/admin-review-kpi`, `/admin-chat-result`, `/test-chat-result` |

Also provide responsive presentation for `/login`, the root redirect, and the shared loading, error, global-error, and not-found states. Keep authentication, SSO, route guards, role-based visibility, and error recovery unchanged.

## 10. Acceptance criteria

The implementation is ready only when all of the following are demonstrated:

1. Each route in the coverage table has a phone view and retains every existing action, data field, permission check, and save/approval flow.
2. At 320, 360, 390, and 430 CSS px portrait widths, and coarse-pointer phone landscape widths including 667×375 and 844×390, the page has no horizontal overflow or sideways page pan. Long labels, IDs, filters, and charts remain reachable.
3. On iOS Safari and Android Chrome, opening the keyboard in chat, search, form, date picker, and navigation menu keeps the focused field and primary action visible; no fixed nav/footer covers them; draft/form state survives keyboard open/close.
4. Portrait and landscape orientation changes preserve route, user input, selected record, filters, and scroll position where the current flow expects it.
5. Workflow phone editing can add/configure/delete nodes and create/remove ordinary, true/false, and multi-branch edges, then save the same graph semantics. Import, validation, and binding-review flows remain usable.
6. Dashboard KPIs, date selection, chart values/tooltips, platform rows, topic rows, loading, empty, error, and no-real-data states remain available without relying on 3D or hover.
7. The `เพิ่มเติม` menu exposes every route allowed for the current role, search remains usable with the keyboard open, and logout retains its confirmation and error/success feedback.
8. `prefers-reduced-motion`, data-saver, missing WebGL, or animation-download failure leaves the interface complete, readable, and interactive.
9. GSAP/Three.js are not downloaded by unrelated pages; the static dashboard chart and mascot appear before optional animation/3D chunks.
10. Existing desktop screenshots/layout behavior at 768px and above remain unchanged, except the explicitly identified phone-landscape condition.
11. Touch targets, focus visibility, labels, contrast, live announcements for async feedback, and non-color status cues pass a focused accessibility review.

## 11. Known implementation checks for the follow-up plan

- Establish current mobile chunk sizes before adding dependencies; measure route-level output after code splitting.
- Verify the short-height landscape media-query behavior and keyboard detection without changing ordinary tablet/desktop breakpoints.
- Audit each route's current action list while connecting its mobile view to the existing state owner.
- For workflows, compare serialized node/edge IDs and branch IDs before and after representative phone edits.
- Review each screen for keyboard overlap, horizontal overflow, and reduced-motion behavior on both browser families.
- Preserve unrelated working-tree files and commit only the agreed mobile work plus required waythrough records.

This document specifies the intended experience. No application source, dependencies, assets, or tests were changed as part of the design-spec stage.
