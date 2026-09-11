// FilterPresets — dropdown สำหรับบันทึก/โหลด/ลบ filter presets
"use client";
import { useState } from "react";
import { Bookmark, Save, Trash2, ChevronDown, Check } from "lucide-react";
import { loadPresets, savePreset, deletePreset, type FilterPreset } from "@/lib/filterPresets";
import { confirm } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";

interface Props<T> {
  pageKey: string;
  adminId: string;
  currentValues: T;
  onApply: (values: T) => void;
}

export function FilterPresets<T>({ pageKey, adminId, currentValues, onApply }: Props<T>) {
  const [open, setOpen] = useState(false);
  const [presets, setPresets] = useState<FilterPreset<T>[]>([]);
  const [name, setName] = useState("");
  const [showSave, setShowSave] = useState(false);
  const [activePreset, setActivePreset] = useState<string | null>(null);

  function refresh() {
    setPresets(loadPresets<T>(pageKey, adminId));
  }

  function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) return;
    const exists = presets.some((p) => p.name === trimmed);
    const updated = savePreset<T>(pageKey, adminId, trimmed, currentValues);
    setPresets(updated);
    setActivePreset(trimmed);
    setName("");
    setShowSave(false);
    toast.success(exists ? `อัปเดต preset "${trimmed}" แล้ว` : `บันทึก preset "${trimmed}" แล้ว`);
  }

  async function handleDelete(presetName: string, presetValues: T) {
    const ok = await confirm.ask({
      title: `ลบ preset "${presetName}"?`,
      message: "กด \"ยกเลิกการลบ\" ใน toast เพื่อกู้คืน",
      confirmText: "ลบ",
      variant: "danger",
    });
    if (!ok) return;
    const updated = deletePreset<T>(pageKey, adminId, presetName);
    setPresets(updated);
    if (activePreset === presetName) setActivePreset(null);
    toast.warning(`ลบ preset "${presetName}" แล้ว`, 6000, {
      label: "ยกเลิกการลบ",
      onClick: () => {
        const restored = savePreset<T>(pageKey, adminId, presetName, presetValues);
        setPresets(restored);
        setActivePreset(presetName);
        toast.success(`กู้คืน preset "${presetName}" แล้ว`);
      },
    });
  }

  function handleApply(p: FilterPreset<T>) {
    onApply(p.values);
    setActivePreset(p.name);
    setOpen(false);
    toast.success(`โหลด preset "${p.name}" แล้ว`);
  }

  return (
    <div className="relative">
      <button
        onClick={() => { setOpen(!open); refresh(); }}
        aria-expanded={open}
        aria-haspopup="menu"
        className="h-8 px-2.5 text-xs rounded-lg border border-border bg-surface text-text-muted hover:text-text hover:border-pale-sky flex items-center gap-1.5 transition-colors"
      >
        <Bookmark size={12} className="shrink-0" />
        <span className="font-medium">Preset</span>
        {activePreset && (
          <span className="text-[10px] text-brand font-medium truncate max-w-[80px]">: {activePreset}</span>
        )}
        <ChevronDown size={11} className="text-text-muted shrink-0" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div
            role="menu"
            tabIndex={-1}
            aria-label="filter presets"
            ref={(el) => { if (open && el) el.focus(); }}
            onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
            className="absolute top-full left-0 mt-1 min-w-[200px] bg-surface border border-border rounded-lg shadow-lg z-40 py-1"
          >
            {presets.length === 0 ? (
              <div className="px-3 py-2 text-xs text-text-subtle">ยังไม่มี preset</div>
            ) : (
              presets.map((p) => (
                <div key={p.name} className="flex items-center gap-1 px-1">
                  <button
                    onClick={() => handleApply(p)}
                    className="flex-1 text-left px-2 py-1.5 text-xs hover:bg-surface-2 rounded text-text truncate flex items-center gap-1.5"
                  >
                    {activePreset === p.name && <Check size={11} className="text-brand shrink-0" />}
                    {p.name}
                  </button>
                  <button
                    onClick={() => handleDelete(p.name, p.values)}
                    className="w-6 h-6 rounded hover:bg-vibrant-coral-soft flex items-center justify-center shrink-0"
                    title="ลบ preset"
                    aria-label={`ลบ preset ${p.name}`}
                  >
                    <Trash2 size={11} className="text-vibrant-coral" />
                  </button>
                </div>
              ))
            )}
            <div className="border-t border-border my-1" />
            {showSave ? (
              <div className="px-2 py-1.5 flex items-center gap-1">
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") setShowSave(false); }}
                  placeholder="ชื่อ preset"
                  autoFocus
                  className="flex-1 h-7 px-2 text-xs rounded border border-border bg-surface-2 focus:outline-none focus:ring-1 focus:ring-brand/40"
                />
                <button
                  onClick={handleSave}
                  className="h-7 px-2 text-xs rounded bg-brand text-white hover:bg-brand/90"
                >
                  บันทึก
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowSave(true)}
                className="w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 flex items-center gap-1.5 text-text"
              >
                <Save size={11} /> บันทึก preset ปัจจุบัน
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
