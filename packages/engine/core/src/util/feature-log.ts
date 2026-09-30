// ============================================================================
// Feature Log — terse, versioned, pipe-delimited startup diagnostics
// ============================================================================
//
// Emits a compact, uniform-across-versions string at engine startup so a user
// with a problem can paste it and a maintainer gets a diffable summary of the
// environment (OS, CPU, RAM, GPU, WebGPU features/limits, runtime versions,
// active plugins, SAB/COOP-COEP/worker status).
//
// On the native runtime a single line is emitted (one process):
//   dd-host|...   — host scope: OS/CPU/RAM/runtime + WebGPU adapter/features/
//                   limits + display + plugins merged into one record
// The "render" scope remains for callers that log renderer-side data
// separately (dd-render|...).
//
// ── Backwards-compatibility contract ─────────────────────────────────────────
//
// The `FeatureLogData` schema and the encoder's key order are the STABLE
// contract. Rules:
//   * New fields are APPENDED at the end of the key-order table.
//   * Existing fields are NEVER renamed, reordered, or removed.
//   * The `sv` (schema version) field is the only breaking-change gate;
//     bumping it signals a new format that old parsers may reject.
//   * Parsers MUST ignore unknown trailing keys (forward-compatible).
//
// Code and logs are free to change; only the data schema is locked.
// ============================================================================

export const FEATURE_LOG_SCHEMA_VERSION = 1;

/** Short codes for WebGPU features (additive; never reuse a code). */
const WGPU_FEATURE_CODES: Record<string, string> = {
  "timestamp-query": "tsq",
  "timestamp-query-inside-passes": "tsqip",
  "depth-clip-control": "dclip",
  "depth32float-stencil8": "d32s8",
  "texture-compression-bc": "bc",
  "texture-compression-bc-sliced-3d": "bc3d",
  "texture-compression-etc2": "etc2",
  "texture-compression-astc": "astc",
  "indirect-first-instance": "ifi",
  "shader-f16": "f16",
  "rg11b10ufloat-renderable": "rg11b10",
  "bgra8unorm-storage": "bgras",
  "float32-filterable": "f32filt",
  "float32-blendable": "f32blend",
  "clip-distances": "clipd",
  "dual-source-blending": "dualsrc",
  "subgroups": "sub",
};

/**
 * Versioned, additive schema. New fields appended; never reorder/rename/remove.
 *
 * `?` optional fields are omitted from the encoded line when absent (the
 * additive schema tolerates missing fields — a parser treats absent keys as
 * "unknown for this process").
 */
export interface FeatureLogData {
  sv: number; // schema version (always FEATURE_LOG_SCHEMA_VERSION)
  scope: "render" | "host"; // "host" = single-process (native) merged log
  v: string; // engine version ("0.1.0")
  mode: "dev" | "packaged" | "deterministic";
  // --- main-only ---
  os?: string; // "linux" | "win32" | "darwin"
  osRel?: string; // OS release
  arch?: string; // "x64" | "arm64" | "ia32"
  cpu?: string; // CPU model (condensed)
  cpuCores?: number; // logical core count
  mem?: string; // total RAM, human ("64G")
  node?: string; // Node version
  v8?: string; // V8 version
  gpu?: string; // GPU name (wgpu adapter info / nvidia-smi name)
  drv?: string; // GPU driver version
  sw?: string; // applied host flags, comma-sep ("swiftshader,vulkan")
  // --- render-only ---
  wgpu?: string; // "vendor=...;dev=...;arch=...;fmt=...;feat=...;lim=..."
  disp?: string; // "WxH@Hz"
  sf?: number; // display scale factor
  sab?: 0 | 1; // SharedArrayBuffer available
  coi?: 0 | 1; // crossOriginIsolated
  wk?: "ok" | "fail" | "na"; // worker load status (best-effort)
  plug?: string; // active plugin names, comma-sep
  rt?: string; // JS runtime tag — "bun" | "node" | "deno" (appended; sv stays 1)
}

// ── Key-order table (the stable contract) ───────────────────────────────────
// Order matters: this is the exact order keys appear in the encoded line.
// Append new keys at the end; never reorder.

type Formatter = (v: unknown) => string | null;

const IDENTITY: Formatter = (v) => (v === undefined || v === null ? null : String(v));
const NUM: Formatter = (v) => (v === undefined || v === null ? null : String(v));

const KEY_ORDER: Array<{ key: string; fmt: Formatter }> = [
  { key: "sv", fmt: NUM },
  { key: "scope", fmt: IDENTITY },
  { key: "v", fmt: IDENTITY },
  { key: "mode", fmt: IDENTITY },
  { key: "os", fmt: IDENTITY },
  { key: "osRel", fmt: IDENTITY },
  { key: "arch", fmt: IDENTITY },
  { key: "cpu", fmt: IDENTITY },
  { key: "cpuCores", fmt: NUM },
  { key: "mem", fmt: IDENTITY },
  { key: "node", fmt: IDENTITY },
  { key: "v8", fmt: IDENTITY },
  { key: "gpu", fmt: IDENTITY },
  { key: "drv", fmt: IDENTITY },
  { key: "sw", fmt: IDENTITY },
  { key: "wgpu", fmt: IDENTITY },
  { key: "disp", fmt: IDENTITY },
  { key: "sf", fmt: NUM },
  { key: "sab", fmt: NUM },
  { key: "coi", fmt: NUM },
  { key: "wk", fmt: IDENTITY },
  { key: "plug", fmt: IDENTITY },
  { key: "rt", fmt: IDENTITY },
];

// ── Value condensers ────────────────────────────────────────────────────────

/** Trim whitespace and collapse runs; cap length to keep the line terse. */
export function condenseText(s: string, max = 48): string {
  const trimmed = String(s).trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1) + "\u2026";
}

/** Format bytes as a short human string (e.g. 68719476736 -> "64G"). */
export function formatBytesShort(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0";
  const units = ["B", "K", "M", "G", "T", "P"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  // Whole units for K and above; raw bytes stay as-is.
  if (i === 0) return `${Math.round(v)}B`;
  return `${Math.round(v)}${units[i]}`;
}

/** Map a WebGPU feature name to its short code (falls back to the raw name). */
export function featureCode(name: string): string {
  return WGPU_FEATURE_CODES[name] ?? name;
}

/** Encode a set of WebGPU feature names into comma-separated short codes. */
export function encodeFeatures(features: Iterable<string>): string {
  const codes: string[] = [];
  // oxlint-disable-next-line downdraft/no-for-of -- iterates Iterable<string>; for..of required
  for (const f of features) {
    const c = featureCode(f);
    if (c) codes.push(c);
  }
  return codes.join(",");
}

// ── Encoder ─────────────────────────────────────────────────────────────────

/**
 * Encode a FeatureLogData into a single pipe-delimited line.
 * Format: `dd<sv>|key=value|key=value|...` in fixed key order.
 */
export function encodeFeatureLogLine(data: FeatureLogData): string {
  const parts: string[] = [`dd${data.sv ?? FEATURE_LOG_SCHEMA_VERSION}`];
  for (let _i = 0, _it = KEY_ORDER, _n = _it.length; _i < _n; _i++) { const { key, fmt } = _it[_i];
    const raw = (data as unknown as Record<string, unknown>)[key];
    const val = fmt(raw);
    if (val === null || val === undefined || val === "") continue;
    parts.push(`${key}=${val}`);
  }
  return parts.join("|");
}

/** Encode a FeatureLogData as minified JSON (for MCP/crash structured payload). */
export function encodeFeatureLogJSON(data: FeatureLogData): string {
  return JSON.stringify(data);
}

// ── Decoder (for round-trip tests + tooling that parses pasted strings) ─────

/**
 * Parse a `dd<sv>|key=value|...` line back into a partial FeatureLogData.
 * Unknown keys are ignored (forward-compatible). Returns null if the line
 * is not a feature-log line.
 */
export function decodeFeatureLogLine(line: string): Partial<FeatureLogData> | null {
  const s = line.trim();
  if (!/^dd\d+\|/.test(s)) return null;
  const parts = s.split("|");
  const head = parts.shift()!;
  const sv = parseInt(head.slice(2), 10);
  const out: Record<string, unknown> = { sv };
  for (let _i = 0, _it = parts, _n = _it.length; _i < _n; _i++) { const part = _it[_i];
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq);
    const val = part.slice(eq + 1);
    // Coerce known numeric fields.
    if (key === "sv" || key === "cpuCores" || key === "sf" || key === "sab" || key === "coi") {
      const n = Number(val);
      out[key] = Number.isFinite(n) ? n : val;
    } else {
      out[key] = val;
    }
  }
  return out as Partial<FeatureLogData>;
}

/** Encode host + render lines (newline-separated) for clipboard/MCP. */
export function encodeFeatureLogLines(host: FeatureLogData | null, render: FeatureLogData | null): string {
  const lines: string[] = [];
  if (host) lines.push(encodeFeatureLogLine(host));
  if (render) lines.push(encodeFeatureLogLine(render));
  return lines.join("\n");
}
