// reviewUi — merge review API result เข้า message state (testable seam)
// ใช้โดย /botworker page handleReviewAction — คืน array ใหม่เสมอ
export function mergeBubbleResult<T extends { id: string; review_bubbles?: { bubble_id: string }[] }>(
  messages: T[],
  msgId: string,
  updated: { bubble_id: string }
): T[] {
  return messages.map((m) =>
    m.id === msgId && m.review_bubbles
      ? { ...m, review_bubbles: m.review_bubbles.map((b) => (b.bubble_id === updated.bubble_id ? updated : b)) }
      : m
  );
}
