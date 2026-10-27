// ============================================================================
// ControllerLib — declarative engine library descriptor for controller support.
//
// Apps declare `libraries: [ControllerLib]` in their AppModule. The descriptor
// provides a ControllerHub (device discovery/battery/rumble/glyphs) and a
// ControllerSource for LocalPlayerManager wiring.
//
// SAB resolution order:
//   1. config.sab — caller-provided 'controller-devices' buffer
//   2. globalThis.__ddController.sab — set by platform-native's host when the
//      downdraft_controller cdylib is loaded (already attached to the native
//      worker, so reads are live immediately)
//   3. fresh allocation — tests/browsers without a backend (empty table;
//      still valid for wiring against future sources)
// ============================================================================

import { resourceToken } from "@downdraft/engine/ecs/resource";
import type { EngineLibrary } from "@downdraft/engine/library/library";
import type { ControllerSource } from "@downdraft/engine/input/local-player-manager";
import { ControllerDevicesChannel } from "@downdraft/engine/sab/controller-devices";
import { ControllerHub, type ControllerHubOptions } from "./hub";
import { SabControllerSource } from "./source-sab";

export interface ControllerLibConfig {
  /** Pre-attached 'controller-devices' SAB (usually supplied by the host). */
  sab?: SharedArrayBuffer;
  /** Host rumble hook — defaults to __ddController.rumble on native. */
  rumble?: ControllerHubOptions["rumble"];
}

/** Token for the renderer-side ControllerHub (device discovery, battery, rumble). */
export const ControllerHubTok = resourceToken<ControllerHub>("controller:hub");
/** Token for the ControllerSource to install via LocalPlayerManager.setControllerSource(). */
export const ControllerSourceTok = resourceToken<ControllerSource>("controller:source");

function resolveSab(config: ControllerLibConfig): SharedArrayBuffer {
  if (config.sab) return config.sab;
  const host = (globalThis as { __ddController?: { sab?: SharedArrayBuffer } }).__ddController;
  if (host?.sab) return host.sab;
  return ControllerDevicesChannel.allocate();
}

function resolveRumble(config: ControllerLibConfig): ControllerHubOptions["rumble"] {
  if (config.rumble) return config.rumble;
  const host = (globalThis as { __ddController?: { rumble?: ControllerHubOptions["rumble"] } }).__ddController;
  return host?.rumble?.bind(host);
}

export const ControllerLib: EngineLibrary<ControllerLibConfig, unknown, { hub: ControllerHub; source: SabControllerSource }> = {
  name: "controller",
  version: "1.0.0",

  // The channel buffer is host-supplied (pre-attached to the native worker);
  // we don't declare it in sabChannels — LibraryHost would allocate a second,
  // unattached buffer.
  provides: [ControllerHubTok, ControllerSourceTok],

  renderer: {
    create(config, ctx) {
      const sab = resolveSab(config);
      const hub = new ControllerHub(sab, { rumble: resolveRumble(config) });
      const source = new SabControllerSource(sab);
      ctx.provide(ControllerHubTok, hub);
      ctx.provide(ControllerSourceTok, source);
      return { hub, source };
    },
    dispose() {},
  },
};
