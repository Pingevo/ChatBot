// probe-shadow-stats.ts — verify getShadowReplyStats จริง (post-fix)
// read-only เท่านั้น
import "dotenv/config";
import { getShadowReplyStats } from "../src/backend/service/shadowReplyService";

async function main() {
  let t = Date.now();
  const all = await getShadowReplyStats({});
  console.log(`all-history stats: ${Date.now() - t}ms`);
  console.log(`  total=${all.total} rated=${all.rated} good=${all.good} bad=${all.bad} unrated=${all.unrated} win_rate=${(all.bot_win_rate * 100).toFixed(0)}%`);
  console.log(`  star_rated=${all.star_rated} avg_star=${all.avg_star.toFixed(2)} commented=${all.commented}`);
  console.log(`  cost=$${all.total_cost_usd.toFixed(4)} avg_elapsed=${all.avg_elapsed_ms.toFixed(0)}ms tokens=${all.total_tokens}`);

  // per-chat path (same function + conversation_id filter)
  t = Date.now();
  const one = await getShadowReplyStats({ conversationId: all.total ? undefined : "x" });
  void one;
}
main().catch((e) => { console.error(e); process.exit(1); });
