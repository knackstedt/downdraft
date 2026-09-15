// ============================================================================
// render.ts — Browser reference renderer (Playwright _electron + WebGPU).
//
// The system google-chrome does not expose WebGPU, but the project's bundled
// Electron (Chromium + swiftshader/hardware WebGPU) does — the same path the
// e2e tests use. We drive it via Playwright's `_electron` support so the
// reference rendering uses a real browser WebGPU backend.
//
// Flow:
//   1. Bun.build bundles the browser entry (scene registry + pixi.js).
//   2. A static Bun.serve hosts page.html, the bundle, and the font assets.
//   3. Playwright launches the Electron main (electron-main.mjs) pointed at
//      the static URL.
//   4. The renderer page builds the scene and sets window.__PIXI_READY__.
//   5. We screenshot the canvas element and save it as the reference PNG.
// ============================================================================

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright-core";

const ROOT = resolve(import.meta.dir, "..");
const ASSETS_DIR = join(ROOT, "assets");
const BROWSER_DIR = join(ROOT, "browser");
const ENTRY = join(BROWSER_DIR, "entry.ts");
const PAGE_HTML = join(BROWSER_DIR, "page.html");
const ELECTRON_MAIN = join(BROWSER_DIR, "electron-main.mjs");
const ELECTRON_BIN = resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "node_modules",
  "electron",
  "dist",
  "electron",
);

let bundleBuilt = false;
const BUNDLE_PATH = join(BROWSER_DIR, "entry.js");

/** Bundle the browser entry (scene registry + pixi.js) into a single JS file. */
async function ensureBundle(): Promise<void> {
  if (bundleBuilt && existsSync(BUNDLE_PATH)) return;
  const result = await Bun.build({
    entrypoints: [ENTRY],
    outdir: BROWSER_DIR,
    target: "browser",
    format: "esm",
    splitting: false,
    sourcemap: "none",
    minify: false,
  });
  if (!result.success) {
    throw new Error(
      `Bun.build failed:\n${result.logs.map((l) => String(l)).join("\n")}`,
    );
  }
  bundleBuilt = true;
}

/** Start a static server hosting the harness page, bundle, and font assets. */
function startServer(): { url: string; stop: () => Promise<void> } {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      let path = url.pathname;
      if (path === "/") path = "/page.html";
      if (path === "/entry.js") {
        const file = Bun.file(BUNDLE_PATH);
        if (await file.exists()) return new Response(file, { headers: { "Content-Type": "application/javascript" } });
      }
      if (path.startsWith("/assets/")) {
        const file = Bun.file(join(ASSETS_DIR, path.slice("/assets/".length)));
        if (await file.exists()) {
          const ext = path.endsWith(".ttf") ? "font/ttf" : "application/octet-stream";
          return new Response(file, { headers: { "Content-Type": ext } });
        }
      }
      if (path === "/page.html") {
        const file = Bun.file(PAGE_HTML);
        return new Response(file, { headers: { "Content-Type": "text/html" } });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) };
}

export interface BrowserRenderResult {
  path: string;
  width: number;
  height: number;
}

/**
 * Render a single scene in the browser (Electron + WebGPU) and capture a
 * canvas screenshot. `onLog` receives human-readable progress lines.
 */
export async function renderBrowser(
  sceneId: string,
  outPath: string,
  onLog?: (msg: string) => void,
): Promise<BrowserRenderResult> {
  await ensureBundle();
  const server = startServer();
  const log = (m: string) => onLog?.(`[browser] ${m}`);

  if (!existsSync(ELECTRON_BIN)) {
    throw new Error(`Electron binary not found at ${ELECTRON_BIN}`);
  }

  const harnessUrl = `${server.url}/?scene=${encodeURIComponent(sceneId)}`;
  log(`launching Electron for ${harnessUrl}`);

  const electronApp = await electron.launch({
    executablePath: ELECTRON_BIN,
    args: [ELECTRON_MAIN],
    env: {
      ...process.env,
      HARNESS_URL: harnessUrl,
      HARNESS_W: "1024",
      HARNESS_H: "1024",
      // Default to swiftshader (software WebGPU) for reproducible headless
      // rendering. Set DOWNDRAFT_GPU=hardware to use the real GPU.
      DOWNDRAFT_GPU: process.env.DOWNDRAFT_GPU ?? "swiftshader",
      ELECTRON_RUN_AS_NODE: "",
    } as any,
    timeout: 60000,
  });

  try {
    const page = await electronApp.firstWindow();
    page.on("console", (msg) => log(`console.${msg.type()}: ${msg.text()}`));
    page.on("pageerror", (err) => log(`pageerror: ${err.message}`));

    // Wait for the harness to signal readiness (or an error).
    await page.waitForFunction(
      () => (window as any).__PIXI_READY__ === true,
      { timeout: 45000 },
    );
    const err = await page.evaluate(() => (window as any).__PIXI_ERROR__);
    if (err) throw new Error(`Browser harness error: ${err}`);

    // Give the GPU a moment to finish the frame, then screenshot the canvas.
    await page.waitForTimeout(300);
    const canvas = page.locator("#canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("Canvas has no bounding box");

    mkdirSync(resolve(outPath, ".."), { recursive: true });
    await canvas.screenshot({ path: outPath, omitBackground: false });
    log(`screenshot saved: ${outPath} (${Math.round(box.width)}x${Math.round(box.height)})`);

    return { path: outPath, width: Math.round(box.width), height: Math.round(box.height) };
  } finally {
    try { await electronApp.close(); } catch { /* ignore */ }
    await server.stop();
  }
}
