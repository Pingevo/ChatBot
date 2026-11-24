export const calls = [];
let authAllowed = true;

export function setAuthAllowed(value) { authAllowed = value; }
export async function requireAuth() {
  return authAllowed
    ? { ok: true, ctx: { admin: { admin_id: "admin-test" } } }
    : { ok: false, response: Response.json({ error: "unauthorized" }, { status: 401 }) };
}
export function json(body, status = 200) { return Response.json(body, { status }); }
export function error(message, status = 400) { return Response.json({ error: message }, { status }); }

export async function getDbWalletCollection(name) {
  calls.push({ name });
  return {
    distinct: async (field) => {
      calls.at(-1).field = field;
      return ["Zulu Shop", "Alpha Shop", "Black Shark"];
    },
  };
}

