const BaseChatAdapter = require('./base-adapter');
const { signShopLevel, PARTNER_ID } = require('../services/shopeeSign');
const { getValidAccessToken } = require('../services/tokenReader');
const RequestLog = require('../models/RequestLog');

// ⚠️ ใช้ json-bigint แทน JSON.parse ธรรมดา — message_id/conversation_id เป็น int64
// ที่เกิน Number.MAX_SAFE_INTEGER ของ JS ไปมาก (megaplan ข้อ 3.1)
// storeAsString: true = ตัวเลขใหญ่จะถูกแปลงเป็น string อัตโนมัติตอน parse
const JSONbig = require('json-bigint')({ storeAsString: true });

const SHOPEE_HOST_URL = process.env.SHOPEE_HOST_URL || 'https://partner.shopeemobile.com';

/**
 * เรียก sellerchat.* endpoint แบบ shop-level signing + log ทุกครั้งตาม audit requirement (ข้อ 7)
 */
async function callSellerChatApi(shop, apiName, { method = 'GET', query = {}, body = null } = {}) {
  const path = apiName.startsWith('/') ? apiName : (apiName.includes('/') ? `/api/v2/${apiName}` : `/api/v2/sellerchat/${apiName}`);
  const { access_token, shop_id } = await getValidAccessToken({ shop_id: shop.shop_id, shopname: shop.shopname });
  const { timestamp, sign } = signShopLevel(path, access_token, shop_id);

  const params = new URLSearchParams({
    partner_id: PARTNER_ID,
    timestamp: String(timestamp),
    access_token,
    shop_id: String(shop_id),
    sign,
    ...Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])),
  });

  const url = `${SHOPEE_HOST_URL}${path}?${params.toString()}`;

  let statusCode;
  let parsedResponse;
  let errorMsg = '';

  try {
    const fetchOptions = { method };
    if (body) {
      fetchOptions.headers = { 'Content-Type': 'application/json' };
      fetchOptions.body = JSONbig.stringify(body); // ⚠️ ใช้ JSONbig เพื่อรักษา int64 precision (megaplan ข้อ 3.1)
    }
    const res = await fetch(url, fetchOptions);
    statusCode = res.status;
    const rawText = await res.text();
    parsedResponse = JSONbig.parse(rawText); // ⚠️ ห้ามใช้ res.json() ตรงๆ เพราะจะพลาดจุด int64 precision
    if (parsedResponse.error) {
      errorMsg = parsedResponse.message || parsedResponse.error;
    }
  } catch (err) {
    errorMsg = err.message;
  }

  // ⚠️ บันทึกเฉพาะเมื่อมี error เกิดขึ้น หรือเปิด ENABLE_SUCCESS_LOGS=true ใน .env เพื่อไม่ให้เกิด Log ขยะจากการ poll ปกติ
  if (errorMsg || process.env.ENABLE_SUCCESS_LOGS === 'true') {
    await RequestLog.create({
      platform: 'shopee',
      direction: 'api_out',
      event_type: apiName,
      shop_id: String(shop.shop_id),
      request_payload: { path, query, body },
      response_payload: parsedResponse,
      status_code: statusCode,
      error: errorMsg,
    });
  }

  if (errorMsg) {
    throw new Error(`shopee ${apiName} failed: ${errorMsg}`);
  }

  return parsedResponse.response;
}

class ShopeeAdapter extends BaseChatAdapter {
  async fetchConversations(shop, { cursor = null, direction = 'latest', type = 'all' } = {}) {
    const query = { direction, type, page_size: 25, business_type: 0 };
    if (cursor && cursor.next_timestamp_nano) {
      query.next_timestamp_nano = cursor.next_timestamp_nano;
    }
    const response = await callSellerChatApi(shop, 'get_conversation_list', { query });
    return {
      conversations: response.conversations || [],
      nextCursor: response.page_result ? response.page_result.next_cursor : null,
      hasMore: response.page_result ? response.page_result.more : false,
    };
  }

  async fetchOneConversation(shop, conversationId) {
    const query = { conversation_id: conversationId, business_type: 0 };
    return callSellerChatApi(shop, 'get_one_conversation', { query });
  }

  async fetchMessages(shop, conversationId, { offset = null, pageSize = 25 } = {}) {
    const query = { conversation_id: conversationId, page_size: pageSize, business_type: 0 };
    if (offset) query.offset = offset;
    const response = await callSellerChatApi(shop, 'get_message', { query });
    return {
      messages: response.messages || [],
      nextOffset: response.page_result ? response.page_result.next_offset : null,
    };
  }

  async sendMessage(shop, { toId, conversationId, messageType, content, sourceContent } = {}) {
    if (process.env.ENABLE_SEND_MESSAGE !== 'true') {
      throw new Error('ENABLE_SEND_MESSAGE is off — kill switch active (megaplan ข้อ 12)');
    }
    const body = {
      // ⚠️ to_id และ conversation_id เป็น int64 — ต้องส่งเป็น BigInt เพื่อรักษา precision
      // JSONbig.stringify จะแปลง BigInt เป็น number ใน JSON โดยไม่สูญเสีย precision (megaplan ข้อ 3.1)
      to_id: BigInt(toId),
      message_type: messageType,
      content,
    };
    if (conversationId) body.conversation_id = BigInt(conversationId);
    if (sourceContent) body.source_content = sourceContent; // required สำหรับข้อความแรกของ conversation ใหม่ (ข้อ 2.2)

    return callSellerChatApi(shop, 'send_message', { method: 'POST', body });
  }

  async markRead(shop, conversationId, lastReadMessageId) {
    const body = {
      conversation_id: BigInt(conversationId),
    };
    if (lastReadMessageId) {
      body.last_read_message_id = String(lastReadMessageId);
    }
    return callSellerChatApi(shop, 'read_conversation', {
      method: 'POST',
      body,
    });
  }

  async pinConversation(shop, conversationId, pinned) {
    const apiName = pinned ? 'pin_conversation' : 'unpin_conversation';
    return callSellerChatApi(shop, apiName, { method: 'POST', body: { conversation_id: BigInt(conversationId) } });
  }

  async muteConversation(shop, conversationId, mute) {
    const apiName = mute ? 'mute_conversation' : 'unmute_conversation';
    return callSellerChatApi(shop, apiName, { method: 'POST', body: { conversation_id: BigInt(conversationId) } });
  }

  async unreadConversation(shop, conversationId) {
    return callSellerChatApi(shop, 'unread_conversation', { method: 'POST', body: { conversation_id: BigInt(conversationId) } });
  }

  async deleteConversation(shop, conversationId) {
    return callSellerChatApi(shop, 'delete_conversation', { method: 'POST', body: { conversation_id: BigInt(conversationId) } });
  }

  async getItemBaseInfo(shop, itemId) {
    return callSellerChatApi(shop, 'product/get_item_base_info', {
      method: 'GET',
      // ⚠️ price_info ไม่ใช่ default field — ต้องระบุใน response_optional_fields ถึงจะได้ราคากลับมา
      query: { item_id_list: String(itemId), response_optional_fields: 'price_info,image' }
    });
  }

  async getItemList(shop, { offset = 0, pageSize = 20, itemStatus = 'NORMAL' } = {}) {
    return callSellerChatApi(shop, 'product/get_item_list', {
      method: 'GET',
      query: { offset, page_size: pageSize, item_status: itemStatus },
    });
  }

  // ⚠️ price_info ใน get_item_base_info คืนราคาได้เฉพาะสินค้าที่ "ไม่มีตัวเลือก" (has_model: false)
  // สินค้าที่มีตัวเลือก (มีหลาย SKU/ราคาแยกตามตัวเลือก) ต้องเรียก get_model_list แยกถึงจะได้ราคา
  async getModelList(shop, itemId) {
    return callSellerChatApi(shop, 'product/get_model_list', {
      method: 'GET',
      query: { item_id: String(itemId) },
    });
  }

  async getCsatMsgDetails(shop, { csatResult = 'Bad', timeFrom, timeTo, pageNo = 0, pageSize = 25 } = {}) {
    const query = {
      csat_result: csatResult,
      page_no: String(pageNo),
      page_size: String(pageSize),
    };
    if (timeFrom) query.time_from = String(timeFrom);
    if (timeTo) query.time_to = String(timeTo);

    return callSellerChatApi(shop, 'get_csat_msg_details', { method: 'GET', query });
  }

  async uploadVideo(shop, base64OrBuffer) {
    // ⚠️ Shopee Open API v2: /api/v2/sellerchat/upload_video (max 30MB, duration 1-180s)
    const path = `/api/v2/sellerchat/upload_video`;
    const { access_token, shop_id } = await getValidAccessToken({ shop_id: shop.shop_id, shopname: shop.shopname });
    const { timestamp, sign } = signShopLevel(path, access_token, shop_id);

    const params = new URLSearchParams({
      partner_id: PARTNER_ID,
      timestamp: String(timestamp),
      access_token,
      shop_id: String(shop_id),
      sign,
    });

    const url = `${SHOPEE_HOST_URL}${path}?${params.toString()}`;

    let buffer;
    if (typeof base64OrBuffer === 'string') {
      const base64Data = base64OrBuffer.replace(/^data:video\/\w+;base64,/, '');
      buffer = Buffer.from(base64Data, 'base64');
    } else {
      buffer = base64OrBuffer;
    }

    const formData = new FormData();
    const blob = new Blob([buffer], { type: 'video/mp4' });
    formData.append('file', blob, 'video.mp4');

    const res = await fetch(url, {
      method: 'POST',
      body: formData,
    });

    const rawText = await res.text();
    const parsedResponse = JSONbig.parse(rawText);

    if (parsedResponse.error) {
      throw new Error(parsedResponse.message || parsedResponse.error);
    }
    return parsedResponse.response; // { vid }
  }

  async getVideoUploadResult(shop, vid) {
    return callSellerChatApi(shop, 'get_video_upload_result', {
      method: 'GET',
      query: { vid: String(vid) }
    });
  }

  async uploadVideoAndWait(shop, base64OrBuffer) {
    const uploadRes = await this.uploadVideo(shop, base64OrBuffer);
    const vid = uploadRes && uploadRes.vid;
    if (!vid) throw new Error('Failed to obtain vid from video upload');

    // Poll for status === 'successful' or 'succeeded' or presence of video URL (up to 30 seconds)
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const info = await this.getVideoUploadResult(shop, vid).catch(() => null);
      if (info) {
        const status = (info.status || '').toLowerCase();
        if (status === 'successful' || status === 'succeeded' || (info.video && info.video.length > 0)) {
          return { vid, ...info };
        }
        if (status === 'failed' || status === 'cancelled') {
          throw new Error('Shopee video processing failed: ' + (info.message || status));
        }
      }
    }
    return { vid };
  }

  async uploadImage(shop, base64OrBuffer) {
    // ⚠️ Shopee Open API v2: /api/v2/sellerchat/upload_image
    // ต้องอัปโหลดแบบ multipart/form-data ด้วย parameter "file"
    const path = `/api/v2/sellerchat/upload_image`;
    const { access_token, shop_id } = await getValidAccessToken({ shop_id: shop.shop_id, shopname: shop.shopname });
    const { timestamp, sign } = signShopLevel(path, access_token, shop_id);

    const params = new URLSearchParams({
      partner_id: PARTNER_ID,
      timestamp: String(timestamp),
      access_token,
      shop_id: String(shop_id),
      sign,
    });

    const url = `${SHOPEE_HOST_URL}${path}?${params.toString()}`;

    // แปลง base64 data URI หรือ buffer เป็น Uint8Array/Blob สำหรับ FormData
    let buffer;
    if (typeof base64OrBuffer === 'string') {
      const base64Data = base64OrBuffer.replace(/^data:image\/\w+;base64,/, '');
      buffer = Buffer.from(base64Data, 'base64');
    } else {
      buffer = base64OrBuffer;
    }

    const formData = new FormData();
    const blob = new Blob([buffer], { type: 'image/jpeg' });
    formData.append('file', blob, 'image.jpg');

    const res = await fetch(url, {
      method: 'POST',
      body: formData,
    });

    const rawText = await res.text();
    const parsedResponse = JSONbig.parse(rawText);

    if (parsedResponse.error) {
      throw new Error(`shopee upload_image failed: ${parsedResponse.message || parsedResponse.error}`);
    }

    // คืนค่า response object ที่มี url เช่น { url: "https://cf.shopee.co.th/file/...", ... }
    return parsedResponse.response;
  }
}

module.exports = new ShopeeAdapter();
