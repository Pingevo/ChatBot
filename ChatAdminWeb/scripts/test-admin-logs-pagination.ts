// test-admin-logs-pagination.ts — RED tests: /logs server-side numbered pagination
//
// รัน: npx tsx scripts/test-admin-logs-pagination.ts
//
// ทุก test วิ่งบน fake Mongo aggregation ใน memory (mock ที่ module boundary — hooks.mjs)
// ไม่มี Mongo/SSO/network จริง
//
// ── Contract ที่ assert (spec Parts 1–5, pageSize=100) ──
//   service : listAdminLogsExtended → {rows,page,pageSize,total,totalPages}
//             aggregation เดียว: $match → $lookup → $addFields → $match(search)
//             → $sort {timestamp:-1,_id:-1} → $facet{rows:[skip,limit],meta:[$count]}
//   route   : page/pageSize/admin_id/action_type/action_types/since/q
//             page≥1, pageSize default 100 clamp 1–100, invalid→default
//   Pagination: showBoundaryButtons (first/last, Thai aria-labels) + responsive
//             (CSS clusters ≤3/≤5/≤maxButtons) — default หน้าอื่นไม่เปลี่ยน
//   page.tsx: PAGE_SIZE=100, poll เฉพาะ page===1, ไม่มี client filter, _id keys,
//             search debounce ~300ms, stale-response guard, expanded reset ตอนเปลี่ยนหน้า

import { register } from "node:module";
import { readFileSync } from "node:fs";

// ⚡ ต้อง register ก่อน import service/route — static imports ของไฟล์นี้มีแค่ builtins
register(new URL("./test-admin-logs-pagination-hooks.mjs", import.meta.url));

// boundary เป็น any — mocks เป็น .mjs (untyped) และ row types ของ service
// ไม่มี _id ใน AdminLogDoc (fake docs ใส่ string _id) — test เป็น harness script ไม่ใช่ src
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mocks: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let svc: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let route: any;

// ── test harness ─────────────────────────────────────────────
let pass = 0;
let fail = 0;
const fails: string[] = [];
async function t(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    pass++;
  } catch (e) {
    fail++;
    fails.push(`${name} :: ${(e as Error).message}`);
  }
}
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}
function eq<T>(got: T, want: T, msg: string) {
  if (got !== want) throw new Error(`${msg} (got=${JSON.stringify(got)} want=${JSON.stringify(want)})`);
}

// ── seed data ────────────────────────────────────────────────
const T0 = new Date("2026-10-01T00:00:00Z").getTime();
function seedDocs() {
  mocks.resetState();
  const logs = mocks.fakeColl("admin_logs");
  const admins = mocks.fakeColl("admins");
  admins.push(
    { admin_id: "ax_hid", username: "zzz_name", name: "Hid User", role: "admin" },
    { admin_id: "ax_hid2", username: "yzz", name: "qqq_full", role: "admin" },
    { admin_id: "a1", username: "nok", name: "Nok Admin", role: "admin" },
    { admin_id: "a2", username: "boy", name: "Boy Dev", role: "dev" }
  );
  // 240 generic docs — timestamps desc, _id asc (tiebreak ไม่เกี่ยวเพราะ timestamp ต่างกัน)
  for (let i = 0; i < 240; i++) {
    logs.push({
      _id: `gen_${String(i).padStart(3, "0")}`,
      admin_id: i % 2 ? "a1" : "a2",
      action_type: i % 2 ? "bot.reply" : "chat_assigned",
      conversation_id: "conv_a",
      shop_id: "shop_1",
      timestamp: new Date(T0 - i * 60_000),
    });
  }
  // 3 docs timestamp เท่ากัน — ทดสอบ _id tiebreak (คาด: c,b,a)
  for (const id of ["tie_a", "tie_b", "tie_c"]) {
    logs.push({ _id: id, admin_id: "a1", action_type: "login", timestamp: new Date(T0 + 60_000) });
  }
  // search fixtures — แต่ละตัว match q เฉพาะ field เดียว (ยกเว้น target/admin overlap โดยตั้งใจ)
  const base = { timestamp: new Date(T0 + 120_000) };
  logs.push(
    { _id: "s_username", admin_id: "ax_hid", action_type: "login", ...base },
    { _id: "s_name", admin_id: "ax_hid2", action_type: "logout", ...base },
    { _id: "s_action", admin_id: "a1", action_type: "workflow.wait_retry", ...base },
    { _id: "s_adminid", admin_id: "ax_special_admin", action_type: "login", ...base },
    { _id: "s_conv", admin_id: "a1", action_type: "login", conversation_id: "conv_special_99", ...base },
    { _id: "s_shop", admin_id: "a1", action_type: "login", shop_id: "shop_special_88", ...base },
    { _id: "s_ticket", admin_id: "a1", action_type: "login", ticket_id: "tck_777", ...base },
    { _id: "s_target", admin_id: "a1", action_type: "login", target_admin_id: "ax_hid", ...base },
    { _id: "s_literal", admin_id: "a1", action_type: "login", conversation_id: "conv.special_1", ...base }
  );
}

type Pipeline = Record<string, unknown>[];
function lastPipeline(): Pipeline {
  const calls = mocks.state.aggregateCalls;
  assert(calls.length > 0, "expected at least one aggregate() call");
  return calls[calls.length - 1].pipeline as Pipeline;
}
function stageIdx(p: Pipeline, op: string, from = 0): number {
  for (let i = from; i < p.length; i++) if (op in p[i]) return i;
  return -1;
}
const req = (qs: string) => new Request(`http://test.local/api/admin/logs${qs}`) as never;

async function main() {
  mocks = await import("./test-admin-logs-pagination-mocks.mjs");
  svc = await import("../src/backend/service/adminLogService");
  route = await import("../src/app/api/admin/logs/route");
  const { Pagination } = await import("../src/components/ui/Pagination");
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const el = React.createElement;

  // ═══ A. Service contract ═══
  seedDocs();

  await t("A1 service คืน {rows,page,pageSize,total,totalPages} ไม่ใช่ array ดิบ", async () => {
    const r = await svc.listAdminLogsExtended({});
    eq(r.page, 1, "page");
    eq(r.pageSize, 100, "pageSize default=100");
    eq(r.total, 252, "total");
    eq(r.totalPages, 3, "totalPages=ceil(252/100)");
    assert(Array.isArray(r.rows), "rows ต้องเป็น array");
    eq(r.rows.length, 100, "page 1 มี 100 rows");
  });

  await t("A2 sort pipeline = {timestamp:-1,_id:-1} (stable order)", async () => {
    await svc.listAdminLogsExtended({});
    const p = lastPipeline();
    const i = stageIdx(p, "$sort");
    assert(i >= 0, "ไม่มี $sort stage");
    assert(JSON.stringify(p[i]) === JSON.stringify({ $sort: { timestamp: -1, _id: -1 } }),
      `sort spec ผิด: ${JSON.stringify(p[i])}`);
  });

  await t("A3 ลำดับจริง: timestamp desc + _id tiebreak (เคส timestamp เท่ากัน)", async () => {
    const r = await svc.listAdminLogsExtended({ pageSize: 15 });
    const ids = r.rows.map((x: { _id: string }) => x._id);
    // s_* 9 ตัว timestamp เท่ากัน (T0+120s) → _id desc: u > ti > ta > sh > n > l > c > ad > ac
    eq(ids.slice(0, 5).join(","), "s_username,s_ticket,s_target,s_shop,s_name", "s_* _id desc");
    // tie_* 3 ตัว timestamp เท่ากัน (T0+60s) → หลัง s_*: _id desc = c,b,a
    eq(ids.slice(9, 12).join(","), "tie_c,tie_b,tie_a", "tie_* _id desc tiebreak");
  });

  await t("A4 skip=(page-1)*pageSize ใน $facet.rows", async () => {
    await svc.listAdminLogsExtended({ page: 3, pageSize: 100 });
    const p = lastPipeline();
    const fi = stageIdx(p, "$facet");
    assert(fi >= 0, "ไม่มี $facet");
    const facet = p[fi].$facet as { rows: Pipeline; meta: Pipeline };
    const si = stageIdx(facet.rows, "$skip");
    const li = stageIdx(facet.rows, "$limit");
    assert(si >= 0 && li >= 0, "facet.rows ไม่มี $skip/$limit");
    eq(facet.rows[si].$skip, 200, "skip=(3-1)*100");
    eq(facet.rows[li].$limit, 100, "limit=pageSize");
    const ci = stageIdx(facet.meta, "$count");
    assert(ci >= 0, "facet.meta ไม่มี $count");
  });

  await t("A5 total ≠ rows.length — page1: rows=100 total=252", async () => {
    const r = await svc.listAdminLogsExtended({ page: 1 });
    eq(r.rows.length, 100, "rows");
    eq(r.total, 252, "total ต้องนับทั้งหมดหลัง filter");
  });

  await t("A6 total=0 → totalPages=0 rows=[]", async () => {
    const r = await svc.listAdminLogsExtended({ actionType: "nonexistent.type" });
    eq(r.total, 0, "total");
    eq(r.totalPages, 0, "totalPages=0 เมื่อไม่มีข้อมูล");
    eq(r.rows.length, 0, "rows");
  });

  await t("A7 totalPages edge: total=1→1, total=101→2 (pageSize=100)", async () => {
    mocks.state.colls.admin_logs = [{ _id: "only", admin_id: "a1", action_type: "login", timestamp: new Date() }];
    let r = await svc.listAdminLogsExtended({});
    eq(r.totalPages, 1, "total=1 → 1 page");
    seedDocs();
    mocks.state.colls.admin_logs = mocks.state.colls.admin_logs.slice(0, 101);
    r = await svc.listAdminLogsExtended({});
    eq(r.total, 101, "total=101");
    eq(r.totalPages, 2, "totalPages=2");
    seedDocs();
  });

  await t("A8 page 3 คืน rows 52 ตัวสุดท้าย (ไม่ append หน้าอื่น)", async () => {
    const r = await svc.listAdminLogsExtended({ page: 3 });
    eq(r.rows.length, 52, "page 3 = 252-200");
    const first = r.rows[0] as { _id: string };
    assert(first._id.startsWith("gen_"), "page 3 ต้องเป็น gen_* ตัวท้ายๆ");
  });

  await t("A9 aggregation call เดียวต่อ request (ห้าม countDocuments แยก)", async () => {
    mocks.state.aggregateCalls = [];
    await svc.listAdminLogsExtended({ page: 2 });
    eq(mocks.state.aggregateCalls.length, 1, "ต้อง aggregate ครั้งเดียว");
  });

  // ═══ B. Server-side filters ═══
  await t("B1 adminId filter → $match admin_id", async () => {
    const r = await svc.listAdminLogsExtended({ adminId: "ax_hid" });
    assert(r.rows.every((x: { admin_id: string }) => x.admin_id === "ax_hid"),
      "rows ทั้งหมดต้อง admin_id=ax_hid");
    eq(r.total, 1, "ax_hid เป็นเจ้าของ s_username ตัวเดียว");
  });

  await t("B2 actionType exact filter", async () => {
    const r = await svc.listAdminLogsExtended({ actionType: "workflow.wait_retry" });
    eq(r.total, 1, "wait_retry มีตัวเดียว");
  });

  await t("B3 actionTypes[] → $in filter", async () => {
    const r = await svc.listAdminLogsExtended({ actionTypes: ["login", "logout"] });
    assert(r.total > 0, "login+logout ต้องมี docs");
    assert(r.rows.every((x: { action_type: string }) => ["login", "logout"].includes(x.action_type)),
      "rows ทั้งหมดต้อง action_type∈{login,logout}");
  });

  await t("B4 actionType exact ชนะ actionTypes เมื่อส่งมาพร้อมกัน", async () => {
    const r = await svc.listAdminLogsExtended({ actionType: "logout", actionTypes: ["login"] });
    assert(r.rows.every((x: { action_type: string }) => x.action_type === "logout"),
      "ต้อง filter ด้วย logout ไม่ใช่ login");
    eq(r.total, 1, "logout มีตัวเดียว (s_name)");
  });

  await t("B5 since filter → timestamp $gte", async () => {
    const r = await svc.listAdminLogsExtended({ since: new Date(T0 + 60_000) });
    assert(r.total > 0 && r.total < 252, "since ต้องตัด docs เก่าออก");
    assert(r.rows.every((x: { timestamp: Date }) => new Date(x.timestamp).getTime() >= T0 + 60_000),
      "rows ทั้งหมดต้อง timestamp >= since");
  });

  await t("B6 search q ครอบ 8 fields: action_type", async () => {
    const r = await svc.listAdminLogsExtended({ search: "wait_retry" });
    assert(r.rows.some((x: { _id: string }) => x._id === "s_action"), "ต้องเจอ s_action ผ่าน action_type");
  });
  await t("B7 search q: admin_id", async () => {
    const r = await svc.listAdminLogsExtended({ search: "ax_special" });
    assert(r.rows.some((x: { _id: string }) => x._id === "s_adminid"), "ต้องเจอ s_adminid ผ่าน admin_id");
  });
  await t("B8 search q: joined username", async () => {
    const r = await svc.listAdminLogsExtended({ search: "zzz_name" });
    assert(r.rows.some((x: { _id: string }) => x._id === "s_username"),
      "ต้องเจอ s_username ผ่าน joined username (admin_id=ax_hid ไม่มี zzz_name)");
  });
  await t("B9 search q: joined name", async () => {
    const r = await svc.listAdminLogsExtended({ search: "qqq_full" });
    assert(r.rows.some((x: { _id: string }) => x._id === "s_name"),
      "ต้องเจอ s_name ผ่าน joined name (admin_id=ax_hid2 ไม่มี qqq_full)");
  });
  await t("B10 search q: conversation_id", async () => {
    const r = await svc.listAdminLogsExtended({ search: "conv_special" });
    assert(r.rows.some((x: { _id: string }) => x._id === "s_conv"), "ต้องเจอ s_conv");
  });
  await t("B11 search q: shop_id", async () => {
    const r = await svc.listAdminLogsExtended({ search: "shop_special" });
    assert(r.rows.some((x: { _id: string }) => x._id === "s_shop"), "ต้องเจอ s_shop");
  });
  await t("B12 search q: ticket_id", async () => {
    const r = await svc.listAdminLogsExtended({ search: "tck_777" });
    assert(r.rows.some((x: { _id: string }) => x._id === "s_ticket"), "ต้องเจอ s_ticket");
  });
  await t("B13 search q: target_admin_id", async () => {
    const r = await svc.listAdminLogsExtended({ search: "ax_hid" });
    assert(r.rows.some((x: { _id: string }) => x._id === "s_target"), "ต้องเจอ s_target ผ่าน target_admin_id");
  });

  await t("B14 regex escape: q='conv.special' match เฉพาะ literal", async () => {
    const r = await svc.listAdminLogsExtended({ search: "conv.special" });
    // ถ้าไม่ escape: 'conv.special' จะ match 'conv_special_99' ด้วย regex semantics
    assert(!r.rows.some((x: { _id: string }) => x._id === "s_conv"),
      "unescaped '.' จะ match conv_special ผิด — ต้องไม่เจอ");
    assert(r.rows.some((x: { _id: string }) => x._id === "s_literal"),
      "ต้องเจอ s_literal ที่มี literal 'conv.special_1'");
  });

  await t("B15 search fold เข้า base $match (search เห็น username/name ผ่าน admin resolution)", async () => {
    await svc.listAdminLogsExtended({ search: "zzz" });
    const p = lastPipeline();
    // design ใหม่: search รวมใน base $match ตัวแรกเป็น $or (raw fields + resolved admin_ids)
    const m1 = p[0].$match as Record<string, unknown>;
    assert(m1 && Array.isArray(m1.$or), "base $match ต้องมี $or search");
    // top-level pipeline ห้ามมี $lookup ก่อน $facet (perf regression pin)
    const li = stageIdx(p, "$lookup");
    const fi = stageIdx(p, "$facet");
    assert(!(li >= 0 && li < fi), "top-level $lookup ก่อน $facet = join ทั้ง collection ก่อน paginate");
  });

  await t("B16 search >100 chars → truncate เป็น 100", async () => {
    const q = "x".repeat(150);
    await svc.listAdminLogsExtended({ search: q });
    const p = lastPipeline();
    const src = JSON.stringify(p);
    assert(!src.includes("x".repeat(101)), "search ยาวเกิน 100 chars หลุดเข้า pipeline");
  });

  // ═══ C. Route contract ═══
  seedDocs();

  await t("C1 GET ไม่มี params → page=1 pageSize=100 response contract", async () => {
    const res = await route.GET(req("?")) as { __status: number; body: Record<string, unknown> };
    eq(res.__status, 200, "status");
    const b = res.body;
    eq(b.page, 1, "page=1");
    eq(b.pageSize, 100, "pageSize default=100");
    eq(b.total, 252, "total");
    eq(b.totalPages, 3, "totalPages");
    assert(Array.isArray(b.rows), "rows array");
  });

  await t("C2 page clamp: 0/-5/abc → 1; page=2 → 2", async () => {
    for (const [q, want] of [["page=0", 1], ["page=-5", 1], ["page=abc", 1], ["page=2", 2]] as const) {
      const res = await route.GET(req(`?${q}`)) as { body: { page: number } };
      eq(res.body.page, want, `page '${q}' → ${want}`);
    }
  });

  await t("C3 pageSize: 0→1, 500→100, abc→100, 25→25", async () => {
    for (const [q, want] of [["pageSize=0", 1], ["pageSize=500", 100], ["pageSize=abc", 100], ["pageSize=25", 25]] as const) {
      const res = await route.GET(req(`?${q}`)) as { body: { pageSize: number } };
      eq(res.body.pageSize, want, `pageSize '${q}' → ${want}`);
    }
  });

  await t("C4 admin_id filter ผ่าน route", async () => {
    const res = await route.GET(req("?admin_id=ax_hid")) as { body: { total: number; rows: { admin_id: string }[] } };
    assert(res.body.rows.every((x) => x.admin_id === "ax_hid"), "admin_id filter ไม่ทำงาน");
    assert(res.body.total < 252, "admin_id filter ต้องลด total");
  });

  await t("C5 action_types CSV → array, trim ค่าว่าง + dedupe", async () => {
    const res = await route.GET(req("?action_types=login,logout,,login")) as { body: { total: number } };
    const r2 = await svc.listAdminLogsExtended({ actionTypes: ["login", "logout"] });
    eq(res.body.total, r2.total, "CSV login,logout,,login ต้องเท่ากับ [login,logout]");
  });

  await t("C6 invalid since → ignore (ไม่ส่ง Invalid Date เข้า service)", async () => {
    const res = await route.GET(req("?since=garbage")) as { __status: number; body: { total: number } };
    eq(res.__status, 200, "invalid since ต้องไม่พัง");
    eq(res.body.total, 252, "invalid since ถูก ignore → total เต็ม");
  });

  await t("C7 q param → search, trim + max 100 chars", async () => {
    const res = await route.GET(req(`?q=${"y".repeat(150)}`)) as { __status: number };
    eq(res.__status, 200, "q ยาวต้องไม่พัง");
    const res2 = await route.GET(req("?q=zzz_name")) as { body: { total: number } };
    assert(res2.body.total >= 1, "q=zzz_name ต้องเจอผ่าน joined username");
  });

  await t("C8 auth denied → propagate r.response (auth เดิมไม่เปลี่ยน)", async () => {
    mocks.state.denyAuth = true;
    const res = await route.GET(req("?")) as { __status: number };
    eq(res.__status, 403, "deny → 403 ตาม mock");
    mocks.state.denyAuth = false;
  });

  // ═══ D. Pagination component (render จริงผ่าน react-dom/server) ═══
  const noop = () => {};

  await t("D1 default props → ไม่มี first/last (หน้าอื่นไม่เปลี่ยน)", async () => {
    const html = renderToStaticMarkup(el(Pagination, { page: 2, totalPages: 5, onChange: noop }));
    assert(!html.includes("หน้าแรก"), "default ต้องไม่มีปุ่มหน้าแรก");
    assert(!html.includes("หน้าสุดท้าย"), "default ต้องไม่มีปุ่มหน้าสุดท้าย");
    assert(html.includes("ก่อนหน้า"), "ต้องมี ก่อนหน้า");
    assert(html.includes("ถัดไป"), "ต้องมี ถัดไป");
  });

  await t("D2 showBoundaryButtons → first/prev/numbered/next/last ครบ + Thai aria-labels", async () => {
    const html = renderToStaticMarkup(
      el(Pagination, { page: 2, totalPages: 5, onChange: noop, showBoundaryButtons: true }));
    for (const s of ["หน้าแรก", "ก่อนหน้า", "ถัดไป", "หน้าสุดท้าย"]) {
      assert(html.includes(`aria-label="${s}"`), `ไม่มี aria-label="${s}"`);
    }
  });

  await t("D3 disabled states: page1 first/prev disabled; last page next/last disabled", async () => {
    let html = renderToStaticMarkup(
      el(Pagination, { page: 1, totalPages: 5, onChange: noop, showBoundaryButtons: true }));
    const firstPrev = html.split("หน้าแรก")[0] + html.split('aria-label="ก่อนหน้า"')[0];
    assert(/aria-label="หน้าแรก"[^>]*disabled|disabled[^>]*aria-label="หน้าแรก"/.test(html),
      "หน้าแรก ต้อง disabled ที่ page 1");
    assert(/aria-label="ก่อนหน้า"[^>]*disabled|disabled[^>]*aria-label="ก่อนหน้า"/.test(html),
      "ก่อนหน้า ต้อง disabled ที่ page 1");
    html = renderToStaticMarkup(
      el(Pagination, { page: 5, totalPages: 5, onChange: noop, showBoundaryButtons: true }));
    assert(/aria-label="ถัดไป"[^>]*disabled|disabled[^>]*aria-label="ถัดไป"/.test(html),
      "ถัดไป ต้อง disabled ที่หน้าสุดท้าย");
    assert(/aria-label="หน้าสุดท้าย"[^>]*disabled|disabled[^>]*aria-label="หน้าสุดท้าย"/.test(html),
      "หน้าสุดท้าย ต้อง disabled ที่หน้าสุดท้าย");
    void firstPrev;
  });

  await t("D4 aria-current='page' บนปุ่มเลขหน้าปัจจุบัน", async () => {
    const html = renderToStaticMarkup(
      el(Pagination, { page: 3, totalPages: 5, onChange: noop }));
    assert(html.includes('aria-current="page"'), "ต้องมี aria-current=page");
  });

  await t("D5 responsive → 3 CSS clusters (≤3/≤5/≤maxButtons) ไม่ใช่ JS listener", async () => {
    const html = renderToStaticMarkup(
      el(Pagination, { page: 5, totalPages: 20, onChange: noop, maxButtons: 7, responsive: true, showBoundaryButtons: true }));
    // phone cluster ≤3 numbered, tablet ≤5, desktop ≤7 — CSS-hide ตัวที่ไม่ใช่
    assert(html.includes("md:hidden"), "ต้องมี phone cluster (md:hidden)");
    assert(/lg:hidden/.test(html), "ต้องมี tablet cluster (lg:hidden)");
    assert(/lg:flex|lg:inline|lg:contents/.test(html), "ต้องมี desktop cluster (lg:*)");
  });

  await t("D6 non-responsive → ไม่มี responsive cluster classes (default เดิม)", async () => {
    const html = renderToStaticMarkup(el(Pagination, { page: 5, totalPages: 20, onChange: noop }));
    assert(!html.includes("md:hidden"), "non-responsive ต้องไม่มี cluster classes");
  });

  await t("D7 phone cluster มี numbered ≤3 ปุ่ม, tablet ≤5", async () => {
    const html = renderToStaticMarkup(
      el(Pagination, { page: 10, totalPages: 20, onChange: noop, maxButtons: 7, responsive: true }));
    const countNums = (frag: string) => (frag.match(/aria-label="หน้า \d+/g) || []).length;
    // ตัด fragment ตาม cluster-start markers (ellipsis เป็น <span> ซ้อนอยู่ — regex
    // หา </span> ตัวแรกจะหยุดผิดที่) — phone→tablet→desktop→next button
    const iPhone = html.indexOf("md:hidden");
    const iTablet = html.indexOf("lg:hidden");
    const iDesktop = html.indexOf("lg:flex");
    const iNext = html.indexOf('aria-label="ถัดไป"');
    assert(iPhone >= 0 && iTablet > iPhone && iDesktop > iTablet && iNext > iDesktop,
      "cluster order/พบ marker ไม่ครบ");
    const phone = html.slice(iPhone, iTablet);
    const tablet = html.slice(iTablet, iDesktop);
    const desktop = html.slice(iDesktop, iNext);
    assert(countNums(phone) <= 3, `phone มี ${countNums(phone)} numbered (>3)`);
    assert(countNums(tablet) <= 5, `tablet มี ${countNums(tablet)} numbered (>5)`);
    eq(countNums(desktop), 7, "desktop ต้องมี 7 numbered (maxButtons)");
    assert(countNums(tablet) > countNums(phone), "tablet ควรแสดง numbered มากกว่า phone");
  });

  // ═══ E. page.tsx source pins (UI contract ที่ทดสอบจริงไม่ได้โดยไม่มี browser) ═══
  const pageSrc = readFileSync(
    new URL("../src/app/(console)/logs/page.tsx", import.meta.url), "utf8");

  await t("E1 PAGE_SIZE = 100 constant", async () => {
    assert(/PAGE_SIZE\s*=\s*100/.test(pageSrc), "ต้องมี const PAGE_SIZE = 100");
  });
  await t("E2 poll gate: enabled เฉพาะ page===1", async () => {
    assert(/page === 1/.test(pageSrc) && /usePolling\(/.test(pageSrc),
      "usePolling ต้อง gate ด้วย page === 1");
  });
  await t("E3 ไม่มี client-side filter (logs.filter ถูกลบ)", async () => {
    assert(!/logs\.filter\(/.test(pageSrc), "ยังมี logs.filter — filter ต้องอยู่ server");
    assert(!/filtered\s*=/.test(pageSrc), "ยังมีตัวแปร filtered — ลบ client filter ออก");
  });
  await t("E4 row key = log._id (ห้าม array index)", async () => {
    assert(/log\._id/.test(pageSrc), "ต้องใช้ log._id เป็น identity");
  });
  await t("E5 search debounce ~300ms", async () => {
    assert(/setTimeout\([^)]*300\)|,\s*300\)/.test(pageSrc), "ต้องมี debounce ~300ms");
  });
  await t("E6 stale-response guard (request seq/ref)", async () => {
    assert(/reqSeq|requestSeq|loadSeq|seqRef/.test(pageSrc),
      "ต้องมี sequence guard กัน response เก่าทับใหม่");
  });
  await t("E7 Pagination usage: showBoundaryButtons + responsive + maxButtons", async () => {
    assert(pageSrc.includes("showBoundaryButtons"), "ต้องส่ง showBoundaryButtons");
    assert(/\bresponsive\b/.test(pageSrc), "ต้องส่ง responsive");
    assert(/maxButtons=\{7\}/.test(pageSrc), "ต้องส่ง maxButtons={7}");
    eq((pageSrc.match(/<Pagination/g) || []).length, 1, "Pagination render ชุดเดียว");
  });
  await t("E8 summary text: รายการ X–Y จากทั้งหมด Z + หน้า X จาก Y", async () => {
    assert(pageSrc.includes("จากทั้งหมด"), "ต้องมี summary 'จากทั้งหมด'");
    assert(pageSrc.includes("รายการ"), "ต้องมี 'รายการ'");
  });
  await t("E9 filter change → setPage(1) reset", async () => {
    assert(pageSrc.includes("setPage(1)"), "filter change ต้อง reset page=1");
  });
  await t("E10 เปลี่ยนหน้า → ปิด expanded row", async () => {
    assert(pageSrc.includes("handlePageChange") && /setExpandedId\(null\)/.test(pageSrc),
      "handlePageChange ต้อง setExpandedId(null)");
  });
  await t("E11 silent poll error เก็บ rows (ห้าม setLogs([]) เคลียร์ข้อมูลเดิม)", async () => {
    assert(!/setLogs\(\[\]\)/.test(pageSrc),
      "ยังมี setLogs([]) — error/poll fail ต้องเก็บ rows เดิม");
  });

  // ═══ F. Performance: $lookup ต้องอยู่หลัง pagination (review-fix) ═══
  // pin ปริมาณ docs เข้า $lookup — poll หน้า 1 ทุก 5s บน ~35k logs ห้าม join ทั้งชุด
  const lastLookup = () => {
    const c = mocks.state.lookupCalls;
    assert(c.length > 0, "ไม่มี $lookup call");
    return c[c.length - 1];
  };

  await t("F1 default page 1 — $lookup input ≤ pageSize (≤100)", async () => {
    mocks.state.lookupCalls = [];
    const r = await svc.listAdminLogsExtended({ page: 1, pageSize: 100 });
    eq(r.rows.length, 100, "rows=100");
    eq(r.total, 252, "total ต้องนับทั้งหมด");
    assert(lastLookup().inputCount <= 100,
      `$lookup input=${lastLookup().inputCount} — join ก่อน pagination (ต้อง ≤ pageSize)`);
  });

  await t("F2 page 3 — $lookup input = rows ที่เหลือ (52)", async () => {
    mocks.state.lookupCalls = [];
    const r = await svc.listAdminLogsExtended({ page: 3, pageSize: 100 });
    eq(r.rows.length, 52, "page 3 rows=52");
    eq(r.total, 252, "total=252");
    eq(r.totalPages, 3, "totalPages=3");
    eq(lastLookup().inputCount, 52, "$lookup ต้องรับเฉพาะ rows ของหน้านั้น");
  });

  await t("F3 pipeline ownership: ไม่มี top-level $lookup, facet.rows = skip→limit→lookup→addFields→project", async () => {
    await svc.listAdminLogsExtended({ page: 2 });
    const p = lastPipeline();
    const fi = stageIdx(p, "$facet");
    const si = stageIdx(p, "$sort");
    assert(si >= 0 && fi > si, "$sort ต้องอยู่ก่อน $facet");
    const li = stageIdx(p, "$lookup");
    assert(!(li >= 0 && li < fi), "top-level $lookup ก่อน $facet = join ทั้ง collection");
    const facet = p[fi].$facet as { rows: Pipeline; meta: Pipeline };
    const ops = facet.rows.map((s) => Object.keys(s)[0]);
    const want = ["$skip", "$limit", "$lookup", "$addFields", "$project"];
    assert(ops.every((o, i) => o === want[i]),
      `facet.rows order ผิด: ${ops.join("→")} (ต้อง ${want.join("→")})`);
    assert(stageIdx(facet.meta, "$count") >= 0, "facet.meta ไม่มี $count");
  });

  await t("F4 search username/name parity + admin resolution เฉพาะเมื่อมี search", async () => {
    // no-search → ห้าม query admins เพื่อ resolve search
    mocks.state.findCalls = [];
    await svc.listAdminLogsExtended({ page: 1 });
    eq(mocks.state.findCalls.filter((c: { coll: string }) => c.coll === "admins").length, 0,
      "no-search ห้าม find() admins");
    // search username → ต้อง resolve admin แล้วเจอ log
    mocks.state.findCalls = [];
    mocks.state.lookupCalls = [];
    const r1 = await svc.listAdminLogsExtended({ search: "zzz_name" });
    assert(r1.rows.some((x: { _id: string }) => x._id === "s_username"),
      "search username ต้องเจอ s_username");
    const adminFinds = mocks.state.findCalls.filter((c: { coll: string }) => c.coll === "admins");
    assert(adminFinds.length >= 1 && adminFinds.length <= 1,
      `admin resolution ต้อง 1 query เมื่อมี search (got ${adminFinds.length})`);
    assert(lastLookup().inputCount <= 100,
      "search path ก็ต้อง lookup หลัง pagination");
    // search name
    const r2 = await svc.listAdminLogsExtended({ search: "qqq_full" });
    assert(r2.rows.some((x: { _id: string }) => x._id === "s_name"),
      "search name ต้องเจอ s_name");
  });

  await t("F5 raw-field search parity ครบ 6 fields + literal", async () => {
    for (const [q, wantId] of [
      ["wait_retry", "s_action"],
      ["ax_special", "s_adminid"],
      ["conv_special", "s_conv"],
      ["shop_special", "s_shop"],
      ["tck_777", "s_ticket"],
      ["ax_hid", "s_target"],
    ] as const) {
      const r = await svc.listAdminLogsExtended({ search: q });
      assert(r.rows.some((x: { _id: string }) => x._id === wantId),
        `search '${q}' ต้องเจอ ${wantId}`);
    }
    const r = await svc.listAdminLogsExtended({ search: "conv.special" });
    assert(!r.rows.some((x: { _id: string }) => x._id === "s_conv"),
      "literal regex escape ต้องทำงานเดิม");
    assert(r.rows.some((x: { _id: string }) => x._id === "s_literal"),
      "ต้องเจอ literal 'conv.special_1'");
  });

  await t("F6 compound index {timestamp:-1,_id:-1} declared exactly once ใน mongoClient", async () => {
    const src = readFileSync(
      new URL("../src/backend/db/mongoClient.ts", import.meta.url), "utf8");
    const matches = src.match(/COLLECTIONS\.adminLogs,\s*\{\s*timestamp:\s*-1,\s*_id:\s*-1\s*\}/g) || [];
    eq(matches.length, 1, `index {timestamp:-1,_id:-1} ต้อง declared พอดี 1 ครั้ง (got ${matches.length})`);
    assert(src.includes("COLLECTIONS.adminLogs, { timestamp: 1 }") ||
           /COLLECTIONS\.adminLogs,\s*\{\s*timestamp:\s*1\s*\}/.test(src),
      "index เดิม {timestamp:1} ต้องยังอยู่ (ห้ามลบ)");
  });

  // ── summary ──
  console.log(`\n${"=".repeat(60)}`);
  console.log(`PASS ${pass} / FAIL ${fail}`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("test harness error:", e);
  process.exit(1);
});
