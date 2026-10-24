// ============================================================================
// @downdraft/devtools — public surface.
//
//   Standalone viewer:  `draft devtools` (runs src/native-entry.ts), or
//                       `runNativeGameModule(gameModule)` from an app entry.
//   Embedded overlay:   mountDevtools(ctx, { overlay: true }) inside
//                       a game's GameModule.ui hook — F12 toggles.
// ============================================================================

export { mountDevtools, type DevtoolsMount, type DevtoolsMountOptions } from "./mount";
export { gameModule } from "./standalone";
export { mountMcpTools } from "./mcp/tools";
export { sessions, startTargetRuntime, stopTargetRuntime } from "./targets/runtime";
export {
  store,
  bumpTargets,
  bumpConsole,
  bumpMetrics,
  bumpEvents,
  mainTabsFor,
  targetHasWorld,
  MAIN_TABS,
} from "./app/store";
export type { AppState, DockId, DockState, Rect, TargetInfo, TargetKind, ChannelName } from "./app/store";
