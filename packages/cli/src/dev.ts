import { Builder, getBuilderConfig } from "@downdraft/core";

export async function dev(args: string[]): Promise<void> {
  const mode = args.includes("--debug") ? "debug" : "dev";
  const builder = new Builder(mode);
  const config = builder.getConfig();

  console.log(`[DownDraft] Starting in ${mode} mode...`);
  console.log(`[DownDraft] Webview: ${config.webview}`);
  console.log(`[DownDraft] Devtools: ${config.devtools}`);
  console.log(`[DownDraft] Telemetry: ${config.telemetry}`);
  console.log(`[DownDraft] Hot reload: ${config.hotReload}`);

  // TODO: Boot Electrobun with GpuWindow + BrowserWindow overlay
  // The actual Electrobun integration requires the electrobun npm package
  // and a native GpuWindow. For now, we document the boot sequence:
  //
  // 1. Create SAB channels (input, transform)
  // 2. Spawn sim worker (worker_threads + SAB transfer)
  // 3. Create GpuWindow (Electrobun native window with WGPU surface)
  // 4. Create BrowserWindow (transparent overlay for React UI)
  // 5. Load preload script → exposes downdraft RPC + SABs to renderer
  // 6. Load renderer HTML → React UI with FPS counter + devtools
  // 7. Start render loop (WGPU device + surface + opaque pass)
  // 8. Start sim loop (step sim worker at 60Hz, read SAB transforms)
  //
  // When Electrobun is installed:
  //   import { Electrobun } from "electrobun";
  //   const electrobun = new Electrobun();
  //   const gpuWindow = electrobun.createGpuWindow({ ... });
  //   const overlay = electrobun.createBrowserWindow({ transparent: true, ... });
  //   overlay.loadFile("packages/ui/index.html");

  console.log("");
  console.log("[DownDraft] Electrobun integration pending — install electrobun to boot the engine.");
  console.log("[DownDraft] The core engine (ECS, SAB, render loop, telemetry) is ready.");
  console.log("");
  console.log("[DownDraft] Press Ctrl+C to stop");
}
