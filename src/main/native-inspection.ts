import type { NativeInspection } from "../shared/computer-use";
import type { BrowserFrame } from "../shared/contracts";

// Native providers are untrusted data too. Bound text/coordinates before they
// enter an observation; never return a secret-field value, even from a provider
// that accidentally includes it. Click points use the attached image's pixels.
export function nativeInspection(raw: unknown, frame: BrowserFrame): NativeInspection {
  const list = (raw as { elements?: unknown[] } | null)?.elements;
  if (!Array.isArray(list)) throw Error("Invalid accessibility observation");
  const elements: NativeInspection["elements"] = [];
  for (const item of list.slice(0, 100)) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, any>, b = e.bounds;
    if (!b || ![b.left,b.top,b.width,b.height].every(Number.isFinite) || b.width <= 0 || b.height <= 0) continue;
    const left = Math.max(0,b.left), top = Math.max(0,b.top);
    const right = Math.min(frame.width,b.left+b.width), bottom = Math.min(frame.height,b.top+b.height);
    if (right <= left || bottom <= top) continue;
    const role = String(e.role ?? "").slice(0, 80);
    const redacted = e.value_redacted === true || /secure|password/i.test(role);
    elements.push({role, name:String(e.name ?? "").slice(0,180),focused:e.focused === true,disabled:e.disabled === true,
      ...(redacted ? {value_redacted:true} : typeof e.value === "string" ? {value:e.value.slice(0,2000)} : {}),
      bounds:{left,top,width:right-left,height:bottom-top},click:{x:Math.floor((left+right)/2),y:Math.floor((top+bottom)/2)}});
  }
  return {available:true,elements};
}
