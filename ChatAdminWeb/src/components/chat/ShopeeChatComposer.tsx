"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Film, ImagePlus, Loader2, Send, Smile, Sticker, X } from "lucide-react";
import { newChatRequestId } from "@/lib/services";
import { api } from "@/lib/apiClient";
import type { ChatSendInput, Platform } from "@/lib/types";

const EMOJI = ["😊", "😂", "🥰", "🙏", "👍", "❤️", "🎉", "✨", "😅", "😉", "💙", "📦"];

interface QuickReply {
  quick_reply_id: string;
  title: string;
  body: string;
}

interface Props {
  platform: Platform;
  liveSendEnabled: boolean;
  onSend: (payload: ChatSendInput) => Promise<unknown> | void;
  quickReplies?: QuickReply[];
  placeholder?: string;
  disabled?: boolean;
}

export function ShopeeChatComposer({ platform, liveSendEnabled, onSend, quickReplies = [], placeholder, disabled = false }: Props) {
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [filePreviewUrl, setFilePreviewUrl] = useState<string | null>(null);
  const [stickerOpen, setStickerOpen] = useState(false);
  const [stickerId, setStickerId] = useState("");
  const [stickerPackageId, setStickerPackageId] = useState("");
  const [stickerPacks, setStickerPacks] = useState<{ pid: string; name: string }[]>([]);
  const [stickers, setStickers] = useState<{ sid: string; url: string }[]>([]);
  const [stickerLoading, setStickerLoading] = useState(false);
  const [stickerError, setStickerError] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pendingRequestRef = useRef<{ signature: string; requestId: string } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!file) { setFilePreviewUrl(null); return; }
    const url = URL.createObjectURL(file);
    setFilePreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const canSelectMedia = platform === "shopee" && !disabled;
  const canSendMedia = canSelectMedia && liveSendEnabled;

  function withRequestId(payload: ChatSendInput): ChatSendInput {
    const signature = payload.type === "text" ? JSON.stringify([payload.type, payload.text])
      : payload.type === "image" || payload.type === "video" ? JSON.stringify([payload.type, payload.file.name, payload.file.size, payload.file.lastModified])
      : payload.type === "sticker" ? JSON.stringify([payload.type, payload.sticker_package_id, payload.sticker_id])
      : JSON.stringify([payload.type, payload.item_id]);
    if (pendingRequestRef.current?.signature !== signature) {
      pendingRequestRef.current = { signature, requestId: newChatRequestId() };
    }
    return { ...payload, request_id: pendingRequestRef.current.requestId } as ChatSendInput;
  }

  async function submit(source: ChatSendInput) {
    if (busy || disabled) return;
    setBusy(true);
    setError("");
    const payload = withRequestId(source);
    try {
      await onSend(payload);
      pendingRequestRef.current = null;
      setText("");
      setFile(null);
      setStickerId("");
      setStickerPackageId("");
      setStickerOpen(false);
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    } catch (e) {
      const body = (e as { response?: { data?: { detail?: unknown; error?: unknown; message?: unknown } } })?.response?.data;
      const detail = body?.detail ?? body?.error ?? body?.message;
      setError(typeof detail === "string" ? detail : e instanceof Error ? e.message : "ส่งไม่สำเร็จ");
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

  function chooseFile(kind: "image" | "video", selected: File | undefined) {
    setError("");
    if (!selected) return;
    if (kind === "image") {
      const ext = selected.name.split(".").pop()?.toLowerCase();
      if (selected.size > 10 * 1024 * 1024 || !["jpg", "jpeg", "png", "gif"].includes(ext || "") || !selected.type.startsWith("image/")) {
        setError("รูปต้องเป็น JPG, PNG หรือ GIF และขนาดไม่เกิน 10 MB");
        return;
      }
      setFile(selected);
      return;
    }
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
    if ((file || stickerOpen) && !canSendMedia) {
      setError("สวิตช์ส่งจริงยังปิดอยู่ เลือกสื่อได้แต่ยังส่งไม่ได้");
      return;
    }
    if (file) {
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

      {(file || stickerOpen) && (
        <div className="mb-2 rounded-lg border border-border bg-surface-2 p-2.5">
          {file ? (
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
          <input ref={imageInputRef} type="file" accept=".jpg,.jpeg,.png,.gif,image/jpeg,image/png,image/gif" className="hidden"
            onChange={(e) => chooseFile("image", e.target.files?.[0])} />
          <input ref={videoInputRef} type="file" accept=".mp4,.mov,.m4v,video/*" className="hidden"
            onChange={(e) => chooseFile("video", e.target.files?.[0])} />
          <button type="button" disabled={!canSelectMedia || !!file} onClick={() => imageInputRef.current?.click()} title="เลือกรูปภาพ" aria-label="แนบรูปภาพ"
            className="h-11 w-11 rounded-md text-brand bg-brand/5 hover:bg-brand/10 disabled:opacity-40 flex items-center justify-center"><ImagePlus size={17} /></button>
          <button type="button" disabled={!canSelectMedia || !!file} onClick={() => videoInputRef.current?.click()} title="เลือกวิดีโอ" aria-label="แนบวิดีโอ"
            className="h-11 w-11 rounded-md text-brand bg-brand/5 hover:bg-brand/10 disabled:opacity-40 flex items-center justify-center"><Film size={17} /></button>
          <button type="button" onClick={() => { setEmojiOpen((v) => !v); setStickerOpen(false); }} title="แทรกอิโมจิ" aria-label="แทรกอิโมจิ" aria-expanded={emojiOpen}
            className="h-11 w-11 rounded-md text-text-muted hover:bg-surface-2 flex items-center justify-center"><Smile size={17} /></button>
          <button type="button" disabled={!canSelectMedia || !!file} onClick={() => void openStickerPicker()} title="เลือกสติกเกอร์" aria-label="เลือกสติกเกอร์" aria-expanded={stickerOpen}
            className="h-11 w-11 rounded-md text-brand bg-brand/5 hover:bg-brand/10 disabled:opacity-40 flex items-center justify-center"><Sticker size={17} /></button>
        </div>
        <textarea aria-label="ข้อความที่จะส่ง" ref={textareaRef} value={text} onChange={(e) => {
          setText(e.target.value);
          const el = e.target;
          el.style.height = "auto";
          el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
        }} onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); }
        }} placeholder={placeholder || "พิมพ์ข้อความตอบลูกค้า..."} rows={1} disabled={disabled || !!file || stickerOpen}
          className="flex-1 resize-none min-h-[44px] max-h-[128px] rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand overflow-hidden disabled:opacity-60" />
        <button type="submit" aria-label={busy ? "กำลังส่ง" : file ? "ส่งไฟล์แนบ" : stickerOpen ? "ส่งสติกเกอร์" : "ส่งข้อความ"}
          disabled={busy || disabled || (!file && !stickerOpen && !text.trim()) || (!!file && !canSendMedia) || (stickerOpen && (!canSendMedia || !stickerId || !stickerPackageId))}
          className="h-11 w-11 shrink-0 rounded-xl bg-brand text-white flex items-center justify-center hover:bg-brand/90 disabled:opacity-50">
          {busy ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" /> : file?.type.startsWith("video/") ? <Film size={16} /> : stickerOpen ? <Sticker size={16} /> : file ? <ImagePlus size={16} /> : <Send size={16} />}
        </button>
      </div>
      {error && <div role="alert" className="mt-1.5 text-[11px] text-vibrant-coral">{error}</div>}
    </form>
  );
}
