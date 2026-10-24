// ============================================================================
// register.ts — registers all panel factories into the panel registry.
// Called once from game-module before the host module mounts.
// ============================================================================

import type { RendererModuleContext } from "@downdraft/engine/module/renderer-module";
import { ConsoleSurface } from "../surfaces/console";
import { EventsSurface } from "../surfaces/events";
import { GpuSurface } from "../surfaces/gpu";
import { NetworkSurface } from "../surfaces/network";
import { PerfMonSurface } from "../surfaces/perfmon";
import { PluginsSurface } from "../surfaces/plugins";
import { ProfilerSurface } from "../surfaces/profiler";
import { ProviderSurface } from "../surfaces/provider";
import { SourceSurface } from "../surfaces/source";
import { SourcesSurface } from "../surfaces/sources";
import { ThreadsSurface } from "../surfaces/threads";
import { WorldSurface } from "../surfaces/world";
import { RunCache } from "../text/run-cache";
import { registerPanel, setFallbackFactory, surfaceHandle, type PanelCtx } from "./panels";

/** Shared resources handed to surface factories at module init. */
export interface SurfaceFactoryCtx {
  mctx: RendererModuleContext;
  cache: RunCache;
  /** ScreenUiCompositor.order — embedded mounts use a high value so the
   *  devtools pass draws above the host game's own screen-space UI. */
  order: number;
}

let surfCtx: SurfaceFactoryCtx | null = null;

export function setSurfaceCtx(c: SurfaceFactoryCtx): void {
  surfCtx = c;
}

function regSurf<S extends { setRect(r: { x: number; y: number; w: number; h: number }): void; setActive(b: boolean): void; tick?(dt: number): void; dispose?(): void } & import("@downdraft/engine/module/renderer-module").ScreenUiCompositor>(
  id: string, title: string, make: (mctx: import("@downdraft/engine/module/renderer-module").RendererModuleContext, cache: RunCache, pctx: PanelCtx) => S,
): void {
  registerPanel(id, title, (pctx: PanelCtx) => {
    if (!surfCtx) throw new Error("surface ctx not ready");
    const s = make(surfCtx.mctx, surfCtx.cache, pctx);
    s.order = surfCtx.order;
    surfCtx.mctx.registerUiCompositor?.(s);
    return surfaceHandle(id, title, s);
  });
}

export function registerAllPanels(): void {
  regSurf("console", "Console", (m, c, p) => new ConsoleSurface(m, c, p));
  regSurf("profiler", "Profiler", (m, c, p) => new ProfilerSurface(m, c, p));
  regSurf("perfmon", "Performance", (m, c, p) => new PerfMonSurface(m, c, p));
  regSurf("threads", "Threads", (m, c, p) => new ThreadsSurface(m, c, p));
  regSurf("sources", "Sources", (m, c, p) => new SourcesSurface(m, c, p));
  regSurf("world", "World", (m, c, p) => new WorldSurface(m, c, p));
  regSurf("gpu", "GPU", (m, c, p) => new GpuSurface(m, c, p));
  regSurf("plugins", "Plugins", (m, c, p) => new PluginsSurface(m, c, p));
  regSurf("events", "Events", (m, c, p) => new EventsSurface(m, c, p));
  regSurf("network", "Network", (m, c, p) => new NetworkSurface(m, c, p));
  regSurf("source", "Source", (m, c, p) => new SourceSurface(m, c, p));

  // Dynamic provider panels — tab/dock ids are `panel:<slot>`; `provider-<slot>`
  // remains an accepted alias for manual ids.
  setFallbackFactory((id, pctx) => {
    const m = /^(?:panel|provider)[-:](\d+)$/.exec(id);
    if (!m || !surfCtx) return null;
    const slot = Number(m[1]);
    const name = pctx.session()?.providers.find((x) => x.slot === slot)?.name ?? `slot ${slot}`;
    const s = new ProviderSurface(surfCtx.mctx, surfCtx.cache, pctx, slot, name);
    s.order = surfCtx.order;
    surfCtx.mctx.registerUiCompositor?.(s);
    return surfaceHandle(id, name, s);
  });
}
