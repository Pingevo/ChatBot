// Leaf mocks for test-botworker-config-failclosed.ts
//
// mock เฉพาะ mongoClient — systemConfigService เป็น production code จริง
// state.findOneHook = failure injection ที่ DB-read boundary เดียว

import { createFakeMongo } from "./test-botworker-fakemongo.mjs";

export const state = {
  /** @type {null | ((coll:string, filter:any)=>any)} set → findOne throws (DB outage) */
  findOneHook: null,
  /** @type {{coll:string, op:string, filter:any}[]} */ queryLog: [],
  uniqueKeys: {
    system_configs: ["config_key"],
  },
};

const fm = createFakeMongo(state);
export const fakeColl = fm.fakeColl;
export const getCollection = fm.getCollection;
export const COLLECTIONS = fm.COLLECTIONS;
export const store = fm.store;

state.onQuery = (coll, op, filter) => {
  state.queryLog.push({ coll, op, filter });
};

export function resetState() {
  state.findOneHook = null;
  state.queryLog.length = 0;
  fm.store.clear();
}

export const serverConfig = { mongoDbName: "fake_admin", collections: COLLECTIONS };
export async function getDb() { throw new Error("fake mongo: getDb not supported — use getCollection"); }
export async function ensureIndexes() {}
