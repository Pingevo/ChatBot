import "server-only";
import { createHash, createHmac } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { getCollection } from "../db/mongoClient";
import { productService, type ProductDoc } from "./productService";
import { conversationService } from "./conversationService";
import { systemConfigService } from "./systemConfigService";
import { SHOPEE_PROVIDER_ERRORS } from "@/lib/shopeeSendErrors";
import { toProductCard } from "./messageMediaParser";
import type { ProductCard } from "@/lib/types";

type OutboundType = "text" | "image" | "video" | "sticker" | "item";

export type ShopeeOutboundInput = {
  type: OutboundType;
  text?: string;
  file?: File;
  stickerId?: string;
  stickerPackageId?: string;
  itemId?: string;
};

export type ShopeeOutboundResult =
  | {
      state: "sent";
      type: OutboundType;
      text: string;
      media?: { url: string; thumb_url?: string };
      products?: ProductCard[];
      providerMessageId?: string;
    }
  | { state: "failed"; code: string; providerError?: string; providerHttpStatus?: number; providerRequestId?: string }
  | { state: "unknown"; code: "delivery_unknown"; providerError?: string; providerHttpStatus?: number; providerRequestId?: string };

export async function readShopeeOutboundInput(request: Request): Promise<{ requestId: string; input: ShopeeOutboundInput; force: boolean }> {
  const contentType = request.headers.get("content-type") || "";
  let source: Record<string, unknown>;
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const values: Record<string, unknown> = {};
    for (const key of ["request_id", "type", "text", "sticker_id", "sticker_package_id", "item_id", "force"]) {
      const value = form.get(key);
      if (typeof value === "string") values[key] = value;
    }
    const file = form.get("file");
    if (typeof File !== "undefined" && file instanceof File) values.file = file;
    source = values;
  } else {
    let body: unknown;
    try { body = await request.json(); } catch { throw new Error("invalid_body"); }
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid_body");
    source = body as Record<string, unknown>;
  }

  const legacyText = source.type === undefined && typeof source.text === "string";
  const type = source.type ?? (legacyText ? "text" : undefined);
  if (type !== "text" && type !== "image" && type !== "video" && type !== "sticker" && type !== "item") {
    throw new Error("unsupported_message_type");
  }
  const requestId = typeof source.request_id === "string" && source.request_id
    ? source.request_id
    : "";
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) throw new Error("invalid_request_id");
  const input: ShopeeOutboundInput = { type };
  if (typeof source.text === "string") input.text = source.text;
  if (typeof source.file !== "undefined") {
    if (typeof File === "undefined" || !(source.file instanceof File)) throw new Error("file_required");
    input.file = source.file;
  }
  if (typeof source.sticker_id === "string") input.stickerId = source.sticker_id;
  if (typeof source.sticker_package_id === "string") input.stickerPackageId = source.sticker_package_id;
  if (typeof source.item_id === "string" || typeof source.item_id === "number") input.itemId = String(source.item_id);
  return { requestId, input, force: source.force === true || source.force === "true" };
}

export function outboundMessageId(requestId: string): string {
  return `shp_${createHash("sha256").update(`shopee-send:${requestId}`).digest("hex").slice(0, 40)}`;
}

export async function isShopeeConsoleSendEnabled(): Promise<boolean> {
  return (await systemConfigService.getSystemConfig(true)).shopee_console_send_enabled === true;
}

interface TokenResponse {
  success?: boolean;
  shop_id?: number | string;
  partner_id?: number | string;
  access_token?: string;
  error?: string;
}

interface ShopeeResponse {
  error?: string;
  message?: string;
  request_id?: string;
  response?: Record<string, unknown>;
}

interface Credentials {
  accessToken: string;
  partnerId: string;
  partnerKey: string;
  shopId: string;
}

interface OperationDoc {
  _id: string;
  conversation_id: string;
  shop_id: string;
  payload_hash: string;
  message_type: OutboundType;
  state: "sending" | "sent" | "failed" | "unknown";
  result_code?: string;
  provider_error?: string;
  provider_http_status?: number;
  provider_request_id?: string;
  provider_message_id?: string;
  media_url?: string;
  media_thumb_url?: string;
  created_at: Date;
  updated_at: Date;
}

const TOKEN_URL = "https://digital.in.th/api/shopee/token";
const SHOPEE_HOST = "https://partner.shopeemobile.com";
const OPERATIONS_COLLECTION = "shopee_outbound_operations";
const IMAGE_LIMIT = 10 * 1024 * 1024;
const VIDEO_LIMIT = 30 * 1024 * 1024;

function _numericId(value: unknown): string | null {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? String(n) : null;
}

function _isImageFile(file: File): boolean {
  const ext = file.name.split(".").pop()?.toLowerCase();
  return file.type === "image/jpeg" && (ext === "jpg" || ext === "jpeg")
    || file.type === "image/png" && ext === "png"
    || file.type === "image/gif" && ext === "gif";
}

function _isStickerCode(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,80}$/.test(value);
}

async function _validateFile(input: ShopeeOutboundInput): Promise<Uint8Array | null> {
  if (input.type !== "image" && input.type !== "video") return null;
  const file = input.file;
  if (!file || file.size === 0) throw new Error("file_required");
  if (input.type === "image") {
    if (file.size > IMAGE_LIMIT || !_isImageFile(file)) throw new Error("invalid_image");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    const gif = String.fromCharCode(...bytes.slice(0, 6)) === "GIF87a"
      || String.fromCharCode(...bytes.slice(0, 6)) === "GIF89a";
    if (!jpeg && !png && !gif) throw new Error("invalid_image");
    return bytes;
  }
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (file.size > VIDEO_LIMIT || !file.type.startsWith("video/") || !["mp4", "mov", "m4v"].includes(ext || "")) {
    throw new Error("invalid_video");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const duration = _videoDurationSeconds(bytes);
  if (duration === null || duration < 1 || duration > 180) throw new Error("invalid_video_duration");
  return bytes;
}

function _videoDurationSeconds(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const findMovieHeader = (start: number, end: number, seekHeader: boolean): number | null => {
    let offset = start;
    while (offset + 8 <= end) {
      let size = view.getUint32(offset);
      const name = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
      let headerSize = 8;
      if (size === 1) {
        if (offset + 16 > end) return null;
        const extendedSize = view.getBigUint64(offset + 8);
        if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) return null;
        size = Number(extendedSize);
        headerSize = 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (size < headerSize || offset + size > end) return null;
      const payload = offset + headerSize;
      const boxEnd = offset + size;
      if (seekHeader && name === "mvhd") {
        const version = bytes[payload];
        const scaleOffset = payload + (version === 1 ? 20 : 12);
        const durationOffset = payload + (version === 1 ? 24 : 16);
        const durationSize = version === 1 ? 8 : 4;
        if ((version !== 0 && version !== 1) || durationOffset + durationSize > boxEnd) return null;
        const scale = view.getUint32(scaleOffset);
        const duration = version === 1 ? Number(view.getBigUint64(durationOffset)) : view.getUint32(durationOffset);
        return scale > 0 && Number.isFinite(duration) ? duration / scale : null;
      }
      if (name === "moov") {
        const duration = findMovieHeader(payload, boxEnd, true);
        if (duration !== null) return duration;
      }
      offset = boxEnd;
    }
    return null;
  };
  return findMovieHeader(0, bytes.byteLength, false);
}

async function _credentials(shopId: string): Promise<Credentials> {
  const serviceToken = process.env.SHOPEE_TOKEN_API_SERVICE_TOKEN;
  const partnerKey = process.env.SHOPEE_PARTNER_KEY;
  if (!serviceToken || !partnerKey) throw new Error("credentials_unavailable");

  const url = new URL(TOKEN_URL);
  url.searchParams.set("shop_id", shopId);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { "x-service-token": serviceToken, "cache-control": "no-store" },
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw new Error("token_provider_unavailable");
  }

  let body: TokenResponse | null = null;
  try { body = await response.json() as TokenResponse; } catch { /* sanitized below */ }
  const tokenShopId = _numericId(body?.shop_id);
  const partnerId = _numericId(body?.partner_id);
  if (!response.ok) {
    const ipDenied = response.status === 403 && /IP/i.test(String(body?.error || ""));
    throw new Error(response.status === 401 ? "token_provider_unauthorized"
      : ipDenied ? "token_provider_ip_denied"
      : response.status === 403 ? "token_provider_forbidden"
      : response.status === 404 ? "token_provider_shop_unknown"
      : response.status === 503 ? "token_provider_reauth" : "token_provider_rejected");
  }
  if (body?.success !== true || !body.access_token || tokenShopId !== shopId || !partnerId) {
    throw new Error("token_provider_rejected");
  }
  return { accessToken: body.access_token, partnerId, partnerKey, shopId };
}

function _signedUrl(path: string, credentials: Credentials, query?: Record<string, string>): URL {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const base = credentials.partnerId + path + timestamp + credentials.accessToken + credentials.shopId;
  const sign = createHmac("sha256", credentials.partnerKey).update(base).digest("hex");
  const url = new URL(path, SHOPEE_HOST);
  url.searchParams.set("partner_id", credentials.partnerId);
  url.searchParams.set("timestamp", timestamp);
  url.searchParams.set("access_token", credentials.accessToken);
  url.searchParams.set("shop_id", credentials.shopId);
  url.searchParams.set("sign", sign);
  for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value);
  return url;
}

async function _requestShopee(url: URL, method: "GET" | "POST", body?: Uint8Array, contentType?: string, timeout = 20000): Promise<{ ok: boolean; status: number; body: ShopeeResponse | null }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, {
      method,
      timeout,
      headers: body ? { "content-type": contentType || "application/json", "content-length": String(body.byteLength) } : undefined,
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { req.destroy(new Error("provider_response_too_large")); return; }
        chunks.push(chunk);
      });
      response.on("end", () => {
        let parsed: ShopeeResponse | null = null;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ShopeeResponse; } catch { /* invalid response */ }
        const status = response.statusCode || 0;
        resolve({ ok: status >= 200 && status < 300, status, body: parsed });
      });
      response.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("provider_timeout")));
    if (body) req.write(body);
    req.end();
  });
}

async function _multipartFile(file: File): Promise<{ body: Uint8Array; contentType: string }> {
  const form = new FormData();
  form.set("file", new Blob([await file.arrayBuffer()], { type: file.type }), file.name);
  const encoded = new Response(form);
  return { body: new Uint8Array(await encoded.arrayBuffer()), contentType: encoded.headers.get("content-type") || "" };
}

async function _uploadImage(file: File, credentials: Credentials): Promise<{ url: string; thumbnail?: string }> {
  const upload = await _multipartFile(file);
  if (!(await isShopeeConsoleSendEnabled())) throw new Error("live_send_disabled");
  let resultResponse: { ok: boolean; body: ShopeeResponse | null };
  try {
    resultResponse = await _requestShopee(_signedUrl("/api/v2/sellerchat/upload_image", credentials), "POST", upload.body, upload.contentType, 30000);
  } catch { throw new Error("image_upload_failed"); }
  const body = resultResponse.body;
  const result = body?.response as { url?: unknown; thumbnail?: unknown } | undefined;
  if (!resultResponse.ok || (body?.error && body.error !== "-") || typeof result?.url !== "string" || !result.url.startsWith("https://")) {
    throw new Error("image_upload_failed");
  }
  return { url: result.url, thumbnail: typeof result.thumbnail === "string" ? result.thumbnail : undefined };
}

async function _uploadVideo(file: File, credentials: Credentials): Promise<{ url: string; thumbnail?: string }> {
  const uploadFile = await _multipartFile(file);
  if (!(await isShopeeConsoleSendEnabled())) throw new Error("live_send_disabled");
  let upload: { ok: boolean; body: ShopeeResponse | null };
  try {
    upload = await _requestShopee(_signedUrl("/api/v2/sellerchat/upload_video", credentials), "POST", uploadFile.body, uploadFile.contentType, 45000);
  } catch { throw new Error("video_upload_failed"); }
  const uploadBody = upload.body;
  const vid = (uploadBody?.response as { vid?: unknown } | undefined)?.vid;
  if (!upload.ok || (uploadBody?.error && uploadBody.error !== "-") || typeof vid !== "string" || !vid) {
    throw new Error("video_upload_failed");
  }

  const statusDeadline = Date.now() + 45_000;
  for (let attempt = 0; attempt < 20 && Date.now() < statusDeadline; attempt += 1) {
    let resultResponse: { ok: boolean; body: ShopeeResponse | null };
    if (!(await isShopeeConsoleSendEnabled())) throw new Error("live_send_disabled");
    try {
      resultResponse = await _requestShopee(_signedUrl("/api/v2/sellerchat/get_video_upload_result", credentials, { vid }), "GET", undefined, undefined, 12000);
    } catch { throw new Error("video_upload_status_failed"); }
    const resultBody = resultResponse.body;
    const result = resultBody?.response as { status?: unknown; video?: unknown; thumbnail?: unknown } | undefined;
    if (!resultResponse.ok || (resultBody?.error && resultBody.error !== "-")) throw new Error("video_upload_status_failed");
    if (result?.status === "failed") throw new Error("video_upload_failed");
    if (result?.status === "successful" && typeof result.video === "string" && result.video.startsWith("https://")) {
      return { url: result.video, thumbnail: typeof result.thumbnail === "string" ? result.thumbnail : undefined };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("video_upload_pending");
}

function _productBelongsToConversation(product: ProductDoc, shopId: string, shopName: string): boolean {
  const productShopId = _numericId(product.shopid ?? product.shop_id);
  const productShopName = String(product.shopname ?? product.shop_name ?? "").trim();
  return productShopId ? productShopId === shopId : (!!productShopName && productShopName === shopName);
}

function _payloadHash(input: ShopeeOutboundInput, bytes: Uint8Array | null): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ type: input.type, text: input.text || "", stickerId: input.stickerId || "", stickerPackageId: input.stickerPackageId || "", itemId: input.itemId || "" }));
  if (bytes) hash.update(bytes);
  return hash.digest("hex");
}

function _resultFromExisting(type: OutboundType, text: string, existing: OperationDoc): ShopeeOutboundResult {
  if (existing.state === "sent") {
    return {
      state: "sent",
      type,
      text: text || (type === "item" ? "(สินค้า)" : type === "sticker" ? "(สติกเกอร์)" : `(${type})`),
      providerMessageId: existing.provider_message_id,
      media: existing.media_url ? { url: existing.media_url, thumb_url: existing.media_thumb_url } : undefined,
    };
  }
  if (existing.state === "unknown" || existing.state === "sending") {
    return { state: "unknown", code: "delivery_unknown", providerError: existing.provider_error, providerHttpStatus: existing.provider_http_status, providerRequestId: existing.provider_request_id };
  }
  return { state: "failed", code: existing.result_code || "send_failed", providerError: existing.provider_error, providerHttpStatus: existing.provider_http_status, providerRequestId: existing.provider_request_id };
}

export async function sendShopeeMessage(opts: {
  conversationId: string;
  requestId: string;
  input: ShopeeOutboundInput;
}): Promise<ShopeeOutboundResult> {
  const requestId = opts.requestId.trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) throw new Error("invalid_request_id");
  const operationId = createHash("sha256").update(`shopee-send:${requestId}`).digest("hex");
  const config = await systemConfigService.getSystemConfig(true);
  if (config.shopee_console_send_enabled !== true) return { state: "failed", code: "live_send_disabled" };

  const conversation = await conversationService.getConversation(opts.conversationId);
  if (!conversation || conversation.platform !== "shopee") return { state: "failed", code: "shopee_conversation_required" };
  const shopId = _numericId(conversation.shop_id);
  const toId = _numericId(conversation.customer_id);
  if (!shopId || !toId) return { state: "failed", code: "conversation_recipient_invalid" };

  let bytes: Uint8Array | null;
  try {
    bytes = await _validateFile(opts.input);
  } catch (e) {
    const allowed = new Set(["file_required", "invalid_image", "invalid_video", "invalid_video_duration"]);
    return { state: "failed", code: e instanceof Error && allowed.has(e.message) ? e.message : "invalid_file" };
  }
  if (opts.input.type === "sticker" && (!opts.input.stickerId || !opts.input.stickerPackageId
    || !_isStickerCode(opts.input.stickerId) || !_isStickerCode(opts.input.stickerPackageId))) {
    return { state: "failed", code: "sticker_required" };
  }
  const payloadHash = _payloadHash(opts.input, bytes);
  let product: ProductDoc | null = null;
  if (opts.input.type === "item") {
    const itemId = _numericId(opts.input.itemId);
    if (!itemId) return { state: "failed", code: "item_id_invalid" };
    product = await productService.getProduct({ platform: "shopee", itemId });
    if (!product || !_productBelongsToConversation(product, shopId, conversation.shop_name)) {
      return { state: "failed", code: "item_shop_mismatch" };
    }
  }
  const productCard = product
    ? [{ ...toProductCard(product as Record<string, unknown>, "shopee"), shop: product.shopname || product.shop_name || conversation.shop_name }]
    : undefined;

  const operations = await getCollection<OperationDoc>(OPERATIONS_COLLECTION);
  const existing = await operations.findOne({ _id: operationId });
  if (existing) {
    console.info("[shopee-send] replay", { request_id: requestId, state: existing.state, code: existing.result_code });
    if (existing.conversation_id !== opts.conversationId || existing.payload_hash !== payloadHash) {
      return { state: "failed", code: "request_id_conflict" };
    }
    const prior = _resultFromExisting(opts.input.type, opts.input.text || "", existing);
    if (prior.state === "sent" && productCard) prior.products = productCard;
    return prior;
  }

  const operation: OperationDoc = {
    _id: operationId,
    conversation_id: opts.conversationId,
    shop_id: shopId,
    payload_hash: payloadHash,
    message_type: opts.input.type,
    state: "sending",
    created_at: new Date(),
    updated_at: new Date(),
  };
  try { await operations.insertOne(operation); } catch {
    const raced = await operations.findOne({ _id: operationId });
    if (raced) {
      if (raced.conversation_id !== opts.conversationId || raced.payload_hash !== payloadHash) {
        return { state: "failed", code: "request_id_conflict" };
      }
      return _resultFromExisting(opts.input.type, opts.input.text || "", raced);
    }
    throw new Error("send_operation_unavailable");
  }

  const finish = async (
    state: OperationDoc["state"],
    code?: string,
    providerMessageId?: string,
    sentMedia?: { url: string; thumb_url?: string },
    diagnostic?: { providerError?: string; providerHttpStatus?: number; providerRequestId?: string },
  ) => {
    await operations.updateOne({ _id: operationId, state: "sending" }, {
      $set: {
        state,
        result_code: code,
        provider_message_id: providerMessageId,
        media_url: sentMedia?.url,
        media_thumb_url: sentMedia?.thumb_url,
        provider_error: diagnostic?.providerError,
        provider_http_status: diagnostic?.providerHttpStatus,
        provider_request_id: diagnostic?.providerRequestId,
        updated_at: new Date(),
      },
    });
  };

  let providerAccepted = false;
  try {
    if (!(await isShopeeConsoleSendEnabled())) {
      await finish("failed", "live_send_disabled");
      return { state: "failed", code: "live_send_disabled" };
    }
    const credentials = await _credentials(shopId);
    const configBeforeSend = await systemConfigService.getSystemConfig(true);
    if (configBeforeSend.shopee_console_send_enabled !== true) {
      await finish("failed", "live_send_disabled");
      return { state: "failed", code: "live_send_disabled" };
    }

    const messageType = opts.input.type;
    let text = opts.input.type === "text"
      ? (opts.input.text || "").trim()
      : opts.input.type === "item" ? "(สินค้า)"
      : opts.input.type === "sticker" ? "(สติกเกอร์)"
      : opts.input.type === "image" ? "(รูปภาพ)" : "(วิดีโอ)";
    let content: Record<string, unknown>;
    let media: { url: string; thumb_url?: string } | undefined;
    if (opts.input.type === "text") {
      if (!text) throw new Error("text_required");
      content = { text };
    } else if (opts.input.type === "image") {
      const uploaded = await _uploadImage(opts.input.file!, credentials);
      media = { url: uploaded.url, thumb_url: uploaded.thumbnail };
      content = { image_url: uploaded.url };
    } else if (opts.input.type === "video") {
      const uploaded = await _uploadVideo(opts.input.file!, credentials);
      media = { url: uploaded.url, thumb_url: uploaded.thumbnail };
      content = { video_url: uploaded.url };
    } else if (opts.input.type === "sticker") {
      media = {
        url: `https://deo.shopeemobile.com/shopee/shopee-sticker-live-th/packs/${opts.input.stickerPackageId}/${opts.input.stickerId}@1x.png`,
      };
      content = { sticker_id: opts.input.stickerId, sticker_package_id: opts.input.stickerPackageId };
    } else {
      const itemId = _numericId(opts.input.itemId);
      if (!itemId) throw new Error("item_id_invalid");
      content = { item_id: Number(itemId) };
      text = "(สินค้า)";
    }

    const postMessage = async (activeCredentials: Credentials) => {
      if (!(await isShopeeConsoleSendEnabled())) throw new Error("live_send_disabled");
      const url = _signedUrl("/api/v2/sellerchat/send_message", activeCredentials);
      const body = { to_id: Number(toId), message_type: messageType, content };
      console.info("[shopee-send] request", {
        request_id: requestId,
        method: "POST",
        host: url.host,
        path: url.pathname,
        sign_base_order: ["partner_id", "path", "timestamp", "access_token", "shop_id"],
        query: {
          partner_id: activeCredentials.partnerId,
          timestamp: url.searchParams.get("timestamp"),
          access_token: "[redacted]",
          access_token_sha256: createHash("sha256").update(activeCredentials.accessToken).digest("hex").slice(0, 12),
          shop_id: activeCredentials.shopId,
          sign: "[redacted]",
        },
        partner_key_sha256: createHash("sha256").update(activeCredentials.partnerKey).digest("hex").slice(0, 12),
        body: {
          to_id: body.to_id,
          message_type: body.message_type,
          content_fields: Object.keys(content),
          text_length: typeof content.text === "string" ? content.text.length : undefined,
        },
      });
      try {
        const result = await _requestShopee(
          url, "POST",
          Buffer.from(JSON.stringify(body)),
          "application/json", 20000,
        );
        console.info("[shopee-send] response", {
          request_id: requestId,
          http_status: result.status,
          error: result.body?.error,
          provider_request_id: result.body?.request_id,
        });
        return result;
      } catch {
        console.warn("[shopee-send] network_error", { request_id: requestId, path: url.pathname });
        return null;
      }
    };
    let provider = await postMessage(credentials);
    if (!provider) {
      await finish("unknown", "delivery_unknown");
      return { state: "unknown", code: "delivery_unknown" };
    }
    const firstError = String(provider.body?.error || "").toLowerCase();
    if (firstError === "error_auth" || firstError === "invalid_access_token") {
      if (!(await isShopeeConsoleSendEnabled())) {
        await finish("failed", "live_send_disabled");
        return { state: "failed", code: "live_send_disabled" };
      }
      provider = await postMessage(await _credentials(shopId));
      if (!provider) {
        await finish("unknown", "delivery_unknown");
        return { state: "unknown", code: "delivery_unknown" };
      }
    }
    const providerError = String(provider.body?.error || "");
    const providerRequestId = typeof provider.body?.request_id === "string" && provider.body.request_id.length <= 128
      ? provider.body.request_id : undefined;
    if (providerError && providerError !== "-") {
      const lower = providerError.toLowerCase();
      const safeError = /^[a-z0-9_]{1,80}$/i.test(providerError) ? providerError : undefined;
      const diagnostic = { providerError: safeError, providerHttpStatus: provider.status, providerRequestId };
      if ((SHOPEE_PROVIDER_ERRORS as readonly string[]).includes(lower)) {
        const code = `shopee_${lower}`;
        await finish("failed", code, undefined, undefined, diagnostic);
        return { state: "failed", code, ...diagnostic };
      }
      await finish("unknown", "delivery_unknown", undefined, undefined, diagnostic);
      return { state: "unknown", code: "delivery_unknown", ...diagnostic };
    }
    if (!provider.ok) {
      await finish("unknown", "delivery_unknown", undefined, undefined, { providerHttpStatus: provider.status, providerRequestId });
      return { state: "unknown", code: "delivery_unknown", providerHttpStatus: provider.status, providerRequestId };
    }
    if (!provider.body?.response || Object.keys(provider.body.response).length === 0) {
      await finish("unknown", "delivery_unknown");
      return { state: "unknown", code: "delivery_unknown" };
    }
    const providerMessageId = typeof provider.body.response.message_id === "string" || typeof provider.body.response.message_id === "number"
      ? String(provider.body.response.message_id) : undefined;
    if (!providerMessageId) {
      await finish("unknown", "delivery_unknown");
      return { state: "unknown", code: "delivery_unknown" };
    }
    providerAccepted = true;
    await finish("sent", undefined, providerMessageId, media);
    return { state: "sent", type: messageType, text, media, products: productCard, providerMessageId };
  } catch (error) {
    const allowedCodes = new Set(["live_send_disabled", "credentials_unavailable", "token_provider_unavailable", "token_provider_unauthorized", "token_provider_ip_denied", "token_provider_forbidden", "token_provider_shop_unknown", "token_provider_reauth", "token_provider_rejected", "file_required", "invalid_image", "invalid_video", "invalid_video_duration", "image_upload_failed", "video_upload_failed", "video_upload_status_failed", "video_upload_pending", "text_required", "sticker_required", "item_id_invalid"]);
    const code = error instanceof Error && allowedCodes.has(error.message) ? error.message : "send_failed";
    if (providerAccepted) {
      try { await finish("unknown", "delivery_unknown"); } catch { /* keep sending state for safe retry */ }
      return { state: "unknown", code: "delivery_unknown" };
    }
    await finish("failed", code);
    return { state: "failed", code };
  }
}
