// ImageViewer — ซูมภาพ/วิดีโอแบบเต็มจอ (fixed overlay)
// ใช้ได้ทั้ง ticket chat, shadow inbox, test assignment
// เรียกผ่าน zustand store: imageViewer.open(url, { type, alt })
"use client";
import { create } from "zustand";
import { useEffect, useState } from "react";
import { X, ZoomIn, ZoomOut, Download, Maximize2, RotateCw } from "lucide-react";

interface ViewerState {
  open: boolean;
  url: string;
  type: "image" | "video";
  alt: string;
  zoom: number;
  rotation: number;
  show: (url: string, opts?: { type?: "image" | "video"; alt?: string }) => void;
  close: () => void;
  setZoom: (z: number) => void;
  setRotation: (r: number) => void;
}

export const useImageViewer = create<ViewerState>((set) => ({
  open: false,
  url: "",
  type: "image",
  alt: "",
  zoom: 1,
  rotation: 0,
  show: (url, opts) => set({ open: true, url, type: opts?.type || "image", alt: opts?.alt || "", zoom: 1, rotation: 0 }),
  close: () => set({ open: false }),
  setZoom: (z) => set({ zoom: Math.max(0.5, Math.min(5, z)) }),
  setRotation: (r) => set({ rotation: r }),
}));

// helper — เรียกจากนอก React component ได้
export const imageViewer = {
  show: (url: string, opts?: { type?: "image" | "video"; alt?: string }) => useImageViewer.getState().show(url, opts),
  close: () => useImageViewer.getState().close(),
};

export function ImageViewerOverlay() {
  const { open, url, type, alt, zoom, rotation, close, setZoom, setRotation } = useImageViewer();

  // ESC to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "+" || e.key === "=") setZoom(zoom + 0.5);
      if (e.key === "-") setZoom(zoom - 0.5);
      if (e.key === "r") setRotation((rotation + 90) % 360);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, zoom, rotation, close, setZoom, setRotation]);

  // Lock scroll
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = ""; };
    }
  }, [open]);

  if (!open || !url) return null;

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center bg-black/90 animate-fade-in"
      onClick={close}
    >
      {/* Toolbar */}
      <div className="absolute top-4 right-4 flex items-center gap-2 z-10" onClick={(e) => e.stopPropagation()}>
        {type === "image" && (
          <>
            <button onClick={() => setZoom(zoom + 0.5)} className="w-9 h-9 rounded-lg bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors" title="ซูมเข้า (+)">
              <ZoomIn size={18} />
            </button>
            <button onClick={() => setZoom(zoom - 0.5)} className="w-9 h-9 rounded-lg bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors" title="ซูมออก (-)">
              <ZoomOut size={18} />
            </button>
            <button onClick={() => setRotation((rotation + 90) % 360)} className="w-9 h-9 rounded-lg bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors" title="หมุน (R)">
              <RotateCw size={18} />
            </button>
          </>
        )}
        <a
          href={url}
          download={alt || "download"}
          target="_blank"
          rel="noopener noreferrer"
          className="w-9 h-9 rounded-lg bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
          title="ดาวน์โหลด"
        >
          <Download size={18} />
        </a>
        <button onClick={close} className="w-9 h-9 rounded-lg bg-white/10 hover:bg-red-500/50 text-white flex items-center justify-center transition-colors" title="ปิด (ESC)">
          <X size={18} />
        </button>
      </div>

      {/* Content */}
      <div
        className="max-w-[95vw] max-h-[95vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
        style={{ cursor: type === "image" ? "zoom-in" : "default" }}
      >
        {type === "image" ? (
          <img
            src={url}
            alt={alt}
            className="max-w-none transition-transform duration-200"
            style={{
              transform: `scale(${zoom}) rotate(${rotation}deg)`,
              transformOrigin: "center center",
            }}
            loading="eager"
            onClick={() => setZoom(zoom === 1 ? 2 : 1)}
          />
        ) : (
          <video
            src={url}
            poster={undefined}
            controls
            autoPlay
            className="max-w-[95vw] max-h-[90vh] rounded-lg"
          />
        )}
      </div>

      {/* Alt text / caption */}
      {alt && type === "image" && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-xs text-white/60 bg-black/40 px-3 py-1 rounded-full max-w-[80vw] truncate">
          {alt}
        </div>
      )}

      {/* Zoom indicator */}
      {type === "image" && zoom !== 1 && (
        <div className="absolute bottom-4 right-4 text-xs text-white/60 bg-black/40 px-2 py-1 rounded-full">
          {Math.round(zoom * 100)}%
        </div>
      )}
    </div>
  );
}
