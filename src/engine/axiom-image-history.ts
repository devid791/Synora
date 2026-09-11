type Span = { start: number; end: number };
const whitespace = (c: string | undefined) =>
  c === " " || c === "\n" || c === "\r" || c === "\t";
function skipSpace(source: string, at: number) {
  while (whitespace(source[at])) at++;
  return at;
}
function stringEnd(source: string, at: number) {
  for (let i = at + 1; i < source.length; i++) {
    if (source[i] === "\\") i++;
    else if (source[i] === '"') return i + 1;
  }
  throw new Error("Unterminated validated JSON string");
}
/** Iterative source navigation, only after JSON validation. No numeric reserialization. */
function valueEnd(source: string, at: number) {
  if (source[at] === '"') return stringEnd(source, at);
  if (source[at] === "{" || source[at] === "[") {
    let depth = 0;
    for (let i = at; i < source.length; i++) {
      const c = source[i];
      if (c === '"') i = stringEnd(source, i) - 1;
      else if (c === "{" || c === "[") depth++;
      else if ((c === "}" || c === "]") && --depth === 0) return i + 1;
    }
    throw new Error("Unterminated validated JSON container");
  }
  let end = at;
  while (
    end < source.length &&
    !whitespace(source[end]) &&
    !",]}".includes(source[end])
  )
    end++;
  return end;
}
function members(
  source: string,
  span: Span,
  object: boolean,
): Map<string, Span> {
  const result = new Map<string, Span>();
  if (source[span.start] !== (object ? "{" : "[")) return result;
  let at = skipSpace(source, span.start + 1),
    index = 0;
  while (at < span.end && source[at] !== (object ? "}" : "]")) {
    let key = String(index++);
    if (object) {
      const end = stringEnd(source, at);
      key = JSON.parse(source.slice(at, end));
      at = skipSpace(source, skipSpace(source, end) + 1); // colon
    }
    const end = valueEnd(source, at);
    result.set(key, { start: at, end });
    at = skipSpace(source, end);
    if (source[at] === ",") at = skipSpace(source, at + 1);
  }
  return result;
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function message(value: unknown): value is Record<string, unknown> {
  return (
    record(value) && (value.type === undefined || value.type === "message")
  );
}

/**
 * Axiom's multimodal parser accepts text/input_text but rejects assistant
 * output_text replayed by Core. Change ONLY that discriminator, only for image
 * histories. Roles, text, annotations, tool arguments, image bytes and all IDs
 * remain byte-for-byte untouched. Never apply to other providers or responses.
 * `body` must be JSON.parse(source), validated by the private context bridge.
 */
export function axiomImageHistory(
  source: string,
  body: Record<string, unknown>,
): string {
  if (
    !Array.isArray(body.input) ||
    !body.input.some(
      (item) =>
        message(item) &&
        Array.isArray(item.content) &&
        item.content.some(
          (part) => record(part) && part.type === "input_image",
        ),
    )
  )
    return source;
  const input = members(
    source,
    { start: skipSpace(source, 0), end: source.length },
    true,
  ).get("input");
  if (!input) return source;
  const items = members(source, input, false),
    edits: Span[] = [];
  body.input.forEach((item, index) => {
    if (
      !message(item) ||
      item.role !== "assistant" ||
      !Array.isArray(item.content)
    )
      return;
    const itemSpan = items.get(String(index));
    if (!itemSpan) return;
    const content = members(source, itemSpan, true).get("content");
    if (!content) return;
    const parts = members(source, content, false);
    item.content.forEach((part, partIndex) => {
      if (
        !record(part) ||
        part.type !== "output_text" ||
        typeof part.text !== "string"
      )
        return;
      const partSpan = parts.get(String(partIndex));
      if (!partSpan) return;
      const type = members(source, partSpan, true).get("type");
      if (type) edits.push(type);
    });
  });
  let at = 0;
  const chunks: string[] = [];
  for (const edit of edits) {
    chunks.push(source.slice(at, edit.start), '"input_text"');
    at = edit.end;
  }
  return edits.length ? chunks.join("") + source.slice(at) : source;
}
