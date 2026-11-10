import "dotenv/config";
import { getCollection } from "../src/backend/db/mongoClient";
async function main() {
  const u = await getCollection("ai_usage");
  // นับ docs ที่มี fields ใหม่ vs เก่า (schema coexist check)
  const enriched = await u.countDocuments({ path: { $exists: true } });
  const withProvider = await u.countDocuments({ provider: { $exists: true } });
  const withConv = await u.countDocuments({ conv_id: { $exists: true } });
  const withErr = await u.countDocuments({ status: "error" });
  const total = await u.estimatedDocumentCount();
  console.log(`ai_usage total=${total} enriched(path)=${enriched} provider=${withProvider} conv_id=${withConv} error_status=${withErr}`);
  const lu = await u.find({ path: { $exists: true } }, { sort: { ts: -1 }, limit: 3 }).toArray();
  for (const d of lu) console.log("ENRICHED:", JSON.stringify(d).slice(0, 500));

  const l = await getCollection("admin_logs");
  const recent = await l.find({}, { sort: { timestamp: -1 }, limit: 15, projection: { action_type: 1, timestamp: 1 } }).toArray();
  console.log("=== admin_logs 15 ล่าสุด (action_type/timestamp) ===");
  for (const r of recent) console.log(`  ${(r as Record<string, unknown>).timestamp} ${(r as Record<string, unknown>).action_type}`);
  // vocabulary coverage — distinct action_type ทั้งหมด
  const vocab = await l.aggregate([{ $group: { _id: "$action_type", n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray();
  console.log(`=== action_type vocabulary (${vocab.length} distinct) ===`);
  for (const v of vocab) console.log(`  ${v._id}: ${v.n}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
