// Shopee send failure texts — single owner shared by send routes (detail) and the composer popup (title/cause/action).
// describeSendFailure(code): always returns Thai {title, cause, action}; unknown code → generic text that still shows the code.
export interface SendFailureInfo { title: string; cause: string; action: string }

export const SHOPEE_PROVIDER_ERRORS = [
  "first_chat_without_order_info", "exceed_send_limitaion", "shop_bound_subaccount", "user_is_forbidden", "invalid_content",
  "message_is_censored", "error_blocked", "invalid_to_id", "error_sender_block_receiver", "reach_5_message_limit",
  "source_ip_undeclared", "param_error", "error_sign",
] as const;

const SELLCENTER_IP = "ให้พี่ที่ดูแล Sellcenter เพิ่ม IP เครื่องนี้ใน allowIps ของ service token (และถ้าอินเทอร์เน็ตเปลี่ยน IP ต้องแจ้ง IP ใหม่)";

const TEXT: Record<string, SendFailureInfo> = {
  send_mode_changed: { title: "สถานะสวิตช์ส่งจริงเปลี่ยนไป", cause: "หน้านี้จำสถานะสวิตช์ไว้ตอนเปิดหน้า แต่ตอนนี้ตั้งค่าไว้ไม่ตรงกัน ระบบจึงยังไม่ส่งอะไรไป Shopee", action: "กดรีเฟรชหน้านี้ (F5) แล้วลองส่งใหม่" },
  live_send_disabled: { title: "สวิตช์ส่งจริงปิดอยู่", cause: "ระบบปิดการส่งจริงไป Shopee จึงไม่มีข้อความถึงลูกค้า", action: "เปิดสวิตช์ \"ส่งจริง\" ที่หน้าตั้งค่า แล้วรีเฟรชหน้านี้" },
  credentials_unavailable: { title: "เซิร์ฟเวอร์ยังไม่มีรหัสสำหรับส่ง Shopee", cause: "ไม่พบ SHOPEE_TOKEN_API_SERVICE_TOKEN หรือ SHOPEE_PARTNER_KEY ใน env ของเว็บ", action: "ใส่ทั้งสองค่าใน ChatAdminWeb/.env แล้วรัน npm run dev ใหม่" },
  token_provider_unavailable: { title: "ติดต่อ Sellcenter ไม่ได้", cause: "ขอ token ของร้านจาก digital.in.th ไม่สำเร็จ (อินเทอร์เน็ตหรือเซิร์ฟเวอร์ Sellcenter ขัดข้อง)", action: "ตรวจอินเทอร์เน็ต แล้วลองส่งใหม่อีกครั้ง" },
  token_provider_unauthorized: { title: "Sellcenter ไม่รับ service token", cause: "service token ผิด หมดอายุ หรือไม่ได้ส่งไป", action: "ตรวจค่า SHOPEE_TOKEN_API_SERVICE_TOKEN ใน ChatAdminWeb/.env หรือขอ token ใหม่จากพี่ Sellcenter แล้วรัน npm run dev ใหม่" },
  token_provider_ip_denied: { title: "Sellcenter ไม่อนุญาต IP เครื่องนี้", cause: "service token ผูกกับ IP ที่กำหนดไว้ และ IP เครื่องนี้ไม่อยู่ในรายการ", action: SELLCENTER_IP },
  token_provider_forbidden: { title: "service token ไม่มีสิทธิ์ใช้กับร้านนี้", cause: "token ใช้ได้เฉพาะร้านที่กำหนด (ตอนนี้คือร้าน BlackShark) หรือ scope ไม่ครบ หรือหมดอายุ", action: "ส่งจากแชทของร้านที่ token อนุญาต หรือขอให้พี่ Sellcenter เพิ่มสิทธิ์ร้านนี้" },
  token_provider_shop_unknown: { title: "Sellcenter ไม่รู้จักร้านนี้", cause: "ร้านนี้ไม่อยู่ในระบบ Sellcenter หรือร้านยังไม่ได้กดอนุญาตการเชื่อมต่อกับ Shopee", action: "ตรวจ shop_id ของแชท และให้พี่ Sellcenter ตรวจว่าร้านนี้ authorize แล้ว" },
  token_provider_reauth: { title: "token ของร้านหมดอายุ", cause: "Sellcenter ต่ออายุ token ของร้านนี้ไม่สำเร็จ", action: "ให้เจ้าของร้านกดอนุญาตการเชื่อมต่อ Shopee ใหม่ที่ Sellcenter" },
  token_provider_rejected: { title: "Sellcenter ไม่ให้ token ของร้านนี้", cause: "Sellcenter ปฏิเสธโดยไม่ระบุเหตุผลที่ระบบแยกได้", action: "ตรวจว่าส่งจากร้านที่ token อนุญาต และ IP เครื่องนี้ถูกอนุญาตแล้ว ถ้ายังไม่ได้ให้แจ้งพี่ Sellcenter พร้อมรหัสนี้" },
  delivery_unknown: { title: "ยืนยันผลการส่งไม่ได้", cause: "ผลการส่งยังคลุมเครือ อาจเกิดจากคำขอหมดเวลา หรือ Shopee ตอบข้อผิดพลาดที่ยังไม่ยืนยันว่าข้อความถึงลูกค้าหรือไม่", action: "เปิดแชทใน Shopee ตรวจก่อน อย่าเพิ่งส่งซ้ำ" },
  item_shop_mismatch: { title: "สินค้านี้ไม่ใช่ของร้านในแชท", cause: "สินค้าที่เลือกอยู่คนละร้านกับบทสนทนา", action: "เลือกสินค้าของร้านนี้แล้วส่งใหม่" },
  provider_rejected: { title: "Shopee ไม่รับข้อความ", cause: "Shopee ตอบกลับเป็นข้อผิดพลาดที่ระบบยังไม่รู้จัก", action: "ตรวจเงื่อนไขของ Shopee (ลูกค้าทักมาใน 7 วัน หรือสั่งซื้อใน 30 วัน, ไม่เกิน 5 ข้อความก่อนลูกค้าตอบ) แล้วแจ้งทีมพร้อมรหัสนี้" },
  shopee_error_sign: { title: "Shopee ปฏิเสธลายเซ็นคำขอ", cause: "Shopee ตอบ error_sign จึงไม่ยอมรับคำขอส่งข้อความนี้", action: "ตรวจว่า partner_id จาก token ตรงกับ partner key ที่ตั้งในเว็บ, key ยังใช้ได้ และเวลาเซิร์ฟเวอร์ตรงภายใน 5 นาที แล้วให้ผู้ดูแล Sellcenter ตรวจคู่ credential โดยไม่ส่งค่า key ในแชท" },
  shopee_first_chat_without_order_info: { title: "ต้องส่งการ์ดออเดอร์ก่อน", cause: "ร้านยังไม่เคยคุยกับลูกค้าคนนี้ Shopee ให้ข้อความแรกต้องเป็นการ์ดออเดอร์", action: "ระบบนี้ยังส่งการ์ดออเดอร์ไม่ได้ — ส่งข้อความแรกจากแอป Shopee/Sellcenter ก่อน" },
  shopee_exceed_send_limitaion: { title: "ส่งถี่หรือเกินโควตา", cause: "Shopee จำกัดจำนวนข้อความที่ส่งได้ในช่วงเวลาหนึ่ง", action: "รอสักครู่แล้วค่อยส่งใหม่" },
  shopee_shop_bound_subaccount: { title: "ร้านเปิดกระจายแชทให้ sub-account", cause: "Shopee ไม่ให้ส่งผ่าน API ขณะเปิด chat distribution", action: "ปิด chat distribution ในระบบ sub-account ของร้านก่อน" },
  shopee_user_is_forbidden: { title: "ส่งหาลูกค้าคนนี้ไม่ได้", cause: "ส่งได้เฉพาะลูกค้าที่ทักมาภายใน 7 วัน หรือสั่งซื้อภายใน 30 วัน หรือมีคำขอคืนเงิน/สินค้าค้างอยู่", action: "ตอบผ่านแอป Shopee หรือรอลูกค้าทักมาใหม่" },
  shopee_invalid_content: { title: "เนื้อหาไม่ถูกต้อง", cause: "ประเภทข้อความกับเนื้อหาไม่ตรงกัน", action: "ตรวจข้อความ/ไฟล์ที่ส่ง แล้วลองใหม่" },
  shopee_message_is_censored: { title: "ข้อความมีคำต้องห้ามของ Shopee", cause: "Shopee ตรวจพบคำที่ไม่อนุญาต", action: "แก้ข้อความแล้วส่งใหม่" },
  shopee_error_blocked: { title: "ลูกค้าบล็อกร้าน", cause: "ลูกค้าคนนี้บล็อกร้านไว้", action: "ส่งหาลูกค้าคนนี้ไม่ได้" },
  shopee_error_sender_block_receiver: { title: "ร้านบล็อกลูกค้าคนนี้ไว้", cause: "ร้านบล็อกลูกค้าคนนี้อยู่", action: "ปลดบล็อกใน Shopee ก่อน หรือไม่ต้องส่ง" },
  shopee_invalid_to_id: { title: "ผู้รับไม่ถูกต้อง", cause: "ไม่พบ user id ของลูกค้า", action: "ตรวจข้อมูลลูกค้าของแชทนี้" },
  shopee_reach_5_message_limit: { title: "ส่งครบ 5 ข้อความแล้ว", cause: "Shopee ให้ส่งได้ไม่เกิน 5 ข้อความก่อนลูกค้าตอบกลับ", action: "รอให้ลูกค้าตอบก่อน" },
  shopee_source_ip_undeclared: { title: "Shopee ไม่รู้จัก IP เครื่องนี้", cause: "IP ที่ส่งออกยังไม่อยู่ใน IP Whitelist ของ Shopee Open Platform", action: "แจ้งพี่ Sellcenter ให้เพิ่ม IP เครื่องนี้ใน whitelist (และแจ้งใหม่ทุกครั้งที่ IP เปลี่ยน)" },
  shopee_param_error: { title: "ข้อมูลที่ส่งไม่ครบ", cause: "Shopee ตอบว่าพารามิเตอร์ผิดหรือขาด", action: "ลองส่งใหม่ ถ้ายังเป็นอีกให้แจ้งทีมพร้อมรหัสนี้" },
};

export function describeSendFailure(code: string): SendFailureInfo {
  return TEXT[code] || { title: "ส่งข้อความไม่สำเร็จ", cause: "ระบบยังไม่รู้จักสาเหตุนี้", action: `ตรวจรายละเอียดแล้วลองใหม่ ถ้ายังเป็นอีกให้แจ้งทีมพร้อมรหัส ${code}` };
}
