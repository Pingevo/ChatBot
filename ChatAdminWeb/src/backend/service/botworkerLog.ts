// Bot-worker console log — Thai, human-readable text for worker results (log only; never parsed, never stored).
// workerResultText(status, detail): Thai label for status + Thai reading of the known worker detail formats; unknown detail is kept raw.
// createWorkerLogger(print, max): prints "  [worker] <message_id> → <text>" and skips a line identical to the last one for that message.
const STATUS_TEXT: Record<string, string> = {
  buffered: "รอรวมข้อความ",
  buffer_flushed: "ส่งเข้าบอทแล้ว",
  buffer_error: "ส่งเข้าบอทไม่สำเร็จ",
  skip: "ข้าม",
  finalized: "ทำเสร็จไปแล้ว",
  bot_answered: "บอทร่างคำตอบแล้ว (รอแอดมินตรวจในหน้า Bot Worker)",
  bot_no_reply: "บอทตั้งใจไม่ตอบข้อความนี้",
  skip_assigned: "บอทไม่ตอบ",
  trigger_matched: "ตรงกับ trigger — ทำตาม trigger แล้ว",
  handed_off: "ส่งต่อให้แอดมินแล้ว",
  handoff_review_pending: "บอทขอส่งต่อแอดมิน — รอผู้ตรวจอนุมัติในหน้า Bot Worker",
  bot_failed: "บอทตอบไม่สำเร็จ",
  no_action: "ไม่มีอะไรต้องทำ",
  workflow_actioned: "workflow ทำงานแล้ว",
  workflow_resumed: "workflow ทำงานต่อจากที่รอไว้",
  workflow_handed_off: "workflow ส่งต่อให้แอดมินแล้ว",
  workflow_exit_drop: "workflow จบแล้ว — ไม่ต้องตอบ",
  in_flight: "กำลังทำอยู่",
  cancelled: "ถูกยกเลิก (ปิด worker ระหว่างทำ)",
  lost_ownership: "worker ตัวอื่นรับงานนี้ไปแล้ว",
  quarantined: "ถูกกักไว้ — ข้อมูลไม่ครบ ต้องตรวจเอง",
  failed: "ล้มเหลว",
  error: "เกิดข้อผิดพลาด",
};

const DETAIL_TEXT: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^buffered \((\d+) msgs, (text|media) window (\d+)ms\)$/, (m) =>
    `รับข้อความแล้ว (รวม ${m[1]} ข้อความ) — รออีก ${Math.round(Number(m[3]) / 1000)} วินาทีเผื่อลูกค้า${m[2] === "media" ? "ส่งรูป/วิดีโอ" : "พิมพ์"}ต่อ`],
  [/^duplicate — not admitted, debounce unchanged$/, () => "รับไว้แล้ว — กำลังรอครบเวลาเพื่อรวมข้อความ"],
  [/^duplicate — restored missing debounce \((\d+)ms remaining\)$/, (m) => `รับไว้แล้ว — ตั้งเวลารอใหม่ เหลือ ${Math.round(Number(m[1]) / 1000)} วินาที`],
  [/^duplicate — batch already processing$/, () => "ชุดข้อความนี้กำลังส่งเข้าบอทอยู่"],
  [/^claim in-flight \(self\)$/, () => "กำลังส่งเข้าบอทอยู่ (รอผล)"],
  [/^claim lease active \(other owner\)$/, () => "worker ตัวอื่นกำลังทำข้อความนี้อยู่"],
  [/^claim terminal \((.+)\)$/, (m) => `ข้อความนี้ทำเสร็จไปแล้ว (${STATUS_TEXT[m[1]] || m[1]})`],
  [/^claim attempts exhausted → bot_failed$/, () => "ลองครบจำนวนครั้งแล้ว — ถือว่าบอทตอบไม่สำเร็จ"],
  [/^already processed \(terminal\)$/, () => "ข้อความนี้ทำเสร็จไปแล้ว"],
  [/^(era|recovery) aborted$/, () => "หยุดกลางทาง เพราะมีการปิด/เปิดสวิตช์ worker"],
  [/^no scope pair \(unresolved ctx\)$/, () => "ร้านนี้ไม่ได้เปิดให้ Bot Worker ทำงาน"],
  [/^test store: status=(\w+) assigned_to=(\S+) — skip$/, (m) =>
    `แอดมินรับแชทนี้อยู่ (สถานะ ${m[1]}, ผู้รับ ${m[2] === "none" ? "ยังไม่มี — รอจ่ายงาน" : m[2]}) — กดปิดแชทในหน้า Bot Worker ถ้าต้องการให้บอทตอบต่อ`],
];

export function workerResultText(status: string, detail: string): string {
  const flushed = detail.match(/^flushed (\d+) msgs → (\w+)(?:: ([\s\S]*))?$/);
  if (flushed) return `ส่งรวม ${flushed[1]} ข้อความเข้าบอท → ${workerResultText(flushed[2], flushed[3] || "")}`;
  for (const [pattern, render] of DETAIL_TEXT) {
    const m = detail.match(pattern);
    if (m) return status === "skip_assigned" ? `${STATUS_TEXT.skip_assigned} — ${render(m)}` : render(m);
  }
  const label = STATUS_TEXT[status] || status;
  return detail ? `${label} — ${detail}` : label;
}

export function createWorkerLogger(print: (line: string) => void = console.log, max = 5000) {
  const last = new Map<string, string>();
  return (messageId: string, status: string, detail: string) => {
    const text = workerResultText(status, detail);
    if (last.get(messageId) === text) return;
    last.delete(messageId);
    last.set(messageId, text);
    if (last.size > max) last.delete(last.keys().next().value as string);
    print(`  [worker] ${messageId} → ${text}`);
  };
}

export const logWorkerResult = createWorkerLogger();
