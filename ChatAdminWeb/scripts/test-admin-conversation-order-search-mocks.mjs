export const state = {
  colls: {},
  aggregateCalls: [],
  orderDocs: [],
  orderFindOneCalls: [],
  orderError: null,
  botworkerCache: new Map(),
};

export function resetState() {
  state.colls = {};
  state.aggregateCalls = [];
  state.orderDocs = [];
  state.orderFindOneCalls = [];
  state.orderError = null;
  state.botworkerCache = new Map();
}

export function fakeColl(name) {
  if (!state.colls[name]) state.colls[name] = [];
  return state.colls[name];
}

export function setOrderDocs(docs) {
  state.orderDocs = docs;
}

export const COLLECTIONS = {
  conversations: "conversations",
  statusConversation: "status_conversation",
  testStatusConversation: "test_status_conversation",
  shops: "shops",
  messages: "messages",
  admins: "admins",
};

function getPath(value, path) {
  return path.split(".").reduce((current, key) => current?.[key], value);
}

function matchesValue(value, condition) {
  if (condition && typeof condition === "object" && !(condition instanceof Date)) {
    if ("$regex" in condition) {
      if (typeof value !== "string") return false;
      return new RegExp(condition.$regex, condition.$options || "").test(value);
    }
    if ("$exists" in condition && condition.$exists !== (value !== undefined)) return false;
    if ("$in" in condition) return condition.$in.includes(value);
    if ("$nin" in condition) return !condition.$nin.includes(value);
    if ("$ne" in condition) return value !== condition.$ne;
  }
  if (condition instanceof Date && value instanceof Date) return value.getTime() === condition.getTime();
  return value === condition;
}

function matches(doc, filter, variables = {}) {
  return Object.entries(filter || {}).every(([key, condition]) => {
    if (key === "$or") return condition.some((part) => matches(doc, part, variables));
    if (key === "$and") return condition.every((part) => matches(doc, part, variables));
    if (key === "$expr") return Boolean(evaluate(doc, condition, variables));
    return matchesValue(getPath(doc, key), condition);
  });
}

function evaluate(value, expression, variables = {}) {
  if (typeof expression === "string" && expression.startsWith("$$")) return variables[expression.slice(2)];
  if (typeof expression === "string" && expression.startsWith("$")) return getPath(value, expression.slice(1));
  if (Array.isArray(expression)) return expression.map((item) => evaluate(value, item, variables));
  if (!expression || typeof expression !== "object") return expression;
  if ("$eq" in expression) {
    const [left, right] = evaluate(value, expression.$eq, variables);
    return left === right;
  }
  if ("$gt" in expression) {
    const [left, right] = evaluate(value, expression.$gt, variables);
    return left > right;
  }
  if ("$arrayElemAt" in expression) {
    const [array, index] = evaluate(value, expression.$arrayElemAt, variables);
    return array?.[index];
  }
  if ("$ifNull" in expression) {
    const [candidate, fallback] = evaluate(value, expression.$ifNull, variables);
    return candidate ?? fallback;
  }
  if ("$cond" in expression) {
    const [condition, yes, no] = evaluate(value, expression.$cond, variables);
    return condition ? yes : no;
  }
  return expression;
}

function runPipeline(input, pipeline, variables = {}) {
  let rows = input.map((row) => structuredClone(row));
  for (const stage of pipeline) {
    const [operator, spec] = Object.entries(stage)[0];
    if (operator === "$match") rows = rows.filter((row) => matches(row, spec, variables));
    else if (operator === "$lookup") {
      const foreign = state.colls[spec.from] || [];
      rows = rows.map((row) => {
        if (spec.pipeline) {
          const boundVariables = Object.fromEntries(Object.entries(spec.let || {}).map(([key, expr]) => [key, evaluate(row, expr, variables)]));
          return { ...row, [spec.as]: runPipeline(foreign, spec.pipeline, boundVariables) };
        }
        return {
          ...row,
          [spec.as]: foreign.filter((other) => getPath(other, spec.foreignField) === getPath(row, spec.localField)),
        };
      });
    } else if (operator === "$unwind") {
      const path = (typeof spec === "string" ? spec : spec.path).replace(/^\$/, "");
      const preserveNullAndEmptyArrays = typeof spec === "object" && spec.preserveNullAndEmptyArrays;
      rows = rows.flatMap((row) => {
        const value = getPath(row, path);
        if (Array.isArray(value) && value.length) return value.map((item) => ({ ...row, [path]: item }));
        if (value != null) return [row];
        return preserveNullAndEmptyArrays ? [row] : [];
      });
    } else if (operator === "$set") {
      rows = rows.map((row) => Object.fromEntries([
        ...Object.entries(row),
        ...Object.entries(spec).map(([key, expression]) => [key, evaluate(row, expression, variables)]),
      ]));
    } else if (operator === "$sort") {
      const keys = Object.entries(spec);
      rows = [...rows].sort((left, right) => {
        for (const [key, direction] of keys) {
          const a = getPath(left, key);
          const b = getPath(right, key);
          if (a < b) return direction * -1;
          if (a > b) return direction;
        }
        return 0;
      });
    } else if (operator === "$limit") rows = rows.slice(0, spec);
    else if (operator === "$count") rows = rows.length ? [{ [spec]: rows.length }] : [];
    else if (operator === "$group") {
      const grouped = new Map();
      for (const row of rows) {
        const id = evaluate(row, spec._id);
        if (!grouped.has(id)) grouped.set(id, { _id: id });
        const output = grouped.get(id);
        for (const [key, accumulator] of Object.entries(spec)) {
          if (key === "_id") continue;
          const [kind, expression] = Object.entries(accumulator)[0];
          const value = evaluate(row, expression);
          if (kind === "$max") {
            if (output[key] === undefined || value > output[key]) output[key] = value;
          } else if (kind === "$push") {
            (output[key] ||= []).push(value);
          }
        }
      }
      rows = [...grouped.values()];
    } else throw new Error(`unsupported fake Mongo stage ${operator}`);
  }
  return rows;
}

export async function getCollection(name) {
  return {
    find(filter = {}, options = {}) {
      let rows = (state.colls[name] || []).filter((row) => matches(row, filter));
      const projection = options.projection || {};
      const included = Object.keys(projection).filter((key) => projection[key] === 1);
      if (included.length) rows = rows.map((row) => Object.fromEntries(included.map((key) => [key, getPath(row, key)])));
      return { toArray: async () => rows };
    },
    async countDocuments(filter = {}) {
      return (state.colls[name] || []).filter((row) => matches(row, filter)).length;
    },
    async distinct(field, filter = {}) {
      return [...new Set((state.colls[name] || [])
        .filter((row) => matches(row, filter))
        .map((row) => getPath(row, field))
        .filter((value) => value !== undefined))];
    },
    aggregate(pipeline) {
      state.aggregateCalls.push({ collection: name, pipeline: structuredClone(pipeline) });
      return { toArray: async () => runPipeline(state.colls[name] || [], pipeline) };
    },
  };
}

export async function getOrderCollection() {
  return {
    async findOne(filter, options) {
      state.orderFindOneCalls.push({ filter: structuredClone(filter), options: structuredClone(options) });
      if (state.orderError) throw state.orderError;
      return state.orderDocs.find((doc) => matches(doc, filter)) || null;
    },
  };
}

export async function requireAuth() {
  return {
    ok: true,
    ctx: { admin: { admin_id: "admin1", role: "admin", active: true, channels_access: ["shopee"] } },
  };
}

export async function requirePageAccess() {
  return requireAuth();
}

export const testStatusConversationService = {
  async getTestStatusMap(ids, source) {
    const allowed = new Set(ids);
    return new Map(fakeColl("test_status_conversation")
      .filter((row) => row.source === source && allowed.has(row.conversation_id))
      .map((row) => [row.conversation_id, row]));
  },
};

export const statusConversationService = {
  async getMetaMap() { return new Map(); },
};

export function getBotworkerConversationCache(key) { return state.botworkerCache.get(key) || null; }
export function setBotworkerConversationCache(value) { state.botworkerCache.set(value.key, value); }

export function parseInboxFilters() { return null; }
export const OWNED_CHAT_STATUSES = ["handoff", "open", "pending", "closed", "resolved"];
export const CONVERSATION_TEXT_SEARCH_FIELDS = ["to_name", "last_message_text", "shop_name", "conversation_id", "customer_id"];
export function unansweredStages() { return []; }
export function messageStatusMatch() { return []; }

export function json(body, status = 200) {
  return { __status: status, body };
}

export function error(detail, status = 400) {
  return { __status: status, body: { detail } };
}
