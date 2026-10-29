// test-workflow-binding-routes.ts — RED tests: GET/POST /api/workflows/[workflowId]/bindings
//
// รัน: npx tsx scripts/test-workflow-binding-routes.ts
//
// ทุก test บน module-boundary mocks (test-workflow-binding-routes-hooks.mjs):
//   authorize + workflowService + mongoClient → test-workflow-binding-routes-mocks.mjs
//   mongoClient boundary throw ทุก entry = zero-Mongo proof (route แตะ Mongo ตรง → fail)
//   service stub จับ call args → delegation proof (route = thin layer เท่านั้น)
//
// Contract ที่ assert:
//   GET  requireAuth → getBindingResolutionView → json(view) · null → 404
//   POST requirePageEdit("workflow") → readJson → saveBindingResolutionBatch →
//        status map (not_found→404 · conflict→409 · validation→422 · throw→500)
//        body+actor pass verbatim · auth fail → middleware response เดิม + svcCalls ว่าง
//   ทั้งสอง handler: zero Mongo import/call ใน route source

import { register } from "node:module";
register(new URL("./test-workflow-binding-routes-hooks.mjs", import.meta.url));

type Mocks = typeof import("./test-workflow-binding-routes-mocks.mjs");
type RouteModule = {
  GET?: (req: any, ctx: { params: Promise<{ workflowId: string }> }) => Promise<Response>;
  POST?: (req: any, ctx: { params: Promise<{ workflowId: string }> }) => Promise<Response>;
};
type LooseState = {
  auth: { ok: boolean; ctx?: { admin: { admin_id: string } } & Record<string, unknown>; response?: Response };
  svcResult: unknown; svcThrow: unknown;
  authCalls: { method: string; args: unknown[] }[];
  svcCalls: { method: string; args: unknown[] }[];
};

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}
function eq<T>(a: T, b: T, name: string) { ok(a === b, `${name} (${JSON.stringify(a)} === ${JSON.stringify(b)})`); }

// view fixture — shape ตาม plan §5 BindingResolutionView
const VIEW = {
  workflow_id: "wf_v1",
  version_id: "wfv_cur",
  expected_version: 3,
  bindings: [
    { binding_id: "bind_a", node_id: "t1", field_path: "data.accountIds", kind: "account",
      count: 2, status: "unresolved",
      sources: [{ source_index: 0, display_value: "zacc_1" }, { source_index: 1, display_value: "zacc_2" }] },
  ],
  candidates: {
    accounts: [{ platform: "shopee", shop_id: "shop_s1", shopname: "S1" }],
    labels: ["vip"],
    users: [{ admin_id: "adm_u1", display: "adm_u1" }],
    teams: [], ticket_fields: [], urls: [],
  },
  unresolved: 1,
  invalid: 0,
  publish_blockers: [],
  overlap_conflicts: [],
};

const RES_OK = {
  ok: true, version: 4, version_id: "wfv_next", resolved: 1, unresolved: 0, invalid: 0,
  repeated: 0, publish_blockers: [], overlap_conflicts: [],
};

const POST_BODY = {
  workflow_id: "wf_v1",
  expected_version: 3,
  version_id: "wfv_cur",
  proposed: [
    { binding_id: "bind_a", mappings: [
      { source_index: 0, local_id: "shop_s1", platform: "shopee", shop_id: "shop_s1" },
      { source_index: 1, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" } ] },
  ],
};

async function main() {
  const mocks: Mocks = await import("./test-workflow-binding-routes-mocks.mjs");
  const state = mocks.state as unknown as LooseState;
  const { NextRequest, NextResponse } = await import("next/server");
  const { readFileSync } = await import("node:fs");
  const act = async (fn: () => unknown) => { try { await fn(); return null; } catch (e) { return (e as Error).message; } };

  // route module — อาจยังไม่มี (RED) → ทุก case fail ด้วยเหตุเดียวกัน "route module absent"
  let GET: RouteModule["GET"], POST: RouteModule["POST"];
  let routeImportErr: Error | null = null;
  try {
    const route: RouteModule = await import("../src/app/api/workflows/[workflowId]/bindings/route");
    GET = route.GET; POST = route.POST;
  } catch (e) { routeImportErr = e as Error; }

  // export route — module เดียวกัน pattern (thin read delegate)
  let XGET: RouteModule["GET"];
  let exportImportErr: Error | null = null;
  try {
    const xroute: RouteModule = await import("../src/app/api/workflows/[workflowId]/export/route");
    XGET = xroute.GET;
  } catch (e) { exportImportErr = e as Error; }

  const reset = () => {
    state.auth = { ok: true, ctx: { admin: { admin_id: "adm_actor" }, safeAdmin: {}, ip: "127.0.0.1" } };
    state.svcResult = undefined;
    state.svcThrow = undefined;
    state.authCalls = [];
    state.svcCalls = [];
  };
  const mkGet = () => new NextRequest("http://localhost/api/workflows/wf_v1/bindings");
  const mkPost = (body: unknown) => new NextRequest("http://localhost/api/workflows/wf_v1/bindings", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const mkPostRaw = (raw: string) => new NextRequest("http://localhost/api/workflows/wf_v1/bindings", {
    method: "POST", headers: { "content-type": "application/json" }, body: raw,
  });
  const ctx = (id = "wf_v1") => ({ params: Promise.resolve({ workflowId: id }) });
  const callGet = async (id = "wf_v1") => {
    if (!GET) return { __missing: true } as Record<string, unknown>;
    const res = await GET(mkGet(), ctx(id));
    return { status: res.status, body: await res.json(), res } as Record<string, unknown>;
  };
  const callPost = async (req: any, id = "wf_v1") => {
    if (!POST) return { __missing: true } as Record<string, unknown>;
    const res = await POST(req, ctx(id));
    return { status: res.status, body: await res.json(), res } as Record<string, unknown>;
  };

  // ═══ 1. GET /bindings — view delegation + 404 ═══
  {
    reset(); state.svcResult = VIEW;
    const r = await callGet();
    eq(r.status, 200, "GET → 200 when view exists");
    eq(JSON.stringify(r.body), JSON.stringify(VIEW), "GET → json(view) verbatim");
    const c = state.svcCalls[0];
    eq(c?.method, "getBindingResolutionView", "GET → delegates getBindingResolutionView");
    eq(c?.args?.[0], "wf_v1", "GET → workflowId จาก dynamic params");
    eq(state.svcCalls.length, 1, "GET → service call เดียว");

    reset(); state.svcResult = null;
    const r404 = await callGet();
    eq(r404.status, 404, "GET → 404 when view absent");
    eq((r404.body as { detail?: string })?.detail, "workflow not found", "GET 404 → {detail}");

    // params เป็นต้นทางของ workflowId (ไม่ใช่ URL string)
    reset(); state.svcResult = VIEW;
    await callGet("wf_other");
    eq(state.svcCalls[0]?.args?.[0], "wf_other", "GET → workflowId มาจาก awaited params");

    // auth fail → middleware response เดิม + service ไม่ถูกเรียก
    reset();
    const denied = NextResponse.json({ detail: "unauthorized" }, { status: 401 });
    state.auth = { ok: false, response: denied } as never;
    const r401 = await callGet();
    eq(r401.status, 401, "GET auth fail → 401 preserved");
    ok(r401.res === denied, "GET auth fail → middleware response verbatim");
    eq(state.svcCalls.length, 0, "GET auth fail → service stub never called");
  }

  // ═══ 2. POST /bindings — batch delegation + status map ═══
  {
    reset(); state.svcResult = RES_OK;
    const r = await callPost(mkPost(POST_BODY));
    eq(r.status, 200, "POST → 200 on ok result");
    eq(JSON.stringify(r.body), JSON.stringify(RES_OK), "POST → json(result) verbatim");
    const c = state.svcCalls[0];
    eq(c?.method, "saveBindingResolutionBatch", "POST → delegates saveBindingResolutionBatch");
    eq(c?.args?.[0], "wf_v1", "POST → workflowId จาก params");
    eq(JSON.stringify(c?.args?.[1]), JSON.stringify(POST_BODY), "POST → body pass verbatim (no route-side filtering)");
    eq(c?.args?.[2], "adm_actor", "POST → actor = r.ctx.admin.admin_id");
    eq(state.authCalls[0]?.method, "requirePageEdit", "POST → requirePageEdit");
    eq(state.authCalls[0]?.args?.[1], "workflow", "POST → page scope \"workflow\"");

    reset(); state.svcResult = { ok: false, not_found: true };
    eq((await callPost(mkPost(POST_BODY))).status, 404, "POST not_found → 404");

    reset(); state.svcResult = { ok: false, conflict: true, current_version: 7, current_version_id: "wfv_7" };
    const r409 = await callPost(mkPost(POST_BODY));
    eq(r409.status, 409, "POST conflict → 409");
    eq((r409.body as { current_version?: number })?.current_version, 7, "POST 409 → current_version echoed");

    // forbidden client identity/display keys — service validation → 422 (route ไม่ filter เอง)
    reset(); state.svcResult = { ok: false, validation: "proposed[0]: forbidden key 'source_value'" };
    const bodyForbidden = { ...POST_BODY, proposed: [
      { binding_id: "bind_a", source_value: "hack", display_value: "x", sources: [{ evil: 1 }] } ] };
    const r422 = await callPost(mkPost(bodyForbidden));
    eq(r422.status, 422, "POST validation (forbidden keys) → 422");
    ok(typeof (r422.body as { detail?: string })?.detail === "string", "POST 422 → {detail: validation}");
    eq(JSON.stringify(state.svcCalls[0]?.args?.[1]), JSON.stringify(bodyForbidden),
      "POST forbidden body → reached service verbatim (route does not pre-filter)");

    reset(); state.svcThrow = new Error("boom-cast"); 
    eq((await callPost(mkPost(POST_BODY))).status, 500, "POST service throw → 500");

    reset();
    const rBad = await callPost(mkPostRaw("{not-json"));
    ok(rBad.status === 400 || rBad.status === 422, `POST unparseable body → 4xx (route convention) (${rBad.status})`);
    eq(state.svcCalls.length, 0, "POST unparseable → service never called");

    // auth fail → middleware response เดิม + service ไม่ถูกเรียก (ตัดก่อน readJson/service)
    reset();
    const denied = NextResponse.json({ detail: "forbidden" }, { status: 403 });
    state.auth = { ok: false, response: denied } as never;
    const r403 = await callPost(mkPost(POST_BODY));
    eq(r403.status, 403, "POST auth fail → 403 preserved");
    ok(r403.res === denied, "POST auth fail → middleware response verbatim");
    eq(state.svcCalls.length, 0, "POST auth fail → service stub never called");
  }

  // ═══ 2.5 GET /export — canonical export delegation + 404 ═══
  {
    const PKG = { schema: "canonical-workflow/1", fingerprint: "fp_x", workflow: { name: "wf" } };
    const callExport = async (id = "wf_v1") => {
      if (!XGET) return { __missing: true } as Record<string, unknown>;
      const res = await XGET(new NextRequest(`http://localhost/api/workflows/${id}/export`), ctx(id));
      return { status: res.status, body: await res.json(), res } as Record<string, unknown>;
    };

    reset(); state.svcResult = PKG;
    const r = await callExport();
    eq(r.status, 200, "GET /export → 200 when package exists");
    eq(JSON.stringify(r.body), JSON.stringify(PKG), "GET /export → json(pkg) verbatim");
    const c = state.svcCalls[0];
    eq(c?.method, "getWorkflowCanonicalExport", "GET /export → delegates getWorkflowCanonicalExport");
    eq(c?.args?.[0], "wf_v1", "GET /export → workflowId จาก params");
    eq(state.svcCalls.length, 1, "GET /export → service call เดียว");

    reset(); state.svcResult = null;
    const r404 = await callExport();
    eq(r404.status, 404, "GET /export → 404 when workflow absent");

    reset();
    const denied = NextResponse.json({ detail: "forbidden" }, { status: 403 });
    state.auth = { ok: false, response: denied } as never;
    const r403 = await callExport();
    eq(r403.status, 403, "GET /export auth fail → 403 preserved");
    ok(r403.res === denied, "GET /export auth fail → middleware response verbatim");
    eq(state.svcCalls.length, 0, "GET /export auth fail → service stub never called");
    ok(exportImportErr == null, `export route module imports cleanly (${exportImportErr?.message ?? "ok"})`);

    let xsrc = "";
    try {
      xsrc = readFileSync(new URL("../src/app/api/workflows/[workflowId]/export/route.ts", import.meta.url), "utf8");
    } catch { /* absent — RED */ }
    ok(xsrc.length > 0, "export route source readable");
    ok(!/mongoClient|getCollection|getDb|ensureIndexes|\.findOne|\.find\(|\.distinct|\.insertOne|\.updateOne|\.aggregate|\.countDocuments/.test(xsrc),
      "export route source → zero Mongo imports/calls");
  }

  // ═══ 3. zero-Mongo pins — boundary throw + route source scan ═══
  {
    const err = await act(() => (mocks as unknown as { getCollection: (n: string) => Promise<unknown> }).getCollection("anything"));
    ok(err != null && err.includes("must not touch Mongo"), "mongoClient boundary → getCollection throws (seam live)");

    let src = "";
    try {
      src = readFileSync(new URL("../src/app/api/workflows/[workflowId]/bindings/route.ts", import.meta.url), "utf8");
    } catch { /* absent — RED */ }
    ok(src.length > 0, "route source readable");
    ok(!/mongoClient|getCollection|getDb|ensureIndexes|\.findOne|\.find\(|\.distinct|\.insertOne|\.updateOne|\.aggregate|\.countDocuments/.test(src),
      "route source → zero Mongo imports/calls");
    ok(routeImportErr == null, `route module imports cleanly (${routeImportErr?.message ?? "ok"})`);
  }
}

main().then(() => {
  console.log(`\n=== Summary: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}).catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
