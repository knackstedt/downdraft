// ============================================================================
// jsx-dev-runtime.ts — dev-mode JSX entry point.
//
// Vite/TS emit `jsxDEV` calls against "<jsxImportSource>/jsx-dev-runtime"
// when jsxDev is enabled; the production transform uses "./jsx-runtime".
// Same implementation — jsxDEV's extra args (key, isStaticChildren, source,
// self) are ignored by this markup serializer.
// ============================================================================

export { jsx, jsxs, jsxDEV, Fragment, renderHtml } from "./jsx-runtime";
export type { VNode, Component, Child } from "./jsx-runtime";
export type { JSX } from "./jsx-runtime";
