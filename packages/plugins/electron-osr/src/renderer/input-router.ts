// ============================================================================
// OSR Input Router — Raycasts against billboards and forwards input to OSR windows
// ============================================================================

import type { WorldSpaceUIElement, AtlasLayout, OSRInputEvent, OSRRendererStatus } from "../types.ts";
import type { CameraState } from "./world-space-ui-pass.ts";

export interface MouseState {
  x: number;
  y: number;
  buttons: number; // bitmask: 1=left, 2=right, 4=middle
  deltaX: number;
  deltaY: number;
  wheelDeltaX: number;
  wheelDeltaY: number;
}

export interface InputRouterConfig {
  /** Map of textureIndex → rendererId */
  textureIndexToRendererId: Map<number, string>;
  /** Map of rendererId → atlas layout (for atlas-mode renderers) */
  atlasLayouts: Map<string, AtlasLayout>;
  /** Map of rendererId → status */
  rendererStatuses: Map<string, OSRRendererStatus>;
}

export class OSRInputRouter {
  private config: InputRouterConfig;
  private sendInputEvent: (rendererId: string, event: Omit<OSRInputEvent, "rendererId">) => void;
  private hoveredElementId: string | null = null;
  private hoveredRendererId: string | null = null;
  private lastMouseX = -1;
  private lastMouseY = -1;
  private lastButtons = 0;

  constructor(
    config: InputRouterConfig,
    sendInputEvent: (rendererId: string, event: Omit<OSRInputEvent, "rendererId">) => void,
  ) {
    this.config = config;
    this.sendInputEvent = sendInputEvent;
  }

  updateConfig(config: InputRouterConfig): void {
    this.config = config;
  }

  /**
   * Processes mouse state and forwards events to the appropriate OSR renderer.
   * Uses raycasting to determine which billboard the mouse is hovering over.
   */
  handleMouse(camera: CameraState, mouse: MouseState, elements: WorldSpaceUIElement[]): void {
    // Simple raycast: project mouse to world ray and test against billboard planes
    const hit = this.raycastBillboards(camera, mouse, elements);
    const rendererId = hit ? this.config.textureIndexToRendererId.get(hit.element.textureIndex) : null;

    // Skip if renderer is crashed or failed
    if (rendererId) {
      const status = this.config.rendererStatuses.get(rendererId);
      if (status === "crashed" || status === "failed") return;
    }

    // Mouse move
    if (mouse.x !== this.lastMouseX || mouse.y !== this.lastMouseY) {
      if (hit && rendererId) {
        const coords = this.computeRendererCoords(hit);
        this.sendInputEvent(rendererId, {
          type: "mouseMove",
          x: coords.x,
          y: coords.y,
          button: "left",
        });
      }
      this.lastMouseX = mouse.x;
      this.lastMouseY = mouse.y;
    }

    // Mouse button changes
    const buttonChanged = mouse.buttons !== this.lastButtons;
    if (buttonChanged) {
      const prevButtons = this.lastButtons;
      const currButtons = mouse.buttons;

      if (hit && rendererId) {
        const coords = this.computeRendererCoords(hit);

        // Left button
        if ((currButtons & 1) && !(prevButtons & 1)) {
          this.sendInputEvent(rendererId, { type: "mouseDown", x: coords.x, y: coords.y, button: "left" });
          this.hoveredElementId = hit.element.id;
          this.hoveredRendererId = rendererId;
        } else if (!(currButtons & 1) && (prevButtons & 1)) {
          this.sendInputEvent(rendererId, { type: "mouseUp", x: coords.x, y: coords.y, button: "left" });
        }

        // Right button
        if ((currButtons & 2) && !(prevButtons & 2)) {
          this.sendInputEvent(rendererId, { type: "mouseDown", x: coords.x, y: coords.y, button: "right" });
        } else if (!(currButtons & 2) && (prevButtons & 2)) {
          this.sendInputEvent(rendererId, { type: "mouseUp", x: coords.x, y: coords.y, button: "right" });
        }

        // Middle button
        if ((currButtons & 4) && !(prevButtons & 4)) {
          this.sendInputEvent(rendererId, { type: "mouseDown", x: coords.x, y: coords.y, button: "middle" });
        } else if (!(currButtons & 4) && (prevButtons & 4)) {
          this.sendInputEvent(rendererId, { type: "mouseUp", x: coords.x, y: coords.y, button: "middle" });
        }
      } else if (this.hoveredRendererId) {
        // Mouse released outside any billboard — send mouseUp to last hovered
        this.sendInputEvent(this.hoveredRendererId, { type: "mouseUp", x: 0, y: 0, button: "left" });
        this.hoveredElementId = null;
        this.hoveredRendererId = null;
      }

      this.lastButtons = currButtons;
    }

    // Mouse wheel
    if (mouse.wheelDeltaY !== 0 || mouse.wheelDeltaX !== 0) {
      if (hit && rendererId) {
        const coords = this.computeRendererCoords(hit);
        this.sendInputEvent(rendererId, {
          type: "mouseWheel",
          x: coords.x,
          y: coords.y,
          deltaX: mouse.wheelDeltaX,
          deltaY: mouse.wheelDeltaY,
        });
      }
    }
  }

  /** Forwards a keyboard event to the currently focused/hovered renderer. */
  handleKey(type: "keyDown" | "keyUp", keyCode: string): void {
    if (!this.hoveredRendererId) return;
    const status = this.config.rendererStatuses.get(this.hoveredRendererId);
    if (status === "crashed" || status === "failed") return;

    this.sendInputEvent(this.hoveredRendererId, { type, x: 0, y: 0, keyCode });
  }

  private computeRendererCoords(hit: RaycastHit): { x: number; y: number } {
    const rendererId = this.config.textureIndexToRendererId.get(hit.element.textureIndex);
    if (!rendererId) return { x: 0, y: 0 };

    // For atlas mode: map UV to atlas pixel coordinates
    const layout = this.config.atlasLayouts.get(rendererId);
    if (layout) {
      // UV within the panel = (hit.uv - uvOffset) / uvScale → panel-relative UV
      const panelU = (hit.uv[0] - hit.element.uvOffset[0]) / hit.element.uvScale[0];
      const panelV = (hit.uv[1] - hit.element.uvOffset[1]) / hit.element.uvScale[1];

      // Find which panel this UV falls within
      for (const [panelId, rect] of layout.panels) {
        const panelX = rect.x / layout.width;
        const panelY = rect.y / layout.height;
        const panelW = rect.w / layout.width;
        const panelH = rect.h / layout.height;

        if (panelU >= panelX && panelU <= panelX + panelW &&
            panelV >= panelY && panelV <= panelY + panelH) {
          // Map to OSR window pixel coordinates
          const x = (panelU - panelX) / panelW * rect.w;
          const y = (panelV - panelY) / panelH * rect.h;
          return { x, y };
        }
      }
    }

    // For dedicated mode: map UV directly to texture pixel coordinates
    const u = hit.uv[0];
    const v = hit.uv[1];
    return { x: u * hit.element.size[0], y: v * hit.element.size[1] };
  }

  private raycastBillboards(
    _camera: CameraState,
    _mouse: MouseState,
    elements: WorldSpaceUIElement[],
  ): RaycastHit | null {
    // Simplified raycast: for now, use a distance-based approach.
    // A full implementation would compute the camera ray and intersect with
    // the billboard quad in world space.
    //
    // For v1, we return null (no hit) — input routing will be wired but
    // actual raycasting needs camera matrices + mouse NDC conversion.
    // This is a placeholder that will be replaced with proper ray-plane intersection.
    void elements;
    return null;
  }
}

interface RaycastHit {
  element: WorldSpaceUIElement;
  uv: [number, number];
}
