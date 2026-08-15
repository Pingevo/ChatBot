/**
 * Interface กลางที่ทุก platform adapter ต้อง implement เหมือนกัน (megaplan ข้อ 4)
 * Core business logic (polling worker, inbox controller) เรียกผ่าน adapter เท่านั้น
 * ห้ามผูก logic กับ Shopee โดยตรงนอก adapter นี้ — เพื่อเสียบ TikTok/Lazada เข้ามาทีหลังได้ง่าย
 *
 * นี่เป็น interface reference เฉยๆ ไม่ต้อง instantiate ตรงๆ
 */
class BaseChatAdapter {
  /** @returns {Promise<{conversations: object[], nextCursor: any, hasMore: boolean}>} */
  async fetchConversations(shop, { cursor, direction = 'latest', type = 'all' } = {}) {
    throw new Error('fetchConversations not implemented');
  }

  /** @returns {Promise<{messages: object[], nextOffset: string}>} */
  async fetchMessages(shop, conversationId, { offset } = {}) {
    throw new Error('fetchMessages not implemented');
  }

  /** @returns {Promise<object>} ผลลัพธ์การส่งข้อความ (message_id, created_timestamp, ฯลฯ) */
  async sendMessage(shop, { toId, conversationId, messageType, content, sourceContent } = {}) {
    throw new Error('sendMessage not implemented');
  }

  async markRead(shop, conversationId, lastReadMessageId) {
    throw new Error('markRead not implemented');
  }

  async pinConversation(shop, conversationId, pinned) {
    throw new Error('pinConversation not implemented');
  }
}

module.exports = BaseChatAdapter;
