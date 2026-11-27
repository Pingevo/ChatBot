/** @type {{ orderDocs: Record<string, any>[]; orderFindCalls: { filter: Record<string, any>; options: { projection: Record<string, any> } }[]; customerId: string; missingConversation: boolean }} */
export const state = {
  orderDocs: [],
  orderFindCalls: [],
  customerId: "12204060",
  missingConversation: false,
};

/** @param {Record<string, any>[]} [orderDocs] */
export function reset(orderDocs = []) {
  state.orderDocs = structuredClone(orderDocs);
  state.orderFindCalls = [];
  state.customerId = "12204060";
  state.missingConversation = false;
}

function project(doc, projection) {
  const result = {};
  for (const [key, value] of Object.entries(projection || {})) {
    if (value === 1) {
      if (doc[key] !== undefined) result[key] = doc[key];
    } else if (key === "item_list" && value?.$slice && Array.isArray(doc.item_list)) {
      result.item_list = doc.item_list.slice(0, value.$slice);
    }
  }
  return result;
}

export async function getOrderCollection() {
  return {
    find(filter, options) {
      state.orderFindCalls.push({ filter: structuredClone(filter), options: structuredClone(options) });
      let rows = state.orderDocs.filter((doc) => doc.buyer_user_id === filter.buyer_user_id);
      return {
        sort() { return this; },
        limit(limit) { rows = rows.slice(0, limit); return this; },
        async toArray() { return rows.map((doc) => project(doc, options?.projection)); },
      };
    },
  };
}

export async function requireAuth() {
  return { ok: true, ctx: { admin: { admin_id: "admin-test", role: "admin" } } };
}

export const conversationService = {
  async getConversation() {
    return state.missingConversation ? null : { customer_id: state.customerId };
  },
};

export function json(body, status = 200) {
  return { body, status };
}

export function error(detail, status = 400) {
  return { body: { detail }, status };
}
