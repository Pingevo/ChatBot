const Shop = require('../models/Shop');
const { getShpTokenModel } = require('../config/sellcenterDb');
const { isTokenFresh } = require('./tokenReader');

/**
 * Auto-discover shops จาก sellcenter's Shp2022Token collection
 * ร้านไหนที่ sellcenter มี token อยู่ = เคย authorize กับเราแล้ว
 * อ่านแบบ read-only แล้ว upsert เป็น Shop record ใน chatCenter DB
 *
 * @param {{enableForChat?: boolean}} opts — enableForChat=true = ตั้ง enabled_for_chat ให้ poll worker ดึงทันที
 * @returns {Promise<{discovered: number, fresh: number, stale: number, upserted: number}>}
 */
async function syncShopsFromSellcenter({ enableForChat = true } = {}) {
  const ShpToken = getShpTokenModel();
  const tokenDocs = await ShpToken.find({}).lean();

  // กรองซ้ำ — มีบาง shop_id ที่มีหลาย token doc (เก่า + ใหม่)
  // เก็บเฉพาะ token ล่าสุดของแต่ละ shop_id
  const latestByShopId = new Map();
  for (const doc of tokenDocs) {
    const key = String(doc.shop_id);
    const existing = latestByShopId.get(key);
    if (!existing || (doc.access_token_time_unix || 0) > (existing.access_token_time_unix || 0)) {
      latestByShopId.set(key, doc);
    }
  }

  let fresh = 0;
  let stale = 0;
  let upserted = 0;

  for (const [shopIdStr, doc] of latestByShopId) {
    const tokenFresh = isTokenFresh(doc);
    if (tokenFresh) fresh++; else stale++;

    // upsert Shop record — ไม่เขียนทับ status ถ้าร้านนั้นมีอยู่แล้วและ status เป็น token_error
    // (ปล่อยให้ poll cycle ถัดไปเป็นคนอัปเดต status)
    const shopName = doc.shopname || null;
    const existing = await Shop.findOne({ platform: 'shopee', shop_id: shopIdStr });

    await Shop.updateOne(
      { platform: 'shopee', shop_id: shopIdStr },
      {
        $set: {
          platform: 'shopee',
          shop_id: shopIdStr,
          shopname: shopName,
          shop_name: shopName || (existing && existing.shop_name) || `Shop ${shopIdStr}`,
          // ตั้ง enabled_for_chat เฉพาะถ้ายังไม่เคยตั้ง (existing ยังไม่มี) หรือสั่ง enable ตรงๆ
          // ไม่เขียนทับ enabled_for_chat ที่ user ปิดไว้เอง ถ้าไม่ได้สั่ง enableForChat
          ...(enableForChat && (!existing || !existing.enabled_for_chat) ? { enabled_for_chat: true } : {}),
        },
      },
      { upsert: true }
    );
    upserted++;
  }

  return { discovered: latestByShopId.size, fresh, stale, upserted };
}

module.exports = { syncShopsFromSellcenter };
