export const CHAT_TEXT_SIZE_OPTIONS = [
  { value: "normal", label: "ปกติ", pixels: 14 },
  { value: "large", label: "ใหญ่", pixels: 16 },
  { value: "larger", label: "ใหญ่มาก", pixels: 18 },
] as const;

export type ChatTextSize = (typeof CHAT_TEXT_SIZE_OPTIONS)[number]["value"];

export function isChatTextSize(value: unknown): value is ChatTextSize {
  return CHAT_TEXT_SIZE_OPTIONS.some((option) => option.value === value);
}

export function normalizeChatTextSize(value: unknown): ChatTextSize {
  return isChatTextSize(value) ? value : "normal";
}
