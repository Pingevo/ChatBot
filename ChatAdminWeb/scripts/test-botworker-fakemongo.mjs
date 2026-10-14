// test-botworker-fakemongo.mjs — shared Fake Mongo surface สำหรับ botworker test harnesses
// ✅ ห้าม redirect service ใดๆ ผ่านไฟล์นี้ — นี่คือ in-memory Mongo เท่านั้น
// Semantics ที่ต้องตรง Mongo จริง:
//   - findOneAndUpdate default คืน BEFORE; returnDocument:"after" เท่านั้นที่คืน post-update
//   - find/findOne/toArray คืน structuredClone (driver จริงคืน deserialized copy)
//   - filter null → match field ที่ missing หรือ null (Mongo semantics)
//   - _id uniqueness → E11000; upsert seed equality fields จาก filter
//   - $push/$addToSet($each), $nin, $size, $type:"date", multi-key sort, limit/skip/project

export const COLLECTIONS = {
  conversations: "conversations",
  messages: "messages",
  bufferMessages: "buffer_messages",
  chatProcessing: "chat_processing",
  shadowReplies: "shadow_replies",
  botworkerEvents: "botworker_events",
  botsSettings: "bots_settings",
  workflows: "workflows",
  workflowRuns: "workflow_runs",
  workflowMessages: "workflow_messages",
  workflowReplies: "workflow_replies",
  admins: "admins",
  shopTeamAssignments: "shop_team_assignments",
  platformTeamAssignments: "platform_team_assignments",
  assignmentCursors: "assignment_cursors",
  assignmentConfigs: "assignment_configs",
  assignmentAudits: "assignment_audits",
  adminLogs: "admin_logs",
  triggers: "triggers",
  testStatusConversation: "test_status_conversation",
  botworkerMessages: "botworker_messages",
  systemConfigs: "system_configs",
  statusConversations: "status_conversations",
  customers: "customers",
  closeHistory: "close_history",
};

const OID_CHARS = "0123456789abcdef";

/**
 * @param {object} state — caller-owned mutable state; fields consulted lazily:
 *   findHook/findOneHook/updateOneHook/findOneAndUpdateHook?: (coll, filter, update?) => any — race seams
 *   uniqueKeys?: Record<string,string[]>,
 *   onInsert?: (name, doc) => void — side counter hooks
 *   onQuery?: (coll, op, filter) => void — query counter (find/findOne/count/insert/update/delete/distinct)
 *   queryDelayMs?: number — artificial read latency (find/toArray/findOne) สำหรับ perf tests
 */
export function createFakeMongo(state = {}) {
  const store = new Map();
  let oidCounter = 0;
  const hook = (k) => state[k];

  function fakeColl(name) {
    if (!store.has(name)) store.set(name, []);
    return store.get(name);
  }

  function genOid() {
    oidCounter++;
    return oidCounter.toString(16).padStart(24, "0").split("").map((c, i) => OID_CHARS[(parseInt(c, 16) + i) % 16]).join("");
  }

  function enforceUnique(name, doc, excludeDoc) {
    // _id unique เสมอ — Mongo จริง enforce เอง
    if (doc._id != null && fakeColl(name).some((d) => d !== excludeDoc && d._id === doc._id)) {
      const err = new Error(`E11000 duplicate key error collection: ${name} index: _id_ dup key: { _id: "${doc._id}" }`);
      err.code = 11000;
      throw err;
    }
    const keys = state.uniqueKeys?.[name] || [];
    for (const key of keys) {
      const v = doc[key];
      if (v === undefined || v === null) continue;
      const clash = fakeColl(name).find((d) => d !== excludeDoc && val(d, key) === v);
      if (clash) {
        const err = new Error(`E11000 duplicate key error collection: ${name} index: ${key}_1 dup key: { ${key}: "${v}" }`);
        err.code = 11000;
        throw err;
      }
    }
  }

  function val(doc, key) {
    const parts = key.split(".");
    let v = doc;
    for (const p of parts) {
      if (v == null) return undefined;
      v = v[p];
    }
    return v;
  }

  function matchCond(v, cond) {
    if (cond instanceof RegExp) return typeof v === "string" && cond.test(v);
    // Mongo: ค่า null ใน filter match ทั้ง missing field และ null
    if (cond === null) return v == null;
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
      for (const [op, operand] of Object.entries(cond)) {
        if (op === "$ne") { if (v === operand || (operand == null && v == null)) return false; continue; }
        if (op === "$gte") { if (!(v >= operand)) return false; continue; }
        if (op === "$gt") { if (!(v > operand)) return false; continue; }
        if (op === "$lte") { if (!(v <= operand)) return false; continue; }
        if (op === "$lt") { if (!(v < operand)) return false; continue; }
        if (op === "$exists") { if ((v !== undefined) !== operand) return false; continue; }
        if (op === "$regex") { if (!(typeof v === "string" && new RegExp(operand, cond.$options || "").test(v))) return false; continue; }
        if (op === "$options") continue;
        if (op === "$in") { if (!Array.isArray(operand) || !operand.includes(v)) return false; continue; }
        if (op === "$nin") { if (Array.isArray(operand) && operand.includes(v)) return false; continue; }
        if (op === "$size") { if (!Array.isArray(v) || v.length !== operand) return false; continue; }
        if (op === "$type") { if (operand === "date" ? !(v instanceof Date) : typeof v !== operand) return false; continue; }
        return false;
      }
      return true;
    }
    if (Array.isArray(v)) return v.includes(cond);
    return v === cond;
  }

  function matches(doc, filter) {
    for (const [k, cond] of Object.entries(filter)) {
      if (k === "$and") { if (!cond.every((c) => matches(doc, c))) return false; continue; }
      if (k === "$or") { if (!cond.some((c) => matches(doc, c))) return false; continue; }
      if (!matchCond(val(doc, k), cond)) return false;
    }
    return true;
  }

  function setPath(doc, key, v) {
    const parts = key.split(".");
    let t = doc;
    for (let i = 0; i < parts.length - 1; i++) { t = t[parts[i]] ??= {}; }
    t[parts[parts.length - 1]] = v;
  }
  function unsetPath(doc, key) {
    const parts = key.split(".");
    let t = doc;
    for (let i = 0; i < parts.length - 1; i++) { t = t?.[parts[i]]; }
    if (t) delete t[parts[parts.length - 1]];
  }

  function applyUpdate(doc, update, isInsert) {
    for (const [op, fields] of Object.entries(update)) {
      if (op === "$set") for (const [k, v] of Object.entries(fields)) setPath(doc, k, v);
      else if (op === "$setOnInsert") { if (isInsert) for (const [k, v] of Object.entries(fields)) setPath(doc, k, v); }
      else if (op === "$unset") for (const k of Object.keys(fields)) unsetPath(doc, k);
      else if (op === "$inc") for (const [k, v] of Object.entries(fields)) setPath(doc, k, (val(doc, k) ?? 0) + v);
      else if (op === "$push") for (const [k, v] of Object.entries(fields)) {
        const arr = val(doc, k) ?? [];
        if (!Array.isArray(arr)) continue;
        if (v && typeof v === "object" && Array.isArray(v.$each)) arr.push(...v.$each); else arr.push(v);
        setPath(doc, k, arr);
      }
      else if (op === "$addToSet") for (const [k, v] of Object.entries(fields)) {
        const arr = val(doc, k) ?? [];
        if (!Array.isArray(arr)) continue;
        const items = v && typeof v === "object" && Array.isArray(v.$each) ? v.$each : [v];
        for (const it of items) if (!arr.includes(it)) arr.push(it);
        setPath(doc, k, arr);
      }
      else throw new Error("fake mongo: unsupported update op " + op);
    }
  }

  function applyProject(docs, spec) {
    const entries = Object.entries(spec || {});
    if (!entries.length) return docs;
    const include = entries.some(([, v]) => v);
    return docs.map((d) => {
      if (!include) { const c = structuredClone(d); for (const [k] of entries) unsetPath(c, k); return c; }
      const out = { _id: d._id };
      for (const [k, v] of entries) if (v && val(d, k) !== undefined) setPath(out, k, val(d, k));
      return out;
    });
  }

  class FakeCollection {
    constructor(name) { this.name = name; }
    get docs() { return fakeColl(this.name); }

    async findOne(filter = {}) {
      const h = hook("findOneHook");
      if (h) await h(this.name, filter);
      state.onQuery?.(this.name, "findOne", filter);
      if (state.queryDelayMs) await new Promise((r) => setTimeout(r, state.queryDelayMs));
      const d = this.docs.find((d) => matches(d, filter));
      return d ? structuredClone(d) : null;
    }
    find(filter = {}, opts = {}) {
      const self = this;
      let sorted = null, skipped = 0, limited = null, proj = opts.projection || null;
      const cursor = {
        sort(spec) { sorted = Object.entries(spec || {}); return cursor; },
        skip(n) { skipped = n; return cursor; },
        limit(n) { limited = n; return cursor; },
        project(spec) { proj = spec; return cursor; },
        async toArray() {
          state.onQuery?.(self.name, "find", filter);
          const h = hook("findHook");
          if (h) await h(self.name, filter);
          if (state.queryDelayMs) await new Promise((r) => setTimeout(r, state.queryDelayMs));
          let docs = self.docs.filter((d) => matches(d, filter));
          if (sorted) {
            docs = [...docs].sort((a, b) => {
              for (const [k, dir] of sorted) {
                const av = val(a, k) ?? 0, bv = val(b, k) ?? 0;
                if (av < bv) return dir === -1 ? 1 : -1;
                if (av > bv) return dir === -1 ? -1 : 1;
              }
              return 0;
            });
          }
          if (skipped) docs = docs.slice(skipped);
          if (limited != null) docs = docs.slice(0, limited);
          if (proj) docs = applyProject(docs, proj);
          return docs.map((d) => structuredClone(d));
        },
      };
      return cursor;
    }
    async insertOne(doc) {
      state.onQuery?.(this.name, "insertOne", doc);
      enforceUnique(this.name, doc);
      if (doc._id === undefined) doc._id = genOid();
      this.docs.push(doc);
      if (state.onInsert) state.onInsert(this.name, doc);
      return { acknowledged: true, insertedId: doc._id };
    }
    async insertMany(docs) {
      const ids = [];
      for (const d of docs) ids.push((await this.insertOne(d)).insertedId);
      return { acknowledged: true, insertedIds: ids, insertedCount: ids.length };
    }
    async updateOne(filter, update, opts = {}) {
      const h = hook("updateOneHook");
      if (h) await h(this.name, filter, update);
      state.onQuery?.(this.name, "updateOne", filter);
      const d = this.docs.find((d) => matches(d, filter));
      if (d) {
        applyUpdate(d, update, false);
        enforceUnique(this.name, d, d);
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
      }
      if (opts.upsert) {
        const doc = {};
        for (const [k, v] of Object.entries(filter)) {
          if (k.startsWith("$")) continue;
          if (v !== null && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v)) continue;
          setPath(doc, k, v);
        }
        applyUpdate(doc, update, true);
        await this.insertOne(doc);
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: doc._id };
      }
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    }
    async updateMany(filter, update, opts = {}) {
      const h = hook("updateManyHook");
      if (h && (await h(this.name, filter, update)) === "skip") {
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0 }; // veto — simulate CAS miss
      }
      let n = 0;
      for (const d of this.docs.filter((d) => matches(d, filter))) { applyUpdate(d, update, false); n++; }
      if (n === 0 && opts.upsert) return this.updateOne(filter, update, opts);
      return { acknowledged: true, matchedCount: n, modifiedCount: n };
    }
    // Mongo จริง: default คืน doc ก่อน update; returnDocument:"after" เท่านั้นที่คืนหลัง update
    async findOneAndUpdate(filter, update, opts = {}) {
      const h = hook("findOneAndUpdateHook");
      if (h) await h(this.name, filter);
      state.onQuery?.(this.name, "findOneAndUpdate", filter);
      const d = this.docs.find((d) => matches(d, filter));
      if (!d) {
        if (opts.upsert) {
          const doc = {};
          for (const [k, v] of Object.entries(filter)) {
            if (k.startsWith("$")) continue;
            if (v !== null && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v)) continue;
            setPath(doc, k, v);
          }
          applyUpdate(doc, update, true);
          await this.insertOne(doc);
          return opts.returnDocument === "after" ? structuredClone(doc) : null;
        }
        return null;
      }
      const before = structuredClone(d);
      applyUpdate(d, update, false);
      enforceUnique(this.name, d, d);
      return opts.returnDocument === "after" ? structuredClone(d) : before;
    }
    async deleteMany(filter = {}) {
      const docs = this.docs;
      const before = docs.length;
      for (let i = docs.length - 1; i >= 0; i--) if (matches(docs[i], filter)) docs.splice(i, 1);
      return { acknowledged: true, deletedCount: before - docs.length };
    }
    async deleteOne(filter = {}) {
      const h = hook("deleteOneHook");
      if (h) await h(this.name, filter);
      const i = this.docs.findIndex((d) => matches(d, filter));
      if (i < 0) return { acknowledged: true, deletedCount: 0 };
      this.docs.splice(i, 1);
      return { acknowledged: true, deletedCount: 1 };
    }
    async distinct(field, filter = {}) {
      return [...new Set(this.docs.filter((d) => matches(d, filter)).map((d) => val(d, field)).filter((v) => v !== undefined))];
    }
    async countDocuments(filter = {}) {
      state.onQuery?.(this.name, "countDocuments", filter);
      if (state.queryDelayMs) await new Promise((r) => setTimeout(r, state.queryDelayMs));
      return this.docs.filter((d) => matches(d, filter)).length;
    }
    async estimatedDocumentCount() { return this.docs.length; }
    async indexes() { return []; }
    aggregate() { throw new Error(`fake mongo: aggregate not supported (${this.name})`); }
  }

  async function getCollection(name) { return new FakeCollection(name); }

  return { fakeColl, store, FakeCollection, getCollection, COLLECTIONS };
}

// ── shared leaf mocks (botCallService + systemConfigService) ──
// ใช้ร่วมกันทั้งสอง harness — state contract เดียวกัน:
//   state.calls.callBot/botInFlight · callBotHang/callBotDelayMs/callBotError · state.config
export function makeCallBotMock(state) {
  /** @param {{ signal?: AbortSignal }} [params] */
  return async function callBot(params = {}) {
    state.calls.callBot++;
    state.calls.botInFlight++;
    if (state.callBotParams) state.callBotParams.push(params);
    try {
      if (state.callBotHang) {
        // ค้างจน caller abort — พิสูจน์ bounded HTTP timeout (AbortSignal)
        await new Promise((_, rej) => {
          const t = setTimeout(() => rej(new Error("mock hang timeout — caller never aborted")), 400);
          params.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            rej(Object.assign(new Error("bot call aborted"), { name: "AbortError" }));
          });
        });
      }
      if (state.callBotDelayMs > 0) {
        await new Promise((r) => setTimeout(r, state.callBotDelayMs));
      }
      if (state.callBotError) throw state.callBotError;
    } finally {
      state.calls.botInFlight--;
    }
    return {
      answer: "mock bot answer",
      source: "mock",
      model: "mock-model",
      elapsed: state.callBotDelayMs / 1000,
      usage: { prompt: 1, output: 1, total: 2 },
      chat_engine: "legacy",
    };
  };
}

export function makeGetSystemConfigMock(state) {
  return async function getSystemConfig() {
    return { ...state.config };
  };
}
export const shouldUseChatV2 = async () => false;
export const shouldUseChatV3 = async () => false;
export const getBotProductLimit = async () => 10;
