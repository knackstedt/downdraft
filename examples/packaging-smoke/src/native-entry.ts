// ============================================================================
// native-entry.ts — packaging smoke fixture
//
// Exercises every rewrite the desktop packagers perform: Worker entrypoints,
// asset globs, and new URL(...) asset refs. With DD_PACKAGING_SMOKE=1 it runs
// headless — no window — prints DD_SMOKE_OK and exits, which is what CI
// asserts on for every format × runtime permutation. Without the env var it
// opens a minimal native window (manual smoke).
// ============================================================================

import { createGlob } from "@downdraft/engine/platform/glob-polyfill";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SMOKE = process.env.DD_PACKAGING_SMOKE === "1";

// Node hosts expose no Worker global — the engine's BrowserWorker polyfill is
// installed by the native host, which needs a window. Headless CI goes
// through worker_threads directly, with the engine's own browser-API
// bootstrap (staged into dd-assets by the packagers) supplying self /
// postMessage / onmessage inside the worker.
async function spawnNodeWorker() {
  const { Worker: NodeWorker } = await import("node:worker_threads");
  // meta.url is the real emitted module URL (unrewritten) — the sibling
  // smoke.worker.mjs sits beside it in the emitted bundle tree.
  const meta = import.meta;
  const workerUrl = new URL("./smoke.worker.mjs", meta.url);
  const bootstrapPath = fileURLToPath(
    new URL("../../../packages/platform-native/src/ffi/worker-bootstrap.mjs", import.meta.url),
  );
  const w = new NodeWorker(workerUrl, { execArgv: ["--import", bootstrapPath] });
  return {
    set onmessage(h: (ev: { data: unknown }) => void) {
      w.on("message", (data: unknown) => h({ data }));
    },
    postMessage(m: unknown) {
      w.postMessage(m);
    },
    terminate() {
      void w.terminate();
    },
  };
}

const worker =
  typeof Worker !== "undefined"
    ? new Worker(new URL("./smoke.worker.ts", import.meta.url).href, { type: "module" })
    : await spawnNodeWorker();
const pong = await new Promise<{ data: unknown }>((resolve) => {
  worker.onmessage = resolve;
  worker.postMessage({ ping: 1 });
});
worker.terminate();

// Asset glob — createGlob(modDir) is the canonical packaged-glob call: the
// packagers stage the matched files into dd-assets and rewrite
// import.meta.dir to the staged module dir. In dev it reads the real dir.
const urls = createGlob(import.meta.dir)("./assets/*.txt") as Record<string, string>;
const bodies = Object.values(urls).map((u) => readFileSync(fileURLToPath(u), "utf-8").trim());

// new URL asset ref — rewritten to an absolute dd-assets URL at package time.
const hello = readFileSync(fileURLToPath(new URL("./assets/hello.txt", import.meta.url)), "utf-8").trim();

if (SMOKE) {
  console.log(
    `DD_SMOKE_OK worker=${JSON.stringify(pong.data)} globs=${Object.keys(urls).length} asset=${hello}`,
  );
  process.exit(0);
}

// Manual path: open a real window so the package can be clicked through.
const { createNativeHost } = await import("@downdraft/platform-native");
const host = await createNativeHost({ window: { width: 640, height: 480, title: "packaging-smoke" } });
console.log(`DD_SMOKE_OK window worker=${JSON.stringify(pong.data)} asset=${hello}`);
// Keep the vsync loop alive so the window can be clicked through manually.
const pump = () => host.requestAnimationFrame(pump);
host.requestAnimationFrame(pump);
