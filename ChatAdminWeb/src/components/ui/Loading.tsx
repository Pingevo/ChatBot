// Loading — minimal spinner
export function Loading({ size = 24 }: { size?: number }) {
  return (
    <div
      role="status"
      aria-label="กำลังโหลด"
      className="animate-spin rounded-full border-2 border-pale-sky border-t-brand"
      style={{ width: size, height: size }}
    />
  );
}
