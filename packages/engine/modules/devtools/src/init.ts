// ============================================================================
// initDevTools — one-line DevTools wiring for games.
//
// Replaces the per-game boilerplate of:
//   1. Creating an IDevToolsDataRenderer adapter
//   2. Instantiating DevToolsDataBridge (or BaseSceneInspector)
//   3. Calling init()
//   4. Wiring sim stats provider, panel extensions, overlay toggles, etc.
//
// Also merges globally-registered panels/feeds/commands from the `devtools`
// singleton (registered by plugins via ctx.devtools.registerPanel() etc.)
// and from worker manifests (via syncWorkerManifests).
//
// Returns the bridge instance for games that need post-init calls
// (e.g. to-the-ocean's sceneInspector.setSimBridge()).
// ============================================================================

import { _devtoolsImpl, devtools, DevToolsAPITok } from "./api";
import { DevToolsDataBridge } from "./data-bridge";
import { ProfilingBridge, type ProfilingBridgeOptions } from "./profiling-bridge";
import { createDevToolsRendererAdapter } from "./renderer-adapter";
import { BaseSceneInspector } from "./scene-inspector";
import type {
    IAssetResolver,
    IDebugModeProvider,
    IDebugOverlayProvider,
    IDevToolsOverlayToggle,
    IDevToolsPanelExtension,
    IDevToolsRenderer,
    IPerformanceMetricsProvider,
    ISimStatsProvider,
} from "./types";
import { syncWorkerManifests, type WorkerSyncEntry } from "./worker-sync";

export interface InitDevToolsOptions {
  // --- Panel extensions & toggles (game-declared) ---
  panels?: IDevToolsPanelExtension[];
  overlayToggles?: IDevToolsOverlayToggle[];

  // --- Providers (game-specific) ---
  simStatsProvider?: ISimStatsProvider & { start?: () => void; stop?: () => void };
  debugOverlayProvider?: IDebugOverlayProvider;
  debugModeProvider?: IDebugModeProvider;
  performanceMetricsProvider?: IPerformanceMetricsProvider;
  assetResolver?: IAssetResolver;

  // --- Scene inspector (3D games) ---
  /** Use BaseSceneInspector instead of DevToolsDataBridge. Auto-detected if renderer implements IDevToolsRenderer. */
  sceneInspector?: boolean;
  /** Custom bridge class (extends BaseSceneInspector). If provided, sceneInspector is implied. */
  bridgeClass?: new () => BaseSceneInspector;

  // --- Worker sync ---
  /** Worker hosts to sync manifests from. Data feeds read from SAB, commands forwarded via worker RPC. */
  workerHosts?: WorkerSyncEntry[];

  // --- Renderer ---
  /** The renderer instance. If omitted, uses an empty adapter (for testing). */
  renderer?: any;

  // --- Profiling ---
  /** Enable the profiling system (ProfilingSAB + ProfilingBridge + built-in views).
   *  When true, a ProfilingBridge is created and the ProfilingSAB is shared
   *  with all workers + the pixi-ui overlay. Default: false. */
  profiling?: boolean | ProfilingBridgeOptions;
}

/**
 * Initialize DevTools with one call. Creates the bridge, wires all providers,
  merges globally-registered panels/feeds/commands, syncs worker manifests,
 * and exposes the API on window.__sceneInspector.
 *
 * Returns the bridge instance.
 */
export async function initDevTools(renderer: any, options: InitDevToolsOptions = {}): Promise<DevToolsDataBridge> {
  // 1. Build the renderer adapter (auto-discovers framework capabilities)
  const adapter = createDevToolsRendererAdapter(renderer);

  // 2. Determine bridge type
  const useSceneInspector = options.sceneInspector
    || !!options.bridgeClass
    || isSceneRenderer(renderer);

  // 3. Register game-declared panels/toggles into the global registry
  //    (these merge with plugin-registered ones)
  if (options.panels) {
    options.panels.forEach((panel) => {
      devtools.registerPanel(panel);
    });
  }
  if (options.overlayToggles) {
    options.overlayToggles.forEach((toggle) => {
      devtools.registerOverlayToggle(toggle);
    });
  }

  // 4. Sync worker manifests (fetches panels/feeds/commands from sim workers)
  if (options.workerHosts && options.workerHosts.length > 0) {
    await syncWorkerManifests(options.workerHosts);
  }

  // 4b. Inject devtools into the renderer's plugin host so renderer plugins
  //     can self-register via ctx.devtools.register*(...).
  const rendererModuleHost = renderer?.getRendererModuleHost?.();
  if (rendererModuleHost && typeof rendererModuleHost.setDevToolsAPI === "function") {
    rendererModuleHost.setDevToolsAPI(devtools);
  }
  // Also provide the API as a DI token so engine libraries can inject it
  // (ctx.injectOptional(DevToolsAPITok)) instead of importing the singleton.
  if (rendererModuleHost && typeof rendererModuleHost.provideExternal === "function") {
    rendererModuleHost.provideExternal("devtools", DevToolsAPITok, devtools);
  }

  // 5. Create the bridge
  let bridge: DevToolsDataBridge;
  if (useSceneInspector) {
    const BridgeClass = (options.bridgeClass ?? BaseSceneInspector) as new () => BaseSceneInspector;
    bridge = new BridgeClass();
    (bridge as BaseSceneInspector).init(renderer as IDevToolsRenderer);
  } else {
    bridge = new DevToolsDataBridge();
    bridge.init(adapter);
  }

  // 6. Wire providers
  if (options.simStatsProvider) {
    wireSimStatsProvider(bridge, options.simStatsProvider);
  }
  if (options.debugOverlayProvider) {
    wireDebugOverlayProvider(bridge, options.debugOverlayProvider);
  }
  if (options.debugModeProvider) {
    wireDebugModeProvider(bridge, options.debugModeProvider);
  }
  if (options.performanceMetricsProvider) {
    wirePerformanceMetricsProvider(bridge, options.performanceMetricsProvider);
  }

  // 7. Merge globally-registered panels/toggles/feeds/commands into the bridge
  //    The bridge's getPanelExtensions()/getOverlayToggles() already returns
  //    game-declared ones; we augment the __sceneInspector API with
  //    plugin-registered data feeds and commands.
  mergeGlobalRegistrations(bridge);

  // 8. Initialize the profiling system (if enabled)
  if (options.profiling) {
    const profilingOpts = typeof options.profiling === "object" ? options.profiling : {};
    const profilingBridge = new ProfilingBridge(profilingOpts);
    (bridge as any)._profilingBridge = profilingBridge;
    // Expose the ProfilingSAB + views on __sceneInspector for the profiler overlay
    const api = (window as any).__sceneInspector;
    if (api) {
      api.__getProfilingSAB = () => profilingBridge.getProfilingSAB();
      api.__getProfilingBridge = () => profilingBridge;
      api.__getViews = () => devtools.getViews();
    }
  }

  return bridge;
}

// --- Helpers ---

function isSceneRenderer(renderer: any): boolean {
  if (!renderer) return false;
  // Feature-detect: IDevToolsRenderer requires these methods
  return typeof renderer.setGizmoPosition === "function"
    && typeof renderer.uploadModel === "function";
}

function wireSimStatsProvider(bridge: DevToolsDataBridge, provider: ISimStatsProvider & { start?: () => void }): void {
  // The bridge's getSimStatsProvider() is overridden via a closure hack:
  // We store the provider on the bridge instance and override the protected method.
  (bridge as any)._simStatsProvider = provider;
  (bridge as any).getSimStatsProvider = () => provider;
  // Start polling if the provider has a start() method (from createSimStatsProvider)
  provider.start?.();
}

function wireDebugOverlayProvider(bridge: DevToolsDataBridge, provider: any): void {
  (bridge as any)._debugOverlayProvider = provider;
  (bridge as any).getDebugOverlayProvider = () => provider;
}

function wireDebugModeProvider(bridge: DevToolsDataBridge, provider: any): void {
  (bridge as any)._debugModeProvider = provider;
  (bridge as any).getDebugModeProvider = () => provider;
}

function wirePerformanceMetricsProvider(bridge: DevToolsDataBridge, provider: any): void {
  (bridge as any)._performanceMetricsProvider = provider;
  (bridge as any).getPerformanceMetricsProvider = () => provider;
}

/**
 * Merge globally-registered panels, data feeds, and commands from the `devtools`
 * singleton into the bridge's __sceneInspector API.
 *
 * - Panels: merged into getPanelExtensions() (game panels + plugin panels)
 * - Data feeds: added as methods on __sceneInspector (called synchronously)
 * - Commands: added as methods on __sceneInspector (forwarded to worker or called directly)
 * - SAB stats: added as methods on __sceneInspector (read from SAB)
 */
function mergeGlobalRegistrations(bridge: DevToolsDataBridge): void {
  const manifest = devtools.getManifest();

  // Augment getPanelExtensions to merge global registry panels
  const originalGetPanels = (bridge as any).getPanelExtensions?.bind(bridge);
  (bridge as any).getPanelExtensions = (): IDevToolsPanelExtension[] => {
    const gamePanels = originalGetPanels?.() ?? [];
    // Merge: game panels take precedence on id collisions
    const merged = new Map<string, IDevToolsPanelExtension>();
    manifest.panels.forEach((p) => { merged.set(p.id, p);; });
    gamePanels.forEach((p: any) => { merged.set(p.id, p);; });
    return Array.from(merged.values()).sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  };

  // Augment getOverlayToggles to merge global registry toggles
  const originalGetToggles = (bridge as any).getOverlayToggles?.bind(bridge);
  (bridge as any).getOverlayToggles = (): IDevToolsOverlayToggle[] => {
    const gameToggles = originalGetToggles?.() ?? [];
    const merged = new Map<string, IDevToolsOverlayToggle>();
    manifest.toggles.forEach((t) => { merged.set(t.id, t);; });
    gameToggles.forEach((t: any) => { merged.set(t.id, t);; });
    return Array.from(merged.values());
  };

  // Add data feed methods to the __sceneInspector API
  // These are called synchronously by the panel via callInspector()
  const api = (window as any).__sceneInspector;
  if (api) {
    for (let _i = 0, _it = manifest.dataFeeds, _n = _it.length; _i < _n; _i++) { const feed = _it[_i];
      if (typeof api[feed.name] === "function") continue; // don't override game-provided
      const feedName = feed.name;
      api[feedName] = (): any => {
        // Main realm: call the registered fn directly
        const fn = _devtoolsImpl.getDataFeedFn(feedName);
        if (fn) return fn();
        // Worker realm: read from SAB
        return _devtoolsImpl.readDataFeed(feed.feedIndex);
      };
    }

    // Add command methods
    for (let _i = 0, _it = manifest.commands, _n = _it.length; _i < _n; _i++) { const cmdName = _it[_i];
      if (typeof api[cmdName] === "function") continue;
      api[cmdName] = (...args: any[]): any => {
        return _devtoolsImpl.callCommand(cmdName, args);
      };
    }

    // Add SAB stat methods (get{Name} → number)
    for (let _i = 0, _it = manifest.sabStats, _n = _it.length; _i < _n; _i++) { const stat = _it[_i];
      const methodName = `get${stat.name.charAt(0).toUpperCase()}${stat.name.slice(1)}`;
      if (typeof api[methodName] === "function") continue;
      api[methodName] = (): number | null => {
        return _devtoolsImpl.readSABStat(stat.name);
      };
    }
  }
}
