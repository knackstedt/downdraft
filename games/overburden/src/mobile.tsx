// ============================================================================
// overburden — Mobile Entry Point
// ============================================================================
//
// Reuses the shared GameModule from game-module.ts (same renderer, sim, UI,
// and onReady wiring as desktop). Mobile adds touch input + an on-screen
// display (joystick + action buttons); desktop adds MCP + deterministic mode.
//
// Overburden uses a custom BlockheadsInputState (not the engine
// InputBufferWriter), so we provide a sinkFactory that constructs a
// BlockheadsInputSink from the game context's renderer. The OSD renders a
// movement joystick (left half, fades when idle) + action buttons (jump,
// mine, place, zoom, hotbar 1-9).
//

import { createDowndraftMobileApp, type TouchOsdButtonId } from "@downdraft/app/mobile";
import { overburdenModule } from "./game-module";
import { BlockheadsInputSink } from "./mobile/blockheads-touch-sink";
import { BlockheadsRenderer } from "./renderer/blockheads-renderer";

// Full control set: movement joystick (left half, auto-rendered by the OSD) +
// jump/mine/place/zoom buttons + hotbar slots 1-9.
const osdButtons: TouchOsdButtonId[] = [
  "jump",
  "mine",
  "place",
  "zoom-in",
  "zoom-out",
  { hotbar: 0 }, { hotbar: 1 }, { hotbar: 2 }, { hotbar: 3 }, { hotbar: 4 },
  { hotbar: 5 }, { hotbar: 6 }, { hotbar: 7 }, { hotbar: 8 },
];

createDowndraftMobileApp({
  appId: "com.downdraft.overburden",
  module: overburdenModule,

  touchInput: {
    // dual-stick: left half = movement joystick, right half = aim/mine.
    scheme: "dual-stick",
    // Overburden's renderer exposes getInput() (BlockheadsInputState), not an
    // InputBufferWriter — provide a sink that writes to it.
    sinkFactory: (ctx) => new BlockheadsInputSink(ctx.renderer as BlockheadsRenderer),
    // On-screen display: joystick + full action button set.
    osd: osdButtons,
  },
}).catch((e) => {
  console.error("[mobile] Fatal:", e);
});
