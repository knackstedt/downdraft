// ============================================================================
// web/mirror.ts — WebDevtoolsMirror: the web transport for devtools data.
//
// Same provider/command surface as the Blitz devtools host — all the work
// lives in the shared DevtoolsBackend; this subclass just wires the emit
// sink to the DevToolsServer WebSocket and reports client presence.
// ============================================================================

import { DevtoolsBackend, slotName } from "../backend";
import type { CdpBridge } from "../cdp-bridge";
import type { DevToolsServer } from "./server";

export { slotName };

export interface WebMirrorOptions {
  server: DevToolsServer;
  cdp: CdpBridge;
  renderer: unknown;
  gameScene?: unknown;
  profilingSAB: SharedArrayBuffer | null;
}

export class WebDevtoolsMirror extends DevtoolsBackend {
  constructor(opts: WebMirrorOptions) {
    super({
      emit: (event, data) => opts.server.emit(event, data),
      hasClient: () => opts.server.clientCount > 0,
      cdp: opts.cdp,
      renderer: opts.renderer,
      gameScene: opts.gameScene,
      profilingSAB: opts.profilingSAB,
    });
    opts.server.setHello(() => ({
      version: 1,
      panels: this.providerSlots(),
      inspector: this.inspectorMethodNames(),
    }));
  }
}
