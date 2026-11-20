export const COLLECTIONS = { testStatusConversation: "test_status_conversation", messages: "messages_shp" };
export const writes = [];
export async function getCollection(name) {
  if (name === COLLECTIONS.testStatusConversation) return { findOne: async () => ({ status: "bot" }) };
  if (name === COLLECTIONS.messages) return { updateOne: async (filter, update) => { writes.push({ filter, update }); return { matchedCount: 1 }; } };
  throw new Error(`unexpected_collection:${name}`);
}
