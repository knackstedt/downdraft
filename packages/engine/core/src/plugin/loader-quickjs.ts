// ============================================================================
// QuickjsPluginLoader — loads `quickjs` format (script-tier) plugins.
//
// QuickJS plugins run in-process on the renderer thread inside a QuickJS WASM
// VM. The VM provides hard isolation: only the host-bridged `ddPlugin` global
// exists. This loader:
//   1. Fetches the singleton QuickJS WASM module (lazy, cached).
//   2. Creates a runtime + context via createQuickjsBridge.
//   3. Fetches the plugin entry JS source (the manifest `entry` URL).
//   4. Evals the source (which defines a `register` global function).
//   5. Calls `register(ddPlugin)`.
//   6. On dispose, disposes the VM.
// ============================================================================

import { createLogger } from "../util/logger";
import type { ScriptPluginContext } from "./context";
import type { PluginLoader } from "./host";
import type { PluginManifest } from "./manifest";
import type { PermissionGrant } from "./permissions";
import { createQuickjsBridge, type QuickjsBridge } from "./quickjs-bridge";

const log = createLogger("info");

let modulePromise: Promise<import("quickjs-emscripten").QuickJSWASMModule> | null = null;

async function getModule(): Promise<import("quickjs-emscripten").QuickJSWASMModule> {
  if (!modulePromise) {
    // Dynamic import so the QuickJS wasm is only loaded when a quickjs plugin
    // is actually used. The singlefile-browser variant inlines the wasm.
    const mod = await import("quickjs-emscripten");
    modulePromise = mod.getQuickJS();
  }
  return modulePromise;
}

export class QuickjsPluginLoader implements PluginLoader {
  readonly format = "quickjs" as const;
  private bridges = new Map<string, QuickjsBridge>();

  async load(
    manifest: PluginManifest,
    ctx: ScriptPluginContext,
    _granted: PermissionGrant,
  ): Promise<(() => void) | void> {
    const module = await getModule();
    const bridge = createQuickjsBridge(module, ctx, {
      pluginId: manifest.id,
      instructionBudget: manifest.quickjs?.instructionBudget,
    });
    this.bridges.set(manifest.id, bridge);

    // Fetch the plugin entry source.
    const entryUrl = manifest.entry!;
    let source: string;
    try {
      const resp = await fetch(entryUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      source = await resp.text();
    } catch (e) {
      bridge.dispose();
      this.bridges.delete(manifest.id);
      throw new Error(`Failed to fetch QuickJS plugin entry "${entryUrl}": ${(e as Error).message}`);
    }

    // Eval the source — it should define a `register` function on the global.
    bridge.eval(source, entryUrl);

    // Call register(ddPlugin) — the bridged global is available in the VM.
    bridge.eval(`register(ddPlugin);`, `${entryUrl}#register`);

    bridge.drainJobs();
    log.info("quickjs-plugin-loader", `Loaded QuickJS plugin "${manifest.id}"`);

    return () => {
      bridge.dispose();
      this.bridges.delete(manifest.id);
    };
  }

  disposeAll(): void {
    for (const [, b] of this.bridges.entries()) b.dispose();
    this.bridges.clear();
  }
}
