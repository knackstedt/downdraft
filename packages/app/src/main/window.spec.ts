import { describe, expect, it } from "bun:test";
import { buildCrossOriginIsolationHeaders } from "./window";

describe("buildCrossOriginIsolationHeaders", () => {
  it("sets COOP for all responses", () => {
    const headers = buildCrossOriginIsolationHeaders("http://localhost:5173/index.html");
    expect(headers["Cross-Origin-Opener-Policy"]).toEqual(["same-origin"]);
  });

  it("sets COEP for HTTP responses (dev server)", () => {
    const headers = buildCrossOriginIsolationHeaders("http://localhost:5173/assets/worker.js");
    expect(headers["Cross-Origin-Embedder-Policy"]).toEqual(["require-corp"]);
  });

  it("sets COEP for HTTPS responses", () => {
    const headers = buildCrossOriginIsolationHeaders("https://example.com/index.html");
    expect(headers["Cross-Origin-Embedder-Policy"]).toEqual(["require-corp"]);
  });

  it("does NOT set COEP for file:// responses (packaged builds)", () => {
    // This is the critical test: COEP breaks Web Worker loading from file://
    // in Chromium/Electron. Worker scripts are never fetched and Worker.onerror
    // fires with an undefined message. See the function's doc comment for details.
    const headers = buildCrossOriginIsolationHeaders("file:///app/dist/renderer/index.html");
    expect(headers["Cross-Origin-Opener-Policy"]).toEqual(["same-origin"]);
    expect(headers["Cross-Origin-Embedder-Policy"]).toBeUndefined();
  });

  it("does NOT set COEP for file:// worker assets", () => {
    const headers = buildCrossOriginIsolationHeaders("file:///app/dist/renderer/assets/mining-worker-abc123.js");
    expect(headers["Cross-Origin-Embedder-Policy"]).toBeUndefined();
  });

  it("preserves existing response headers", () => {
    const existing = { "Content-Type": ["text/javascript"], "Cache-Control": ["no-cache"] };
    const headers = buildCrossOriginIsolationHeaders("http://localhost:5173/script.js", existing);
    expect(headers["Content-Type"]).toEqual(["text/javascript"]);
    expect(headers["Cache-Control"]).toEqual(["no-cache"]);
    expect(headers["Cross-Origin-Opener-Policy"]).toEqual(["same-origin"]);
    expect(headers["Cross-Origin-Embedder-Policy"]).toEqual(["require-corp"]);
  });

  it("preserves existing headers for file:// responses", () => {
    const existing = { "Content-Type": ["text/html"] };
    const headers = buildCrossOriginIsolationHeaders("file:///app/dist/renderer/index.html", existing);
    expect(headers["Content-Type"]).toEqual(["text/html"]);
    expect(headers["Cross-Origin-Embedder-Policy"]).toBeUndefined();
  });
});
