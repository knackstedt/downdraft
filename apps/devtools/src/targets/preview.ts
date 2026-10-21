// ============================================================================
// preview.ts — RemoteObjectRef → inline preview strings, Chrome-style.
// ============================================================================

import type { RemoteObjectRef } from "./model";

export function previewRemote(r: RemoteObjectRef | undefined, depth = 0): string {
  if (!r) return "undefined";
  if (r.unserializableValue !== undefined) return r.unserializableValue;
  switch (r.type) {
    case "undefined": return "undefined";
    case "boolean":
    case "number": return String(r.value ?? r.description ?? "");
    case "bigint": return `${r.value ?? r.description ?? ""}n`;
    case "symbol": return r.description ?? String(r.value ?? "");
    case "string": return depth === 0 ? JSON.stringify(String(r.value ?? "")) : String(r.value ?? "");
    case "function": {
      const d = r.description ?? "";
      const m = d.match(/^(?:async\s+)?(?:function\*?\s*)?([\w$]+)?/);
      return `ƒ ${m?.[1] ?? ""}()`;
    }
    case "object":
    default: {
      const st = r.subtype;
      if (st === "null") return "null";
      if (st === "array") return r.description ?? "Array";
      if (st === "promise") return r.description ?? "Promise";
      if (st === "map") return r.description ?? "Map";
      if (st === "set") return r.description ?? "Set";
      if (st === "regexp" || st === "date" || st === "error") return r.description ?? "";
      if (st === "typedarray" || st === "arraybuffer" || st === "dataview") return r.description ?? "";
      // Prefer CDP's embedded preview properties when present.
      const pv = r.previewProps;
      if (pv && pv.length && depth < 1) {
        const body = pv.slice(0, 5).map((p) => {
          const v = p.value !== undefined ? String(p.value) : (p.type ?? "…");
          return `${p.name}: ${p.type === "string" ? JSON.stringify(v) : v}`;
        }).join(", ");
        const more = pv.length > 5 ? ", …" : "";
        const cls = r.className && r.className !== "Object" ? `${r.className} ` : "";
        return `${cls}{${body}${more}}`;
      }
      return r.description ?? (r.className ?? "Object");
    }
  }
}

/** A compact per-kind display color key — surfaces map it to theme colors. */
export function remoteKind(r: RemoteObjectRef): "num" | "str" | "obj" | "fn" | "kw" | "err" {
  if (!r) return "kw";
  switch (r.type) {
    case "number": case "bigint": case "boolean": return "num";
    case "string": return "str";
    case "function": return "fn";
    case "undefined": case "symbol": return "kw";
    default:
      return r.subtype === "error" ? "err" : "obj";
  }
}
