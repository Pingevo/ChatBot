import assert from "node:assert/strict";

const { diffLines } = await import("../src/lib/textDiff.ts");
const before = "รับทราบค่ะ ข้อมูลที่ลูกค้าให้มา: ชื่อ-นามสกุล: สวัสดีวันจันทร์\nรวบรวมแจ้งข้อมูลเพิ่มเติมด้วยนะคะ: เบอร์โทร\nและหากมีรูปหรือวิดีโอแสดงอาการ ส่งมาได้เลยค่ะ";
const after = "สวัสดีฮ้าฟฟู๋ววว";

assert.deepEqual(diffLines(before, after), [
  { op: "del", text: before },
  { op: "add", text: after },
]);
assert.deepEqual(diffLines("คงข้อความนี้\nข้อความเก่า", "คงข้อความนี้\nข้อความใหม่"), [
  { op: "same", text: "คงข้อความนี้" },
  { op: "del", text: "ข้อความเก่า" },
  { op: "add", text: "ข้อความใหม่" },
]);

console.log("Bot Performance line diff checks passed");
