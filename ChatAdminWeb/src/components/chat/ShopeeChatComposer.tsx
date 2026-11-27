"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Film, ImagePlus, Loader2, Send, Smile, Sticker, X } from "lucide-react";
import { newChatRequestId } from "@/lib/services";
import { api } from "@/lib/apiClient";
import type { ChatSendInput, Platform } from "@/lib/types";
import { describeSendFailure, type SendFailureInfo } from "@/lib/shopeeSendErrors";

const EMOJI = ["😊", "😂", "🥰", "🙏", "👍", "❤️", "🎉", "✨", "😅", "😉", "💙", "📦"];

interface QuickReply {
  quick_reply_id: string;
  title: string;
  body: string;
}

interface ImageAttachment { id: string; file: File; requestId?: string }

export function removeAttachmentById<T extends { id: string }>(attachments: T[], id: string): T[] {
  return attachments.filter((attachment) => attachment.id !== id);
}

export async function sendAttachmentsSequentially<T>(attachments: T[], send: (attachment: T) => Promise<unknown>, onSent: (attachment: T) => void) {
  for (const attachment of attachments) {
    const result = await send(attachment);
    if (result === false) throw new Error("ส่งภาพไม่สำเร็จ");
    onSent(attachment);
  }
}

interface Props {
  platform: Platform;
  liveSendEnabled: boolean;
  onSend: (payload: ChatSendInput, modeOverride?: boolean) => Promise<unknown> | void;
  onRefreshSendMode?: () => Promise<boolean>;
  quickReplies?: QuickReply[];
  placeholder?: string;
  disabled?: boolean;
}

export function ShopeeChatComposer({ platform, liveSendEnabled, onSend, onRefreshSendMode, quickReplies = [], placeholder, disabled = false }: Props) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [filePreviewUrl, setFilePreviewUrl] = useState<string | null>(null);
  const [imagePreviewUrls, setImagePreviewUrls] = useState<Record<string, string>>({});
  const [stickerOpen, setStickerOpen] = useState(false);
  const [stickerId, setStickerId] = useState("");
  const [stickerPackageId, setStickerPackageId] = useState("");
  const [stickerPacks, setStickerPacks] = useState<{ pid: string; name: string }[]>([]);
  const [stickers, setStickers] = useState<{ sid: string; url: string }[]>([]);
  const [stickerLoading, setStickerLoading] = useState(false);
  const [stickerError, setStickerError] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [error, setError] = useState("");
  const [sendFailure, setSendFailure] = useState<(SendFailureInfo & { code?: string; providerError?: string; providerHttpStatus?: number; providerRequestId?: string; expectedMode?: boolean }) | null>(null);
  const [busy, setBusy] = useState(false);
  const failureCloseRef = useRef<HTMLButtonElement>(null);
  const pendingRequestRef = useRef<{ signature: string; requestId: string } | null>(null);
  const failedPayloadRef = useRef<ChatSendInput | null>(null);
  const attemptedImageRef = useRef<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!file) { setFilePreviewUrl(null); return; }
    const url = URL.createObjectURL(file);
    setFilePreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  useEffect(() => {
    const urls = Object.fromEntries(images.map((image) => [image.id, URL.createObjectURL(image.file)]));
    setImagePreviewUrls(urls);
    return () => Object.values(urls).forEach((url) => URL.revokeObjectURL(url));
  }, [images]);
  useEffect(() => { if (sendFailure) failureCloseRef.current?.focus(); }, [sendFailure]);

  const canSelectMedia = platform === "shopee" && !disabled;
  const canSendMedia = canSelectMedia && liveSendEnabled;

  function withRequestId(payload: ChatSendInput): ChatSendInput {
    const signature = payload.type === "text" ? JSON.stringify([payload.type, payload.text])
      : payload.type === "image" || payload.type === "video" ? JSON.stringify([payload.type, payload.file.name, payload.file.size, payload.file.lastModified])
      : payload.type === "sticker" ? JSON.stringify([payload.type, payload.sticker_package_id, payload.sticker_id])
      : payload.type === "item" ? JSON.stringify([payload.type, payload.item_id]) : "";
    if (pendingRequestRef.current?.signature !== signature) {
      pendingRequestRef.current = { signature, requestId: newChatRequestId() };
    }
    return { ...payload, request_id: pendingRequestRef.current.requestId } as ChatSendInput;
  }

  async function submit(source: ChatSendInput, retry = false, modeOverride?: boolean) {
    if (busy || disabled) return;
    setBusy(true);
    setError("");
    setSendFailure(null);
    const payload = retry ? source : withRequestId(source);
    try {
      await onSend(payload, modeOverride);
      pendingRequestRef.current = null;
      failedPayloadRef.current = null;
      setText("");
      setFile(null);
      setStickerId("");
      setStickerPackageId("");
      setStickerOpen(false);
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    } catch (e) {
      failedPayloadRef.current = payload;
      const body = (e as { response?: { data?: { detail?: unknown; error?: unknown; message?: unknown; code?: unknown; provider_error?: unknown; provider_http_status?: unknown; provider_request_id?: unknown } } })?.response?.data;
      const detail = body?.detail ?? body?.error ?? body?.message;
      const code = typeof body?.code === "string" ? body.code : undefined;
      setSendFailure(code ? { ...describeSendFailure(code), code, expectedMode: modeOverride ?? liveSendEnabled,
        providerError: typeof body?.provider_error === "string" ? body.provider_error : undefined,
        providerHttpStatus: typeof body?.provider_http_status === "number" ? body.provider_http_status : undefined,
        providerRequestId: typeof body?.provider_request_id === "string" ? body.provider_request_id : undefined,
      } : {
        title: "ส่งข้อความไม่สำเร็จ",
        cause: typeof detail === "string" ? detail : e instanceof Error ? e.message : "ระบบไม่สามารถระบุสาเหตุได้",
        action: "ตรวจสถานะการส่งในแชทก่อนลองใหม่ หากยังเกิดอีกให้แจ้งทีมดูแลระบบ",
      });
    } finally {
      setBusy(false);
    }
  }

  async function submitImages(newRequestForImage?: string, modeOverride?: boolean) {
    if (busy || disabled || !canSendMedia || images.length === 0) return;
    setBusy(true);
    setError("");
    setSendFailure(null);
    try {
      await sendAttachmentsSequentially(images, async (image) => {
        attemptedImageRef.current = image.id;
        const requestId = image.id === newRequestForImage ? newChatRequestId() : image.requestId || newChatRequestId();
        if (image.requestId !== requestId) setImages((current) => current.map((item) => item.id === image.id ? { ...item, requestId } : item));
        const result = await onSend({ type: "image", file: image.file, request_id: requestId }, modeOverride);
        return result;
      }, (image) => {
        attemptedImageRef.current = null;
        setImages((current) => removeAttachmentById(current, image.id));
      });
    } catch (e) {
      const body = (e as { response?: { data?: { detail?: unknown; error?: unknown; message?: unknown; code?: unknown; provider_error?: unknown; provider_http_status?: unknown; provider_request_id?: unknown } } })?.response?.data;
      const detail = body?.detail ?? body?.error ?? body?.message;
      const code = typeof body?.code === "string" ? body.code : undefined;
      setSendFailure(code ? { ...describeSendFailure(code), code, expectedMode: modeOverride ?? liveSendEnabled,
        providerError: typeof body?.provider_error === "string" ? body.provider_error : undefined,
        providerHttpStatus: typeof body?.provider_http_status === "number" ? body.provider_http_status : undefined,
        providerRequestId: typeof body?.provider_request_id === "string" ? body.provider_request_id : undefined,
      } : {
        title: "ส่งข้อความไม่สำเร็จ",
        cause: typeof detail === "string" ? detail : e instanceof Error ? e.message : "ระบบไม่สามารถระบุสาเหตุได้",
        action: "ตรวจสถานะการส่งในแชทก่อนลองใหม่ หากยังเกิดอีกให้แจ้งทีมดูแลระบบ",
      });
    } finally {
      setBusy(false);
    }
  }

  async function openStickerPicker() {
    if (stickerOpen) { setStickerOpen(false); return; }
    setStickerOpen(true);
    setEmojiOpen(false);
    setError("");
    if (stickerPacks.length) return;
    setStickerLoading(true);
    setStickerError("");
    try {
      const response = await api().get<{ packs: { pid: string; name: string }[] }>("/system/shopee-stickers");
      setStickerPacks(response.data.packs);
      if (!response.data.packs.length) setStickerError("ยังไม่มีชุดสติกเกอร์ที่ใช้ได้สำหรับร้านไทย");
    } catch {
      setStickerError("โหลดชุดสติกเกอร์ไม่ได้ กรุณาลองใหม่");
    } finally { setStickerLoading(false); }
  }

  async function chooseStickerPack(pid: string) {
    setStickerPackageId(pid);
    setStickerId("");
    setStickers([]);
    setStickerLoading(true);
    setStickerError("");
    try {
      const response = await api().get<{ stickers: { sid: string; url: string }[] }>("/system/shopee-stickers", { params: { pack_id: pid } });
      setStickers(response.data.stickers);
      if (!response.data.stickers.length) setStickerError("ชุดนี้ไม่มีภาพสติกเกอร์ที่ระบบอ่านได้");
    } catch {
      setStickerError("โหลดภาพสติกเกอร์ไม่ได้ กรุณาลองเลือกชุดใหม่");
    } finally { setStickerLoading(false); }
  }

  function chooseFile(kind: "image" | "video", selected: FileList | File | undefined) {
    setError("");
    if (!selected) return;
    if (kind === "image") {
      const files = selected instanceof File ? [selected] : Array.from(selected);
      const valid = files.filter((image) => {
        const ext = image.name.split(".").pop()?.toLowerCase();
        return image.size <= 10 * 1024 * 1024 && ["jpg", "jpeg", "png", "gif"].includes(ext || "") && image.type.startsWith("image/");
      });
      if (valid.length !== files.length) setError("บางรูปไม่ถูกเพิ่ม: รองรับ JPG, PNG หรือ GIF ขนาดไม่เกิน 10 MB ต่อรูป");
      if (valid.length) {
        setImages((current) => [...current, ...valid.map((image) => ({ id: newChatRequestId(), file: image }))]);
        setStickerOpen(false);
      }
      return;
    }
    if (!(selected instanceof File)) return;
    if (images.length) { setError("เลือกส่งรูปหรือวิดีโออย่างใดอย่างหนึ่ง"); return; }
    const ext = selected.name.split(".").pop()?.toLowerCase();
    if (selected.size > 30 * 1024 * 1024 || !["mp4", "mov", "m4v"].includes(ext || "") || !selected.type.startsWith("video/")) {
      setError("วิดีโอต้องเป็น MP4, MOV หรือ M4V และขนาดไม่เกิน 30 MB");
      return;
    }
    const source = URL.createObjectURL(selected);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(source);
      if (!Number.isFinite(video.duration) || video.duration < 1 || video.duration > 180) {
        setError("วิดีโอต้องมีความยาว 1–180 วินาที");
        return;
      }
      setFile(selected);
    };
    video.onerror = () => {
      URL.revokeObjectURL(source);
      setError("อ่านความยาววิดีโอไม่ได้ กรุณาเลือกไฟล์วิดีโอที่รองรับ");
    };
    video.src = source;
  }

  function submitText(value = text) {
    const trimmed = value.trim();
    if (!trimmed) return;
    void submit({ type: "text", text: trimmed, request_id: "" });
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if ((file || images.length > 0 || stickerOpen) && !canSendMedia) {
      setError("สวิตช์ส่งจริงยังปิดอยู่ เลือกสื่อได้แต่ยังส่งไม่ได้");
      return;
    }
    if (images.length) {
      void submitImages();
    } else if (file) {
      void submit({ type: file.type.startsWith("video/") ? "video" : "image", file, request_id: "" });
    } else if (stickerOpen) {
      if (!stickerId.trim() || !stickerPackageId.trim()) {
        setError("กรุณาเลือกภาพสติกเกอร์ก่อนส่ง");
        return;
      }
      void submit({ type: "sticker", sticker_id: stickerId.trim(), sticker_package_id: stickerPackageId.trim(), request_id: "" });
    } else {
      submitText();
    }
  }

  async function retryFailedSend() {
    if (!sendFailure || busy || disabled) return;
    let modeOverride: boolean | undefined;
    if (sendFailure.code === "send_mode_changed") {
      if (!onRefreshSendMode) return;
      try {
        modeOverride = await onRefreshSendMode();
      } catch {
        setSendFailure({ ...sendFailure, title: "ตรวจสถานะสวิตช์ไม่ได้", cause: "โหลดสถานะส่งจริงล่าสุดไม่สำเร็จ", action: "ตรวจการเชื่อมต่อแล้วลองใหม่" });
        return;
      }
      if (modeOverride !== sendFailure.expectedMode) {
        setSendFailure({ ...sendFailure, title: "สถานะส่งจริงเปลี่ยนแล้ว",
          cause: modeOverride ? "ตอนนี้สวิตช์ส่งจริงเปิดอยู่" : "ตอนนี้สวิตช์ส่งจริงปิดอยู่",
          action: modeOverride ? "ปิดหน้าต่างนี้ ตรวจโหมดล่าสุด แล้วกดส่งอีกครั้งหากต้องการส่งจริง" : "เปิดสวิตช์ส่งจริงก่อน แล้วกดลองใหม่" });
        return;
      }
    }
    const definiteFailure = !!sendFailure.code && sendFailure.code !== "delivery_unknown" && sendFailure.code !== "send_mode_changed";
    if (images.length) {
      void submitImages(definiteFailure ? attemptedImageRef.current || undefined : undefined, modeOverride);
      return;
    }
    const failed = failedPayloadRef.current;
    if (!failed) return;
    const payload = definiteFailure ? { ...failed, request_id: newChatRequestId() } as ChatSendInput : failed;
    if (definiteFailure && pendingRequestRef.current?.requestId === failed.request_id) {
      pendingRequestRef.current.requestId = payload.request_id;
    }
    void submit(payload, true, modeOverride);
  }

  function insertEmoji(emoji: string) {
    const field = textareaRef.current;
    const start = field?.selectionStart ?? text.length;
    const end = field?.selectionEnd ?? text.length;
    const next = `${text.slice(0, start)}${emoji}${text.slice(end)}`;
    setText(next);
    setEmojiOpen(false);
    requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="p-3 border-t border-border bg-surface shrink-0">
      {quickReplies.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2 max-h-20 overflow-y-auto">
          {quickReplies.map((reply) => (
            <button key={reply.quick_reply_id} type="button" disabled={busy || disabled} onClick={() => submitText(reply.body)} title={reply.body}
              className="px-2.5 py-1 rounded-full border border-brand/30 bg-brand/5 text-xs text-brand hover:bg-brand/10 disabled:opacity-50 whitespace-nowrap max-w-[160px] truncate">
              {reply.title}
            </button>
          ))}
        </div>
      )}

      {platform === "shopee" && (
        <div role="status" aria-live="polite" className={`mb-2 text-[10px] ${liveSendEnabled ? "text-warning" : "text-text-subtle"}`}>
          {liveSendEnabled ? "โหมดส่งจริงเปิดอยู่ — กดส่งแล้วข้อความจะไปถึงลูกค้า" : "โหมดส่งจริงปิด — ข้อความบันทึกภายใน; เลือกสื่อดูตัวอย่างได้ แต่ส่งไม่ได้"}
        </div>
      )}

      {(file || images.length > 0 || stickerOpen) && (
        <div className="mb-2 rounded-lg border border-border bg-surface-2 p-2.5">
          {images.length ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {images.map((image) => (
                <div key={image.id} className="min-w-0 rounded-lg border border-border bg-surface p-2">
                  <div className="flex items-center gap-2 text-xs text-text">
                    <ImagePlus size={15} />
                    <span className="min-w-0 flex-1 truncate" title={image.file.name}>{image.file.name} · {(image.file.size / 1024 / 1024).toFixed(1)} MB</span>
                  </div>
                  {imagePreviewUrls[image.id] && <img src={imagePreviewUrls[image.id]} alt={`ตัวอย่าง ${image.file.name}`} className="mt-2 h-24 w-full rounded-md object-contain" />}
                  <button type="button" aria-label={`ลบรูป ${image.file.name}`} onClick={() => setImages((current) => removeAttachmentById(current, image.id))}
                    className="mt-2 min-h-11 w-full rounded-md border border-red-300 bg-red-50 px-3 text-sm font-medium text-red-800 hover:bg-red-100">
                    <span aria-hidden="true">× </span>ลบรูปนี้
                  </button>
                </div>
              ))}
            </div>
          ) : file ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-text">
                {file.type.startsWith("video/") ? <Film size={15} /> : <ImagePlus size={15} />}
                <span className="flex-1 truncate">{file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB</span>
                <button type="button" aria-label="ลบไฟล์แนบ" onClick={() => setFile(null)} className="h-11 w-11 flex items-center justify-center rounded-md text-text-muted hover:bg-surface hover:text-text"><X size={14} /></button>
              </div>
              {filePreviewUrl && (file.type.startsWith("video/")
                ? <video src={filePreviewUrl} controls className="max-h-32 max-w-full rounded-lg" />
                : <img src={filePreviewUrl} alt="ตัวอย่างรูปที่จะส่ง" className="max-h-32 max-w-full rounded-lg object-contain" />)}
            </div>
          ) : (
            <div aria-label="เลือกสติกเกอร์ Shopee" className="space-y-2">
              <div className="flex items-center justify-between gap-2 text-xs text-text">
                <span>เลือกสติกเกอร์จากภาพ แล้วกดส่ง</span>
                <button type="button" aria-label="ปิดตัวเลือกสติกเกอร์" onClick={() => setStickerOpen(false)} className="h-11 w-11 flex items-center justify-center rounded-md hover:bg-surface"><X size={15} /></button>
              </div>
              {stickerError && <p role="alert" className="text-xs text-vibrant-coral">{stickerError}</p>}
              {stickerLoading && <p role="status" className="text-xs text-text-muted">กำลังโหลดสติกเกอร์…</p>}
              <div className="flex gap-1 overflow-x-auto" aria-label="ชุดสติกเกอร์">
                {stickerPacks.map((pack, index) => <button key={pack.pid} type="button" onClick={() => void chooseStickerPack(pack.pid)}
                  aria-pressed={stickerPackageId === pack.pid} className={`min-h-11 shrink-0 rounded-lg border px-3 text-xs ${stickerPackageId === pack.pid ? "border-brand bg-brand/10 text-brand" : "border-border bg-surface"}`}>
                  {pack.name === pack.pid ? `ชุด ${index + 1}` : pack.name}
                </button>)}
              </div>
              <div className="grid max-h-48 grid-cols-5 gap-1.5 overflow-y-auto sm:grid-cols-7" aria-label="ภาพสติกเกอร์">
                {stickers.map((sticker) => <button key={sticker.sid} type="button" onClick={() => setStickerId(sticker.sid)}
                  aria-label={`เลือกสติกเกอร์ ${sticker.sid}`} aria-pressed={stickerId === sticker.sid}
                  className={`flex h-14 items-center justify-center rounded-lg border p-1 ${stickerId === sticker.sid ? "border-brand bg-brand/10" : "border-border bg-surface"}`}>
                  <img src={sticker.url} alt="" loading="lazy" className="max-h-full max-w-full object-contain" />
                </button>)}
              </div>
              {stickerId && <p className="text-xs text-brand">เลือกสติกเกอร์แล้ว · กดปุ่มส่งเพื่อยืนยัน</p>}
            </div>
          )}
        </div>
      )}

      {emojiOpen && (
        <div className="mb-2 flex flex-wrap gap-1 rounded-lg border border-border bg-surface p-2 shadow-sm" aria-label="เลือกอิโมจิ">
          {EMOJI.map((emoji) => <button key={emoji} type="button" onClick={() => insertEmoji(emoji)} className="h-11 w-11 rounded hover:bg-surface-2 text-lg">{emoji}</button>)}
        </div>
      )}

      <div className="flex items-end gap-2">
        <div className="flex gap-1 pb-1">
          <input ref={imageInputRef} type="file" multiple accept=".jpg,.jpeg,.png,.gif,image/jpeg,image/png,image/gif" className="hidden"
            onChange={(e) => { chooseFile("image", e.target.files || undefined); e.currentTarget.value = ""; }} />
          <input ref={videoInputRef} type="file" accept=".mp4,.mov,.m4v,video/*" className="hidden"
            onChange={(e) => chooseFile("video", e.target.files?.[0])} />
          <button type="button" disabled={!canSelectMedia || !!file || stickerOpen} onClick={() => imageInputRef.current?.click()} title="เลือกรูปภาพ" aria-label="แนบรูปภาพ"
            className="h-11 w-11 rounded-md text-brand bg-brand/5 hover:bg-brand/10 disabled:opacity-40 flex items-center justify-center"><ImagePlus size={17} /></button>
          <button type="button" disabled={!canSelectMedia || !!file || images.length > 0 || stickerOpen} onClick={() => videoInputRef.current?.click()} title="เลือกวิดีโอ" aria-label="แนบวิดีโอ"
            className="h-11 w-11 rounded-md text-brand bg-brand/5 hover:bg-brand/10 disabled:opacity-40 flex items-center justify-center"><Film size={17} /></button>
          <button type="button" onClick={() => { setEmojiOpen((v) => !v); setStickerOpen(false); }} title="แทรกอิโมจิ" aria-label="แทรกอิโมจิ" aria-expanded={emojiOpen}
            className="h-11 w-11 rounded-md text-text-muted hover:bg-surface-2 flex items-center justify-center"><Smile size={17} /></button>
          <button type="button" disabled={!canSelectMedia || !!file || images.length > 0} onClick={() => void openStickerPicker()} title="เลือกสติกเกอร์" aria-label="เลือกสติกเกอร์" aria-expanded={stickerOpen}
            className="h-11 w-11 rounded-md text-brand bg-brand/5 hover:bg-brand/10 disabled:opacity-40 flex items-center justify-center"><Sticker size={17} /></button>
        </div>
        <textarea aria-label="ข้อความที่จะส่ง" ref={textareaRef} value={text} onChange={(e) => {
          setText(e.target.value);
          const el = e.target;
          el.style.height = "auto";
          el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
        }} onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); }
        }} placeholder={placeholder || "พิมพ์ข้อความตอบลูกค้า..."} rows={1} disabled={disabled || !!file || images.length > 0 || stickerOpen}
          className="flex-1 resize-none min-h-[44px] max-h-[128px] rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand overflow-hidden disabled:opacity-60" />
        <button type="submit" aria-label={busy ? "กำลังส่ง" : images.length ? `ส่งรูป ${images.length} รูป` : file ? "ส่งไฟล์แนบ" : stickerOpen ? "ส่งสติกเกอร์" : "ส่งข้อความ"}
          disabled={busy || disabled || (!file && images.length === 0 && !stickerOpen && !text.trim()) || ((!!file || images.length > 0) && !canSendMedia) || (stickerOpen && (!canSendMedia || !stickerId || !stickerPackageId))}
          className="h-11 w-11 shrink-0 rounded-xl bg-brand text-white flex items-center justify-center hover:bg-brand/90 disabled:opacity-50">
          {busy ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" /> : <Send size={16} />}
        </button>
      </div>
      {error && <div role="alert" className="mt-1.5 text-[11px] text-vibrant-coral">{error}</div>}
      {sendFailure && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setSendFailure(null)}>
          <div role="alertdialog" aria-modal="true" aria-labelledby="send-failure-title" aria-describedby="send-failure-cause"
            onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") setSendFailure(null); }}
            className="w-full max-w-md rounded-xl bg-surface p-5 text-text shadow-xl">
            <h2 id="send-failure-title" className="text-base font-semibold">{sendFailure.title}</h2>
            <p id="send-failure-cause" className="mt-3 text-sm">เกิดอะไรขึ้น: {sendFailure.cause}</p>
            <p className="mt-2 text-sm">ต้องทำอย่างไร: {sendFailure.action}</p>
            {sendFailure.code && <p className="mt-3 text-xs text-text-muted">รหัส: {sendFailure.code}</p>}
            {sendFailure.providerError && <p className="mt-1 text-xs text-text-muted">Shopee error: {sendFailure.providerError}</p>}
            {sendFailure.providerHttpStatus && <p className="mt-1 text-xs text-text-muted">Shopee HTTP: {sendFailure.providerHttpStatus}</p>}
            {sendFailure.providerRequestId && <p className="mt-1 break-all text-xs text-text-muted">Shopee request ID: {sendFailure.providerRequestId}</p>}
            {sendFailure.code === "delivery_unknown" && <p className="mt-2 text-xs text-text-muted">ลองใหม่จะตรวจผลคำขอเดิมเท่านั้น ระบบจะไม่ส่งข้อความใหม่</p>}
            {!sendFailure.code && <p className="mt-2 text-xs text-text-muted">ลองใหม่จะใช้คำขอเดิมเพื่อป้องกันการส่งซ้ำ หากระบบบันทึกว่าล้มเหลว จะไม่ส่งใหม่อัตโนมัติ</p>}
            {sendFailure.code === "send_mode_changed" && <p className="mt-2 text-xs text-text-muted">ลองใหม่จะตรวจสถานะสวิตช์ล่าสุดก่อนส่งคำขอเดิม</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => void retryFailedSend()} disabled={busy || disabled || (sendFailure.code === "send_mode_changed" && !onRefreshSendMode)}
                className="min-h-11 rounded-lg bg-brand px-4 text-sm text-white disabled:opacity-50">ลองใหม่</button>
              <button ref={failureCloseRef} type="button" onClick={() => setSendFailure(null)}
                className="min-h-11 rounded-lg border border-border px-4 text-sm">ปิด</button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}
