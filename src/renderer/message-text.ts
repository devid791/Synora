/** Presentation only: preserve the exact source by partitioning, never deleting.
 * Recognize only a complete leading model-output block. Code examples, inline
 * tags, unfinished streams and malformed blocks stay literal and fully visible.
 */
export function reportedReasoning(text: string) {
  const start = text.search(/\S/);
  if (start < 0 || !text.startsWith("<think>", start)) return null;
  const end = text.indexOf("</think>", start + 7);
  if (end < 0 || text.slice(start + 7, end).includes("<think>")) return null;
  const boundary = end + 8;
  return { block: text.slice(0, boundary), answer: text.slice(boundary) };
}
