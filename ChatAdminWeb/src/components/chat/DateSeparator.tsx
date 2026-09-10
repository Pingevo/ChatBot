// DateSeparator — แทรกแถบวันที่คั่นกลางแชทเมื่อเปลี่ยนวัน (เหมือน LINE)
// "use client";
import { DateBanner, dayKey } from "@/components/shadow/DateBanner";

/**
 * รับ messages (มี timestamp) + render function
 * แทรก <DateBanner> เมื่อวันเปลี่ยน
 *
 * ใช้แบบ:
 *   <DateSeparatedList
 *     items={messages}
 *     getKey={(m) => m.id}
 *     getTimestamp={(m) => m.timestamp}
 *     renderItem={(m) => <MessageBubble msg={m} />}
 *   />
 */
interface DateSeparatedListProps<T> {
  items: T[];
  getKey: (item: T) => string;
  getTimestamp: (item: T) => string | Date;
  renderItem: (item: T) => React.ReactNode;
  /** compact = ขนาดเล็ก (สำหรับ panel แคบ) */
  compact?: boolean;
  /** ถ้าเป็นวันที่ผ่านไปแล้ว (ไม่ใช่วันนี้) → ไม่โชว์ banner */
  onlyToday?: boolean;
}

export function DateSeparatedList<T>({
  items,
  getKey,
  getTimestamp,
  renderItem,
  compact = false,
  onlyToday = false,
}: DateSeparatedListProps<T>) {
  let lastDayKey = "";
  const nodes: React.ReactNode[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const ts = getTimestamp(item);
    const dk = dayKey(ts);
    if (dk !== lastDayKey) {
      nodes.push(
        <DateBanner key={`date-${dk}-${i}`} timestamp={ts} compact={compact} onlyToday={onlyToday} />
      );
      lastDayKey = dk;
    }
    const key = getKey(item);
    nodes.push(<div key={key}>{renderItem(item)}</div>);
  }
  return <>{nodes}</>;
}
