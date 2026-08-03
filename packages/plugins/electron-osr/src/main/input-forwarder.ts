// ============================================================================
// Input Forwarder — Routes input events from renderer to OSR BrowserWindows
// ============================================================================

import type { OSRRendererManager } from "./osr-renderer-manager.ts";
import type { OSRInputEvent } from "../types.ts";

export class InputForwarder {
  private manager: OSRRendererManager;

  constructor(manager: OSRRendererManager) {
    this.manager = manager;
  }

  /** Forwards an input event to the correct OSR renderer. */
  forward(event: OSRInputEvent): void {
    const renderer = this.manager.getRenderer(event.rendererId);
    if (!renderer) return;
    const { rendererId: _rendererId, ...eventData } = event;
    renderer.sendInputEvent(eventData);
  }
}
