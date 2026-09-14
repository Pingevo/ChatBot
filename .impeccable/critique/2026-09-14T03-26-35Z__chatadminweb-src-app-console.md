---
target: ChatAdminWeb console UX/UI ทั้งหมด + routes
total_score: 35
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 6
target_identity: "file:/Users/itdev4/Documents/GitHub/ChatBotProductMS/ChatAdminWeb/src/app/(console)"
timestamp: 2026-09-14T03-26-35Z
slug: chatadminweb-src-app-console
---
# Critique Round 27 — ChatAdminWeb (console) — post-responsive-redesign audit

Method: dual-agent (A: design review — source; B: detector CLI + technical scan + Chrome headless /login)

## Design Health Score: 35/40 (จาก 33/40 รอบ 26)

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 4 | Toast/Loading/ConfirmDialog shared; live badge; dirty indicator |
| 2 | Match System / Real World | 4 | Thai-first, domain terms (ตั๋ว/กล่องเงา/จ่ายงาน), platform colors |
| 3 | User Control and Freedom | 3 | confirm ก่อนลบ, backdrop/Escape บางส่วน — ยังไม่มี undo |
| 4 | Consistency and Standards | 4 | PageShell/Card/Button/tokens ใช้ร่วมกันสม่ำเสมอ |
| 5 | Error Prevention | 4 | danger switches lock, dirty-form guard, confirm destructive |
| 6 | Recognition Rather Than Recall | 4 | icon+label nav, platform badges, filter chips |
| 7 | Flexibility and Efficiency | 4 | Ctrl+B, `/` search, quick replies, shortcuts |
| 8 | Aesthetic and Minimalist | 3 | filter bars 6-8 ตัวหนาแน่น (triggers/quick-replies/knowledge) — regressed |
| 9 | Error Recovery | 3 | toast error ชัด แต่ฟอร์มบางส่วนขาด inline validation |
| 10 | Help and Documentation | 3 | /help มีจริง + per-page help icon แต่ไม่มี onboarding/tooltip เชิงลึก |

## Audit Health Score: 13/20 — Acceptable (significant work needed)

| # | Dimension | Score | Key Finding |
|---|-----------|-------|-------------|
| 1 | Accessibility | 2 | `--color-text-subtle` #8b9bb0 = 2.8:1 contrast (WCAG AA fail, systemic); ไม่มี prefers-reduced-motion; icon buttons 5 จุดไม่มี label; clickable divs ไม่มี keyboard |
| 2 | Performance | 3 | ไม่พบ layout thrash/animation หนัก; token-based; minor gaps |
| 3 | Responsive Design | 3 | pattern table↔card + drawer ใช้ได้ 13/15 routes แต่ /contacts clip บนมือถือ, panels w-[340px]/dropdown w-[380px] overflow |
| 4 | Theming | 2 | tokens ดี แต่ 175 hex นอก globals.css — WorkflowEditor 37 hits bypass tokens, dashboard platformColors diverge |
| 5 | Implementation Integrity | 3 | detector clean (0 findings); coherent shared primitives; drift จุดเดียวใน WorkflowEditor |

## Implementation Integrity Verdict: PASS

Detector `impeccable detect --json ChatAdminWeb/src` → `[]` (0 findings, verified binary working via synthetic file). Design system มีเอกภาพ — PageShell/Card/Button/ToggleSwitch/Pagination shared. Drift เดียวที่ verify ได้: WorkflowEditor ใช้ hex ตรงแทน tokens + dashboard platformColors ไม่ตรง token platform colors.

## Priority Issues

- **[P1] /contacts table clip บนมือถือ** — `contacts/page.tsx:209-222` table ไม่มี overflow-x-auto/ไม่มี mobile card — table เดียวใน 8 ไฟล์ที่ไม่มี protection → columns หายบนจอ <lg
- **[P1] Token contrast fail** — `--color-text-subtle` #8b9bb0 on white = 2.8:1 (detector confirm บน /login) — ใช้ทั่ว app สำหรับ caption/helper text
- **[P1] Mobile nav orphans** — /settings, /help, /test-chat/lazada, /test-chat/tiktok เข้าไม่ได้จากมือถือ (Sidebar footer/submenu only, MobileNav ไม่มี)
- **[P1] ไม่มี prefers-reduced-motion** — animate-slide-in/up (drawers), animate-pulse-soft (infinite live badge) + ~100 transitions รัน unconditionally
- **[P1] Icon buttons 5 จุดไม่มี aria-label/title** — WorkflowEditor.tsx:458/516 (X close 24px บน mobile), replay-compare:1309/1343 (copy), team:1522 (switch ไม่มี accessible name — ใช้ ToggleSwitch shared แทนได้)
- **[P1] Filter bar overload** — triggers (7-8 controls), quick-replies (6), knowledge (5+tabs) — >4 decisions พร้อมกัน
- **[P2] Touch targets <44px จำนวน 108 จุด** (~104 mobile-visible, 17 mobile-only) — รวม w-5 h-5 (20px < WCAG 24px floor) เช่น TestChatClient:2389; back/close buttons ทุก chat page 28-32px
- **[P2] Fixed-width panels** — w-[340px] tickets:430/live-assignment:739/botworker:404 overflow <340px viewport; w-[380px] UnifiedDateRangePicker:193 overflow <380px
- **[P2] Page modals ไม่มี Escape** — knowledge:838, quick-replies:748, triggers:967, workflows:546, shop-settings:598, CloseChatModal:50 (ui primitives มีแล้ว — page-level ยังไม่)
- **[P2] Clickable divs ไม่มี keyboard** — workflows:449 (card→router.push), TestChatClient:2009/2518
- **[P2] Token divergence** — WorkflowEditor #8b5cf6/#ef4444/#8b1e28 hex ตรง; dashboard:14-16 platformColors ≠ tokens; config:360 bg-[#0a1628]
- **[P3] / → /chats → /tickets double redirect**; AppShell.tsx:30-38 stale comment (test-chat bypass ไม่มีจริง — middleware block); z-index ไม่ tokenized
- **[BUG — นอกขอบ UX]** TestChatClient hardcode "shopee" ใน API calls หลายจุด (807/951/1014/1296/1403) แม้ prop platform=lazada/tiktok — หน้า test-chat lazada/tiktok อาจดึงข้อมูลผิด platform

## Route Integrity

Dead links: 0 — ทุก nav href resolve ได้. Orphans: /settings, /help (sidebar footer เท่านั้น), /test-chat/{lazada,tiktok} (submenu only), /chats (intentional redirect), /workflows/[id] (ผ่าน card click — keyboard issue).

## Strengths

1. AppShell + MobileNav bottom bar + drawer "เพิ่มเติม" — ทุก feature หลักถึงได้บนมือถือ
2. Table↔card dual-mode ใช้สม่ำเสมอ 13/15 routes (users/logs/test-results/team ฯลฯ)
3. Tri-pane mobile chat (list→chat→info) บน tickets/shadow/test-assignment คิดมาดี
4. Workflow editor toolbar ใหม่: icon buttons + status-colored select + iOS switch

## Browser evidence

SSO-gated: ทุกหน้า 307→/login (ยืนยัน curl). Chrome headless screenshot /login 390px+1280px สำเร็จ — render ถูกต้อง; detector URL-mode confirm contrast finding บน /login จริง. Playwright ไม่พร้อมใช้.
