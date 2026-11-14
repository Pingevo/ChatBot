# Full-Device Console UX — Design Spec

**Date:** 2026-11-13
**Status:** Expanded scope approved by user; implementation underway
**Scope:** All 40 authenticated ChatAdminWeb routes and shared states on phone, tablet, and laptop/desktop.

## 1. Product intent

Rebuild the responsive presentation so the console feels intentionally designed at every supported size. UX clarity comes first; visual polish, color contrast, and motion should make the important work easier to notice and feel responsive. The page/workspace frame uses the full viewport. Text, controls, charts, and other objects receive deliberate inner breathing room, while the frame and its major panels align to the viewport edges.

This is a Thai-first internal operations console for customer support, bot testing, analytics, configuration, and management. Keep its macaron navy and maroon identity. Give each page one clear focal task and a role-based typographic hierarchy: page title, section heading, body, supporting text, metadata, and key metric must not share one scale.

Add a restrained 2.5D pixel-art character/object treatment in places that benefit from motivation or progress, especially the dashboard and generation pipeline. Use layered depth, controlled light/shadow, and meaningful color contrast. Keep the interface clean: avoid decorative clutter, repeated large cards, nested boxes, oversized glow, or motion that distracts from live operations.

## 2. Scope and invariants

- Cover all 40 authenticated routes listed in Section 8, plus shared login, SSO, loading, empty, error, confirmation, and not-found states.
- Preserve every existing route, permission gate, field, data source, API request, action, callback, confirmation, save behavior, navigation destination, and route-owned state.
- Do not edit `chatbot/`, ChatLogic behavior, database schemas, permission rules, route contracts, or API business logic.
- Redesign phone, tablet, and laptop/desktop presentations; phone is not frozen to the existing composition.
- Keep navy and maroon as the core brand anchors. Preserve each administrator's light/dark preference and existing semantic status colors.
- Support touch, mouse, trackpad, keyboard, portrait, landscape, safe areas, and the on-screen keyboard. No action may rely on hover alone.
- Keep full-screen workspaces (chat, shadow inbox, workflow canvas, login) edge-aligned. Apply one intentional content gutter inside each frame; do not stack an app gutter, page card gutter, and page-content gutter around the same content.
- Prefer existing route-owned state, shared components, and installed libraries. Do not add a parallel data/state owner or a dependency for effects that can be achieved with existing assets and CSS.
- On phone and tablet, keep the navigation dock floating and rounded. Its order is หน้าแรก → แชท → เมนู → สถิติ → โปรไฟล์. Open the menu as a centered floating dialog over a dimmed/blurred backdrop; place logout under “ทั่วไป” and use one circular X close button at the former footer position.
- Match the supplied menu wireframe proportions: keep a distinct header, one body region that flexes to fill the remaining dialog height even when it has few items, and a separate footer close action. On iPad landscape, size the centered panel close to the supplied 1024×768 reference; body content can be a list, cards, or another component without shrinking the body frame.

## 3. Layout and typography contract

### Full-viewport frame

- `AppShell` and each page/workspace frame fill the available viewport, including safe-area handling where required.
- The background canvas fills the viewport. Place hero and content cards on that canvas; align their outer edges to the same page column so card width and spacing feel related to the header/hero instead of stretching every card to the screen edge.
- Keep chat panes and workflow canvases full-bleed within their workspace. For card-based pages, inset the card group from the viewport once, then use a consistent local inset for the content inside each card.
- Starting page-column gutter is 16px on phones, 20–24px on tablets, and 24–32px on laptops. Dense tables and chat may use a smaller local inset where that improves usable width; do not add a second app-shell gutter around the same column.
- Use whitespace between content groups, not as a second outer border. Avoid card-within-card treatment; use spacing, dividers, tone, and typography to group information.
- Keep one page title/header. Page title and primary action must not be duplicated in a global header and the route page.

### Dynamic type roles

Use shared responsive tokens based on type role and available width, with readable Thai line height and numeric alignment:

| Role | Starting range |
| --- | --- |
| Metadata / timestamps | 11–12px |
| Supporting labels | 12–13px |
| Body / table rows | 14–16px |
| Section heading | 16–19px |
| Page title | 20–28px |
| Key metric | 28–44px, only when it is the page focus |

These are starting ranges, not a rule to enlarge every element. Compact dense data without shrinking interactive labels below legibility. Use one Thai-capable font stack at all widths; retain Geist for Latin/numerals if useful and prefer local/system Thai fallbacks. Do not add a remote font dependency that delays render or makes builds depend on network access.

### Device and input adaptation

| Context | Presentation |
| --- | --- |
| Phone, below 768 CSS px | Full-width page frame, compact top heading, content-first vertical flow, safe-area-aware bottom navigation, keyboard-aware forms and composer. |
| Coarse-touch tablet, 768–1279 CSS px | A distinct tablet layout with its own floating navigation dock and tablet-specific workspace compositions. Landscape must not simply become the laptop layout. Keep edge-aligned panels and touch targets. |
| Fine-pointer laptop, 768–1439 CSS px | Compact rail by default; expand navigation when useful. Keep workspaces content-driven and collapse secondary panes before the primary task becomes too narrow. |
| Wide laptop/desktop, 1440px and above | Full navigation may expand by default; use readable maximum widths for text and data while workspace frames remain edge-aligned. |

Breakpoints must be checked against container width and input capability. Do not show a pane merely because the viewport crosses a breakpoint if it makes the primary content unreadable.

## 4. Visual and motion direction

- Build clear contrast from layered navy/maroon surfaces, warm light backgrounds, and restrained dark surfaces. Preserve readable semantic colors in both themes.
- Keep page identity consistent while giving each page a focal point: one primary task, one visual anchor, and quieter supporting information.
- Use 2.5D depth selectively for pixel-art objects: separate foreground/background layers, subtle perspective, soft contact shadows, and controlled highlights. Keep sprite scale and contrast readable; do not place decoration over controls or data.
- Focus expressive pixel-art motion on the dashboard and generation progress. Generation cat movement remains aligned with its progress track and respects the established state/action behavior and 30 fps motion target when active. Completed/idle states must not jitter or move sideways without purpose.
- Prefer short, directional motion for an actual state change or user action. Keep optional heavy effects lazy and route-local; static content must render first and remain fully usable if animation fails.
- Respect `prefers-reduced-motion`, keyboard focus, touch feedback, and color contrast. Do not animate layout dimensions in a way that delays scanning or input.

## 5. Route patterns and required corrections

### Navigation and page frame

- Keep every current route destination and permission-filtered menu group/search.
- Make the signed-in user's profile/settings available from a persistent, obvious location outside the overflow/More menu. Keep logout available and preserve its confirmation.
- Keep a visible, predictable back path on deep routes. Back must preserve the current browser/route behavior and unsaved-change confirmation.
- Use consistent page headers and boundaries across phone, tablet, and laptop. Remove duplicate page titles and duplicate close/collapse controls.

### Inbox, chat, and review

- Keep conversation and composer as the visual focus. Show list + conversation side by side only when both meet readable minimum widths.
- Make ticket details/info a contextual pane or overlay appropriate to available width, with exactly one close/back action for the current mode.
- Keep claim/close/reopen, assignment, status, send, review, image, copy, and confirmation actions reachable without covering the composer or conversation.
- Preserve draft text, selected ticket, filters, scroll state, and all current chat data/actions when opening or closing detail.

### Dashboard and analytics

- Render the daily trend as a readable bar chart for both single-point and multi-point data. Keep labels, tooltip, date range, breakdowns, and text equivalents.
- Keep charts legible within their parent container and across light/dark themes. Do not replace a chart with counts alone.
- Use the dashboard as the main restrained 2.5D pixel-art motivation area; make metrics and chart remain the focus of operations.

### Lists, tables, forms, and settings

- Remove unnecessary list-card fields from the initial scan; retain existing detail/action paths for full information.
- Preserve filtering, sorting, selection, bulk actions, pagination, copy, row actions, validation, password/theme settings, and save feedback.
- Use multi-column forms only when the content container has enough width. Keep related fields together and primary save/apply actions reachable while scrolling.
- Menus, alerts, popovers, and dialogs remain fully inside the viewport and attached to their trigger or centered according to their modal role.
- On phone and tablet, group search/sort/filter controls into a clear, compact touch surface instead of crowding multiple dropdowns into a toolbar. Any menu or filter panel must fit the visual viewport and preserve the existing selected values and filtering behavior.

### Workflow editor and generation pipeline

- Keep the workflow canvas edge-aligned and preserve graph IDs, handles, branches, validation, import/export, bindings, serialization, publish, and save behavior. Phone/tablet views must show the actual node-and-edge path rather than a detached node list. Keep Back and Save easy to reach; group secondary validation, settings, import/export, delete, and publish actions into a compact tools surface without removing them.
- Workflow list cards should preview a small, truthful path built from the current graph edges; keep long descriptions and secondary metadata out of the initial scan while retaining the existing open/edit/import/export/toggle/delete paths.
- Show one consistent pixel-cat sprite treatment above progress on every device. Align the cat, completed track, status, and marker with a single progress calculation. Preserve daily/weekly lanes only where backend data provides them; do not invent a lane.
- Keep build mode, actions, status, progress, history, and detail access available at all sizes. Give the progress view its 2.5D road/depth lighting without obscuring the status or controls.

## 6. Acceptance criteria

1. A route inventory covers all 40 routes and shared authentication/loading/empty/error states before implementation.
2. Every existing route action, permission gate, field, destination, state, and API/data owner remains present and reachable; no ChatLogic or business-flow changes are introduced.
3. Every route uses the same full-viewport frame contract, with one controlled inner gutter for content and aligned page header/workspace boundaries.
4. Typography uses role-based sizes at every viewport; title, body, support, and metadata are visibly distinct and remain legible in Thai.
5. Visual contrast is intentional in light/dark themes. Pixel-art depth/motion appears in selected motivation/progress areas and does not make other pages busy.
6. No page-level horizontal scrolling, clipped primary action, hidden essential field, overlapping header, duplicated close/back control, or unreadable workspace pane.
7. Ticket list/chat/info, dashboard/chart, workflow editor, forms/lists, and generation progress remain legible and preserve their existing action paths.
8. Navigation exposes profile/settings outside More and preserves permission filtering, grouped search, route destinations, logout confirmation, and back behavior.
9. Phone/tablet menu is a floating rounded dialog with a dimmed background, one close X, and logout under “ทั่วไป”; touch filter/sort controls remain reachable and fit their viewport across route families.
10. Motion respects reduced-motion and active generation motion stays aligned with the progress state; static/fallback content remains usable without WebGL or an animation library.
11. Visual review covers 320×568, 390×844, 768×1024, 820×1180, 1024×768, 1280×800, 1366×768, and 1440×900, in both themes and with coarse/fine pointer input where applicable. Record emulated versus physical-device review accurately.
12. Review all 40 routes for frame/header/gutter/overflow consistency; exercise full workflows on representative routes for chat, forms, tables, analytics, workflow and generations.

## 7. Implementation guardrails

- Reconcile `AppShell`, `PageShell`, route page wrappers, and `globals.css` so the same viewport does not receive multiple outer paddings/radii.
- Use the existing typed permission system and route-owned handlers as truth. Do not solve presentation defects by changing business behavior or API contracts.
- The current source mixes md/lg breakpoints in navigation and inboxes; choose transitions from available space and input method, then apply them consistently.
- Keep shared layout primitives focused. Avoid broad selectors that silently change unrelated component geometry; use explicit page/workspace classes where necessary.
- Existing working-tree UX changes on this branch are in progress and must be inspected and adapted, not discarded.
- This spec is the implementation authority. The user approved the expanded spec and plan on 2026-11-13; follow the plan in the current assigned branch/workspace.

## 8. Route inventory (40)

| Group | Routes |
| --- | --- |
| Core | `/dashboard`, `/tickets`, `/chats`, `/shadow-inbox`, `/backlog` |
| Analytics | `/analytics`, `/analytics/live`, `/analytics/performance`, `/analytics/admin-activity` |
| Workflow and knowledge | `/triggers`, `/workflows`, `/workflows/[workflowId]`, `/quick-replies`, `/knowledge`, `/zaapi-kb-mapping`, `/generations`, `/persona`, `/shop-settings` |
| Bot testing and review | `/test-chat/shopee`, `/test-chat/tiktok`, `/test-chat/lazada`, `/botworker`, `/test-assignment`, `/live-assignment`, `/replay-compare`, `/test-results`, `/test-chat-result`, `/admin-review-kpi`, `/admin-chat-result` |
| Management and settings | `/shops`, `/contacts`, `/team`, `/users`, `/admin-config`, `/config`, `/llm`, `/roles`, `/logs`, `/help`, `/settings` |

This list is the authenticated console route inventory; shared login/SSO and generic loading/error states are reviewed separately.
