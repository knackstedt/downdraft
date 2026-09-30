// ============================================================================
// GamepadLib — declarative engine library descriptor for gamepad support.
//
// Games declare `libraries: [GamepadLib]` in their GameModule. The descriptor
// provides a GamepadHub (device discovery/battery/rumble/glyphs) and a
// GamepadSource for LocalPlayerManager wiring.
//
// SAB resolution order:
//   1. config.sab — caller-provided 'gamepad-devices' buffer
//   2. globalThis.__ddGamepad.sab — set by platform-native's host when the
//      downdraft_gamepad cdylib is loaded (already attached to the native
//      worker, so reads are live immediately)
//   3. fresh allocation — tests/browsers without a backend (empty table;
//      still valid for wiring against future sources)
// ============================================================================

import { resourceToken, type EngineLibrary } from "@downdraft/engine";
import type { GamepadSource } from "@downdraft/engine/input/local-player-manager";
import { GamepadDevicesChannel } from "@downdraft/engine/sab/gamepad-devices";
import { GamepadHub, type GamepadHubOptions } from "./hub";
import { SabGamepadSource } from "./source-sab";

export interface GamepadLibConfig {
  /** Pre-attached 'gamepad-devices' SAB (usually supplied by the host). */
  sab?: SharedArrayBuffer;
  /** Host rumble hook — defaults to __ddGamepad.rumble on native. */
  rumble?: GamepadHubOptions["rumble"];
}

/** Token for the renderer-side GamepadHub (device discovery, battery, rumble). */
export const GamepadHubTok = resourceToken<GamepadHub>("gamepad:hub");
/** Token for the GamepadSource to install via LocalPlayerManager.setGamepadSource(). */
export const GamepadSourceTok = resourceToken<GamepadSource>("gamepad:source");

function resolveSab(config: GamepadLibConfig): SharedArrayBuffer {
  if (config.sab) return config.sab;
  const host = (globalThis as { __ddGamepad?: { sab?: SharedArrayBuffer } }).__ddGamepad;
  if (host?.sab) return host.sab;
  return GamepadDevicesChannel.allocate();
}

function resolveRumble(config: GamepadLibConfig): GamepadHubOptions["rumble"] {
  if (config.rumble) return config.rumble;
  const host = (globalThis as { __ddGamepad?: { rumble?: GamepadHubOptions["rumble"] } }).__ddGamepad;
  return host?.rumble?.bind(host);
}

export const GamepadLib: EngineLibrary<GamepadLibConfig, unknown, { hub: GamepadHub; source: SabGamepadSource }> = {
  name: "gamepad",
  version: "1.0.0",

  // The channel buffer is host-supplied (pre-attached to the native worker);
  // we don't declare it in sabChannels — LibraryHost would allocate a second,
  // unattached buffer.
  provides: [GamepadHubTok, GamepadSourceTok],

  renderer: {
    create(config, ctx) {
      const sab = resolveSab(config);
      const hub = new GamepadHub(sab, { rumble: resolveRumble(config) });
      const source = new SabGamepadSource(sab);
      ctx.provide(GamepadHubTok, hub);
      ctx.provide(GamepadSourceTok, source);
      return { hub, source };
    },
    dispose() {},
  },
};
