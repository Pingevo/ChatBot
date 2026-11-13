const assert = require("node:assert/strict");
const fs = require("node:fs");
const { BSON, BSONRegExp, Binary, Decimal128, Double, Int32, Long, ObjectId } = require("mongodb");
const { EJSON } = BSON;

const sourceBson = {
  _id: new ObjectId("507f1f77bcf86cd799439011"),
  created_at: new Date("2026-11-12T07:40:00.000Z"),
  amount: Decimal128.fromString("1234567890.012300"),
  int32: new Int32(42),
  int64: Long.fromString("4294967296"),
  double: new Double(42),
  regex: new BSONRegExp("zaapi", "im"),
  binary: new Binary(Buffer.from([1, 2, 3])),
};
const source = BSON.deserialize(BSON.serialize(sourceBson), {
  promoteValues: false,
  promoteLongs: false,
  promoteBuffers: false,
  bsonRegExp: true,
});
const encoded = EJSON.stringify(source, { relaxed: false });
const decoded = EJSON.parse(encoded, { relaxed: false });

assert.ok(decoded._id instanceof ObjectId);
assert.equal(decoded._id.toHexString(), source._id.toHexString());
assert.ok(decoded.created_at instanceof Date);
assert.equal(decoded.created_at.toISOString(), source.created_at.toISOString());
assert.ok(decoded.amount instanceof Decimal128);
assert.equal(decoded.amount.toString(), source.amount.toString());
assert.ok(decoded.int32 instanceof Int32);
assert.ok(decoded.int64 instanceof Long);
assert.equal(decoded.int64.toString(), source.int64.toString());
assert.ok(decoded.double instanceof Double);
assert.ok(decoded.regex instanceof BSONRegExp);
assert.ok(decoded.binary instanceof Binary);
assert.equal(EJSON.stringify(decoded, { relaxed: false }), encoded);

if (process.argv[2]) {
  const documents = {
    zaapi_kb: [
      {
        _id: new ObjectId("507f1f77bcf86cd799439011"),
        source_id: "legacy-source",
        source_name: "Fixture source",
        kind: "xlsx_row",
        active: true,
        text: "fixture answer",
        fields: { question: "fixture question" },
        content_type: "faq",
        accounts: [{ id: "shop-1", platform: "Shopee", name: "Fixture shop" }],
        captured_at: source.created_at,
        amount: source.amount,
        int32: source.int32,
        int64: source.int64,
        double: source.double,
        regex: source.regex,
        binary: source.binary,
      },
      {
        _id: new ObjectId("507f1f77bcf86cd799439012"),
        source_file: "fixture.xlsx",
        file_rev: 1,
        apply_id: "apply-1",
        text: "fixture answer",
        fields: { question: "fixture question" },
        content_type: "faq",
      },
    ],
    zaapi_kb_files: [
      {
        _id: "fixture.xlsx",
        active_rev: 1,
        active_apply: "apply-1",
        accounts: ["shop-1"],
        platforms: ["shopee"],
      },
    ],
    zaapi_kb_import_log: [
      {
        _id: new ObjectId("507f1f77bcf86cd799439013"),
        at: source.created_at,
        amount: source.amount,
        int32: source.int32,
        int64: source.int64,
        double: source.double,
        regex: source.regex,
        binary: source.binary,
      },
    ],
  };
  const roles = Object.keys(documents);
  const hashes = Object.fromEntries(roles.map((role) => [role, require("node:crypto").createHash("sha256")]));
  const counts = Object.fromEntries(roles.map((role) => [role, 0]));
  const lines = [JSON.stringify({
    kind: "header",
    format: "zaapi-kb-snapshot",
    version: 1,
    captured_at: "2026-11-12T00:00:00Z",
    collections: roles,
    collection_names: { zaapi_kb: "zaapi_kb", zaapi_kb_files: "zaapi_kb_files", zaapi_kb_import_log: "zaapi_kb_import_log" },
  }) + "\n"];
  for (const role of roles) {
    for (const document of documents[role]) {
      const line = EJSON.stringify({ kind: "record", collection: role, document }, { relaxed: false }) + "\n";
      lines.push(line);
      hashes[role].update(line, "utf8");
      counts[role] += 1;
    }
  }
  lines.push(JSON.stringify({
    kind: "footer",
    complete: true,
    counts,
    sha256: Object.fromEntries(roles.map((role) => [role, hashes[role].digest("hex")])),
  }) + "\n");
  fs.writeFileSync(process.argv[2], lines.join(""));
}

process.stdout.write("MongoDB Canonical EJSON BSON round-trip passed\n");
