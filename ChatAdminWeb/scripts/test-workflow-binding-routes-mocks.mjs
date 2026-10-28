// test-workflow-binding-routes-mocks.mjs — module-boundary mocks สำหรับ bindings-route tests
// ไม่มี Mongo/network/env จริง — state.* เป็น observable ตัวเดียว
//   state.auth      — result ที่ requireAuth/requirePageEdit คืน ({ok:true,ctx} | {ok:false,response})
//   state.svcResult — result ที่ service stub คืน
//   state.svcThrow  — ถ้า set: service stub throw (ทดสอบ 500 map)
//   state.authCalls / state.svcCalls — delegation evidence (method + args verbatim)

export const state = {
  auth: { ok: true, ctx: { admin: { admin_id: "adm_actor" }, safeAdmin: {}, ip: "127.0.0.1" } },
  svcResult: undefined,
  svcThrow: undefined,
  authCalls: [],
  svcCalls: [],
};

export async function requireAuth(req) {
  state.authCalls.push({ method: "requireAuth", args: [req] });
  return state.auth;
}

export async function requirePageEdit(req, page) {
  state.authCalls.push({ method: "requirePageEdit", args: [req, page] });
  return state.auth;
}

export const workflowService = {
  async getBindingResolutionView(...args) {
    state.svcCalls.push({ method: "getBindingResolutionView", args });
    if (state.svcThrow) throw state.svcThrow;
    return state.svcResult;
  },
  async saveBindingResolutionBatch(...args) {
    state.svcCalls.push({ method: "saveBindingResolutionBatch", args });
    if (state.svcThrow) throw state.svcThrow;
    return state.svcResult;
  },
};

// mongoClient boundary — ทุก entry throw: route เรียก Mongo ตรง = test fail
export const COLLECTIONS = {};
export async function getCollection() {
  throw new Error("route suite: getCollection called — route must not touch Mongo");
}
export async function getDb() {
  throw new Error("route suite: getDb called — route must not touch Mongo");
}
export async function ensureIndexes() {
  throw new Error("route suite: ensureIndexes called — route must not touch Mongo");
}
