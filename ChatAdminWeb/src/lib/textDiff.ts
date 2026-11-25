// Character diff between bot original and admin final text.
// diffText: LCS segments (same/del/add) after trimming common prefix/suffix; huge middles are treated as fully replaced.
// editPercent: changed chars / (len a + len b) * 100 — 0 = unchanged, 100 = completely rewritten.
export type DiffSegment = { op: "same" | "del" | "add"; text: string };

const MAX_CELLS = 4_000_000;

export function diffText(a: string, b: string): DiffSegment[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const midA = a.slice(start, endA), midB = b.slice(start, endB);
  const out: DiffSegment[] = [];
  const push = (op: DiffSegment["op"], text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last?.op === op) last.text += text; else out.push({ op, text });
  };
  push("same", a.slice(0, start));
  if (midA.length * midB.length > MAX_CELLS) {
    push("del", midA); push("add", midB);
  } else {
    const n = midA.length, m = midB.length, w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = midA[i] === midB[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { push("same", midA[i]); i++; j++; }
      else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) push("del", midA[i++]);
      else push("add", midB[j++]);
    }
    push("del", midA.slice(i)); push("add", midB.slice(j));
  }
  push("same", a.slice(endA));
  return out;
}

export function editPercent(a: string, b: string): number {
  if (a === b) return 0;
  const total = a.length + b.length;
  const changed = diffText(a, b).reduce((sum, s) => sum + (s.op === "same" ? 0 : s.text.length), 0);
  return Math.round((changed / total) * 1000) / 10;
}
