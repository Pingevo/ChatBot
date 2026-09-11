// filterPresets — localStorage-based filter preset persistence
// Scope per admin: chatadmin:presets:<pageKey>:<adminId>

export interface FilterPreset<T> {
  name: string;
  values: T;
  createdAt: number;
}

const KEY_PREFIX = "chatadmin:presets:";

function storageKey(pageKey: string, adminId: string): string {
  return `${KEY_PREFIX}${pageKey}:${adminId}`;
}

export function loadPresets<T>(pageKey: string, adminId: string): FilterPreset<T>[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey(pageKey, adminId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as FilterPreset<T>[];
  } catch {
    return [];
  }
}

export function savePreset<T>(pageKey: string, adminId: string, name: string, values: T): FilterPreset<T>[] {
  const presets = loadPresets<T>(pageKey, adminId);
  const filtered = presets.filter((p) => p.name !== name);
  const newPreset: FilterPreset<T> = { name, values, createdAt: Date.now() };
  const updated = [...filtered, newPreset];
  if (typeof window !== "undefined") {
    window.localStorage.setItem(storageKey(pageKey, adminId), JSON.stringify(updated));
  }
  return updated;
}

export function deletePreset<T>(pageKey: string, adminId: string, name: string): FilterPreset<T>[] {
  const presets = loadPresets<T>(pageKey, adminId);
  const updated = presets.filter((p) => p.name !== name);
  if (typeof window !== "undefined") {
    window.localStorage.setItem(storageKey(pageKey, adminId), JSON.stringify(updated));
  }
  return updated;
}
