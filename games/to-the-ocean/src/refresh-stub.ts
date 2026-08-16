// React Fast Refresh stubs for the UI worker.
// This module MUST be imported first so the globals exist before any
// React-compiled module evaluates (ES imports are hoisted + run in order).
const g = globalThis as any;
if (typeof g.$RefreshReg$ === "undefined") g.$RefreshReg$ = () => {};
if (typeof g.$RefreshSig$ === "undefined") g.$RefreshSig$ = () => (type: unknown) => type;
if (typeof g.__REACT_REFRESH__ === "undefined") g.__REACT_REFRESH__ = { register: () => {}, sign: () => (type: unknown) => type };
