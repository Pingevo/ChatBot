// Shared mocks for test-admin-logs-pagination.ts
// Mock อยู่ที่ module boundary เดิม — production ไม่เปลี่ยน
//
// จำลองจริง:
//   - Mongo aggregation pipeline interpreter ขนาดเล็ก: $match/$lookup/$addFields/
//     $project/$sort/$skip/$limit/$facet/$count — รัน pipeline จริงของ service
//     บน docs ปลอม + เก็บ pipeline ที่ถูกเรียกให้ assert shape ได้
//   - requirePageEdit → ok:true เสมอ (auth boundary ไม่ใช่ scope ของ test นี้)
//   - json() → { __status, body } marker ให้ test อ่าน response body ตรงๆ
//
// ไม่มี Mongo/SSO/network จริง

// ── shared mutable test state ────────────────────────────────
export const state = {
  colls: {},            // name → array of docs
  aggregateCalls: [],   // [{ coll, pipeline }] — captured invocations
  lookupCalls: [],      // [{ from, inputCount }] — docs เข้า $lookup แต่ละ stage (performance pin)
  findCalls: [],        // [{ coll, filter }] — find() calls (admin search resolution pin)
};

export function resetState() {
  state.colls = {};
  state.aggregateCalls = [];
  state.lookupCalls = [];
  state.findCalls = [];
}

export function fakeColl(name) {
  if (!state.colls[name]) state.colls[name] = [];
  return state.colls[name];
}

export const COLLECTIONS = { adminLogs: "admin_logs", admins: "admins" };

// ── mini aggregation interpreter ─────────────────────────────

function getPath(obj, path) {
  const parts = path.split(".");
  const walk = (v, i) => {
    if (v == null || i === parts.length) return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, i));
    return walk(v[parts[i]], i + 1);
  };
  return walk(obj, 0);
}

function evalExpr(doc, expr) {
  if (typeof expr === "string" && expr.startsWith("$")) return getPath(doc, expr.slice(1));
  if (expr && typeof expr === "object" && "$arrayElemAt" in expr) {
    const [arr, idx] = expr.$arrayElemAt;
    const a = evalExpr(doc, arr);
    return Array.isArray(a) ? a[idx] : undefined;
  }
  return expr;
}

function matchVal(v, cond) {
  if (cond instanceof RegExp) return cond.test(v);
  if (cond && typeof cond === "object" && !(cond instanceof Date)) {
    if ("$regex" in cond) {
      const rx = cond.$regex instanceof RegExp ? cond.$regex : new RegExp(cond.$regex, cond.$options || "");
      return rx.test(v);
    }
    if ("$in" in cond) return cond.$in.includes(v);
    if ("$gte" in cond) return v >= cond.$gte;
    if ("$ne" in cond) return v !== cond.$ne;
    if ("$exists" in cond) return cond.$exists ? v !== undefined : v === undefined;
  }
  return v === cond;
}

function matchDoc(doc, filter) {
  return Object.entries(filter).every(([k, cond]) => {
    if (k === "$or") return cond.some((f) => matchDoc(doc, f));
    if (k === "$and") return cond.every((f) => matchDoc(doc, f));
    return matchVal(getPath(doc, k), cond);
  });
}

function runPipeline(docs, pipeline) {
  let out = docs.map((d) => structuredClone(d));
  for (const stage of pipeline) {
    const [op, spec] = Object.entries(stage)[0];
    if (op === "$match") out = out.filter((d) => matchDoc(d, spec));
    else if (op === "$sort") {
      const keys = Object.entries(spec);
      out = [...out].sort((a, b) => {
        for (const [k, dir] of keys) {
          const av = getPath(a, k), bv = getPath(b, k);
          if (av < bv) return dir * -1;
          if (av > bv) return dir * 1;
        }
        return 0;
      });
    }
    else if (op === "$skip") out = out.slice(spec);
    else if (op === "$limit") out = out.slice(0, spec);
    else if (op === "$lookup") {
      state.lookupCalls.push({ from: spec.from, inputCount: out.length });
      const foreign = state.colls[spec.from] || [];
      out = out.map((d) => ({
        ...d,
        [spec.as]: foreign.filter((f) => f[spec.foreignField] === d[spec.localField]),
      }));
    }
    else if (op === "$addFields") {
      out = out.map((d) => ({
        ...d,
        ...Object.fromEntries(Object.entries(spec).map(([k, e]) => [k, evalExpr(d, e)])),
      }));
    }
    else if (op === "$project") {
      const excluded = Object.entries(spec).filter(([, v]) => v === 0).map(([k]) => k);
      const included = Object.entries(spec).filter(([, v]) => v === 1).map(([k]) => k);
      out = out.map((d) => {
        if (included.length) {
          const nd = {};
          for (const k of included) nd[k] = d[k];
          if (spec._id !== 0) nd._id = d._id;
          return nd;
        }
        const nd = { ...d };
        for (const k of excluded) delete nd[k];
        return nd;
      });
    }
    else if (op === "$facet") {
      const res = {};
      for (const [k, sub] of Object.entries(spec)) res[k] = runPipeline(out, sub);
      out = [res];
    }
    else if (op === "$count") out = out.length ? [{ [spec]: out.length }] : [];
    else throw new Error(`fake mongo: unsupported stage ${op}`);
  }
  return out;
}

// ── mongoClient mock ─────────────────────────────────────────
export async function getCollection(name) {
  const collName = name;
  return {
    name: collName,
    aggregate(pipeline) {
      state.aggregateCalls.push({ coll: collName, pipeline: structuredClone(pipeline) });
      const result = runPipeline(state.colls[collName] || [], pipeline);
      return { toArray: async () => result };
    },
    find(filter = {}, options = {}) {
      state.findCalls.push({ coll: collName, filter: structuredClone(filter) });
      let docs = (state.colls[collName] || []).filter((d) => matchDoc(d, filter));
      const proj = options.projection || {};
      const included = Object.entries(proj).filter(([, v]) => v === 1).map(([k]) => k);
      if (included.length) {
        docs = docs.map((d) => {
          const nd = {};
          for (const k of included) nd[k] = d[k];
          if (proj._id !== 0) nd._id = d._id;
          return nd;
        });
      }
      return { toArray: async () => docs };
    },
    countDocuments() {
      throw new Error("fake mongo: countDocuments() must not be called — total ต้องมาจาก $facet เดียวกัน");
    },
  };
}

// ── authorize mock ───────────────────────────────────────────
export async function requirePageEdit() {
  if (state.denyAuth) {
    return { ok: false, response: { __status: 403, body: { detail: "forbidden" } } };
  }
  return {
    ok: true,
    ctx: {
      admin: { admin_id: "test_dev", role: "dev", active: true },
      safeAdmin: { admin_id: "test_dev", role: "dev" },
      ip: "127.0.0.1",
    },
  };
}

// ── http mock ────────────────────────────────────────────────
export function json(body, status = 200) {
  return { __status: status, body };
}
export function error(detail, status = 400) {
  return { __status: status, body: { detail } };
}
export const unauthorized = (d = "unauthorized") => error(d, 401);
export const forbidden = (d = "forbidden") => error(d, 403);
