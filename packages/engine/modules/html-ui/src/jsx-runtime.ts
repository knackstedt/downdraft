// ============================================================================
// jsx-runtime.ts — minimal JSX→markup runtime for html-ui panels.
//
// Games write .tsx components with
//   /** @jsxImportSource @downdraft/engine/modules/html-ui */
// which call these exports to build vnode trees; `renderHtml(v)` serializes
// to the markup string handed to a panel doc. There is no DOM and no vdom
// diffing — re-render a panel on state change, or use mutator ops for hot
// paths (progress bars, tickers).
//
// Interactivity: `data-*` attributes pass through (data-action drives the
// event channel); `on*` props are rejected — events arrive via the doc's DOM
// event queue, dispatched by data-action / selector handlers.
// ============================================================================

import { createLogger } from "@downdraft/engine";

const log = createLogger();

export interface VNode {
  t: string | Component | typeof Fragment;
  p: Record<string, unknown> | null;
  k?: unknown;
}
export type Component = (props: Record<string, unknown>) => VNode | VNode[] | string | number | null;
export type Child = VNode | string | number | boolean | null | undefined | Child[];

export const Fragment = Symbol.for("ddx.fragment");

const KEY = Symbol.for("ddx.jsx.key");

function vnode(t: VNode["t"], p: Record<string, unknown> | null): VNode {
  return { t, p, k: p?.key };
}

export function jsx(t: VNode["t"], p: Record<string, unknown> | null): VNode { return vnode(t, p); }
export function jsxs(t: VNode["t"], p: Record<string, unknown> | null): VNode { return vnode(t, p); }
export function jsxDEV(t: VNode["t"], p: Record<string, unknown> | null): VNode { return vnode(t, p); }

const VOID = new Set(["area","base","br","col","embed","hr","img","input","link","meta","source","track","wbr"]);

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const UNITLESS = new Set(["opacity","zIndex","z-index","fontWeight","font-weight","lineHeight","line-height","flex","flexGrow","flex-grow","flexShrink","flex-shrink","order","gridArea"]);

function styleObjToCss(v: unknown): string {
  if (typeof v === "string") return v;
  if (!v || typeof v !== "object") return "";
  let out = "";
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val == null) continue;
    const prop = k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
    const s = typeof val === "number" && !UNITLESS.has(k) && !UNITLESS.has(prop) ? `${val}px` : String(val);
    out += `${prop}:${s};`;
  }
  return out;
}

let warnedOn = false;

function attrString(p: Record<string, unknown> | null): string {
  if (!p) return "";
  let out = "";
  for (const [k, v] of Object.entries(p)) {
    if (k === "children" || k === "key" || k === "dangerouslySetInnerHTML" || v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") {
      if (!warnedOn) { warnedOn = true; log.warn("html-ui", "on* props are ignored — use data-action + ui.onAction()"); }
      continue;
    }
    if (k === "className") { out += ` class="${esc(String(v))}"`; continue; }
    if (k === "htmlFor") { out += ` for="${esc(String(v))}"`; continue; }
    if (k === "style") { out += ` style="${esc(styleObjToCss(v))}"`; continue; }
    if (v === true) { out += ` ${k}`; continue; }
    out += ` ${k}="${esc(String(v))}"`;
  }
  return out;
}

function renderInner(c: Child | Child[], out: string[]): void {
  if (c == null || typeof c === "boolean") return;
  if (Array.isArray(c)) { c.forEach((x) => { renderInner(x, out);; }); return; }
  if (typeof c === "string" || typeof c === "number") { out.push(esc(String(c))); return; }
  out.push(renderNode(c));
}

function renderNode(v: VNode): string {
  const { t, p } = v;
  if (t === Fragment) {
    const out: string[] = [];
    renderInner(p?.children as Child, out);
    return out.join("");
  }
  if (typeof t === "function") {
    const r = t({ ...(p ?? {}) });
    const out: string[] = [];
    renderInner(r as Child, out);
    return out.join("");
  }
  const attrs = attrString(p);
  if (VOID.has(t)) return `<${t}${attrs}>`;
  const raw = (p as Record<string, unknown> | null)?.dangerouslySetInnerHTML as { __html?: string } | undefined;
  if (raw?.__html != null) return `<${t}${attrs}>${raw.__html}</${t}>`;
  const inner: string[] = [];
  renderInner(p?.children as Child, inner);
  return `<${t}${attrs}>${inner.join("")}</${t}>`;
}

/** Serialize a vnode tree to an HTML fragment string for a panel doc. */
export function renderHtml(v: Child): string {
  const out: string[] = [];
  renderInner(v, out);
  return out.join("");
}

// JSX namespace — permissive intrinsic element map so .tsx typechecks without
// a per-element DOM interface catalog.
export namespace JSX {
  export type Element = VNode;
  export interface ElementChildrenAttribute { children: unknown }
  export interface IntrinsicAttributes { key?: string | number }
  export interface IntrinsicElements {
    [elemName: string]: Record<string, unknown>;
  }
}
