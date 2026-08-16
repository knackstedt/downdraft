// ============================================================================
// undertow-test — renders the ocean game's React UI in a worker via undertow.
//
// This module is loaded by the UI worker after the polyfill is installed.
// It renders the real App component into #root, proxied through undertow.
// ============================================================================

import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app";

export async function renderTestApp(): Promise<void> {
  const rootEl = document.getElementById("root");
  if (!rootEl) {
    console.error("[undertow] #root element not found");
    return;
  }

  // Delay the first render until the main thread is idle (next rAF).
  // This prevents the first sync call from blocking for 1-2 seconds while
  // the main thread is busy with WebGPU/physics/OSR initialization.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  const root = createRoot(rootEl as any);
  root.render(
    React.createElement(React.StrictMode, null, React.createElement(App)),
  );
  console.log("[undertow] React app rendered in worker");
}
