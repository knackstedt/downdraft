// ============================================================================
// OSR Input Router — Raycasts against billboards and forwards input to OSR windows
// ============================================================================

import { invertMat4Into, transformMat4Vec4 } from "@downdraft/engine";
import type { AtlasLayout, OSRInputEvent, OSRRendererStatus, WorldSpaceUIElement } from "./types";
import type { CameraState } from "./world-space-ui-pass";

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
  /** Map of rendererId → texture pixel dimensions */
  rendererDimensions: Map<string, { width: number; height: number }>;
}

export class OSRInputRouter {
  private config: InputRouterConfig;
  private sendInputEvent: (rendererId: string, event: Omit<OSRInputEvent, "rendererId">) => void;
  private hoveredElementId: string | null = null;
  private hoveredRendererId: string | null = null;
  private forcedFocusRendererId: string | null = null;
  private forcedFocusTextureIndex: number = -1;
  private forcedFocusCanvasWidth = 0;
  private forcedFocusCanvasHeight = 0;
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
    // Forced focus mode: raycast for position, always forward to focused renderer
    if (this.forcedFocusRendererId) {
      this.handleMouseForced(camera, mouse, elements);
      return;
    }

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
        this.hoveredRendererId = rendererId;
      } else {
        this.hoveredRendererId = null;
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

  /**
   * Forced focus mode: raycasts for accurate mouse position on the billboard,
   * but always forwards events to the forced-focus renderer (regardless of which
   * billboard the raycast hits).
   */
  private handleMouseForced(camera: CameraState, mouse: MouseState, elements: WorldSpaceUIElement[]): void {
    const rendererId = this.forcedFocusRendererId!;

    // Raycast to get accurate UV coordinates on the billboard
    const hit = this.raycastBillboards(camera, mouse, elements);
    const coords = hit ? this.computeRendererCoords(hit) : null;

    // Mouse move
    if (mouse.x !== this.lastMouseX || mouse.y !== this.lastMouseY) {
      if (coords) {
        this.sendInputEvent(rendererId, { type: "mouseMove", x: coords.x, y: coords.y, button: "left" });
      }
      this.lastMouseX = mouse.x;
      this.lastMouseY = mouse.y;
    }

    // Mouse button changes
    const buttonChanged = mouse.buttons !== this.lastButtons;
    if (buttonChanged) {
      const prevButtons = this.lastButtons;
      const currButtons = mouse.buttons;
      if (coords) {
        // Left button
        if ((currButtons & 1) && !(prevButtons & 1)) {
          this.sendInputEvent(rendererId, { type: "mouseDown", x: coords.x, y: coords.y, button: "left" });
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
      }

      this.lastButtons = currButtons;
    }

    // Mouse wheel
    if (mouse.wheelDeltaY !== 0 || mouse.wheelDeltaX !== 0) {
      if (coords) {
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

  /**
   * Manually focus the first available billboard renderer (bypasses raycasting).
   * Sets forced focus mode so all mouse/keyboard events are forwarded to this renderer.
   */
  focusBillboard(): string | null {
    for (const [texIdx, rendererId] of this.config.textureIndexToRendererId) {
      const status = this.config.rendererStatuses.get(rendererId);
      if (status === "crashed" || status === "failed") continue;
      this.hoveredRendererId = rendererId;
      this.hoveredElementId = `manual-focus-${texIdx}`;
      this.forcedFocusRendererId = rendererId;
      this.forcedFocusTextureIndex = texIdx;
      return rendererId;
    }
    return null;
  }

  /** Set canvas dimensions for proportional mouse mapping in forced focus mode. */
  setForcedFocusCanvasSize(w: number, h: number): void {
    this.forcedFocusCanvasWidth = w;
    this.forcedFocusCanvasHeight = h;
  }

  /** Check if forced focus mode is active. */
  isForcedFocus(): boolean {
    return this.forcedFocusRendererId !== null;
  }

  /** Check if the mouse is currently hovering over a billboard. */
  isHoveringBillboard(): boolean {
    return this.hoveredRendererId !== null;
  }

  /** Exit forced focus mode, return to raycast-based input. */
  unfocusBillboard(): void {
    this.forcedFocusRendererId = null;
    this.forcedFocusTextureIndex = -1;
    this.hoveredElementId = null;
    this.hoveredRendererId = null;
  }

  /** Forwards a keyboard event to the currently focused/hovered renderer. */
  handleKey(type: "keyDown" | "keyUp", keyCode: string, modifiers?: string[]): void {
    if (!this.hoveredRendererId) return;
    const status = this.config.rendererStatuses.get(this.hoveredRendererId);
    if (status === "crashed" || status === "failed") return;

    this.sendInputEvent(this.hoveredRendererId, { type, x: 0, y: 0, keyCode, modifiers });
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
      for (const [, rect] of layout.panels) {
        const panelX = rect.x / layout.width;
        const panelY = rect.y / layout.height;
        const panelW = rect.w / layout.width;
        const panelH = rect.h / layout.height;

        if (panelU >= panelX && panelU <= panelX + panelW &&
            panelV >= panelY && panelV <= panelY + panelH) {
          // Map to atlas-space pixels — the surface is one document with
          // panels positioned at their rects, so events carry atlas coords.
          const x = (panelU - panelX) / panelW * rect.w + rect.x;
          const y = (panelV - panelY) / panelH * rect.h + rect.y;
          return { x, y };
        }
      }
    }

    // For dedicated mode: map UV directly to texture pixel coordinates
    // Flip Y: UV origin is bottom-left, DOM origin is top-left
    const dims = this.config.rendererDimensions.get(rendererId);
    const w = dims?.width ?? 512;
    const h = dims?.height ?? 384;
    return { x: hit.uv[0] * w, y: (1 - hit.uv[1]) * h };
  }

  private raycastBillboards(
    camera: CameraState,
    mouse: MouseState,
    elements: WorldSpaceUIElement[],
  ): RaycastHit | null {
    if (elements.length === 0) return null;

    // Convert mouse screen coords to NDC (-1 to 1)
    // mouse.x/y are in canvas pixels (top-left origin)
    const ndcX = (mouse.x / camera.canvasWidth) * 2.0 - 1.0;
    const ndcY = -((mouse.y / camera.canvasHeight) * 2.0 - 1.0); // flip Y (NDC bottom-up)

    // Build inverse of viewProj to unproject NDC → world
    const vp = camera.viewProj;
    const inv = new Float32Array(16);
    if (!invertMat4Into(vp, inv)) return null;

    // Ray origin = camera position
    // Ray direction = unproject NDC point at far plane, normalize
    const nearPoint = transformMat4Vec4(inv, [ndcX, ndcY, -1, 1]);
    const farPoint = transformMat4Vec4(inv, [ndcX, ndcY, 1, 1]);
    if (nearPoint[3] === 0 || farPoint[3] === 0) return null;

    // Perspective divide
    const nx = nearPoint[0] / nearPoint[3];
    const ny = nearPoint[1] / nearPoint[3];
    const nz = nearPoint[2] / nearPoint[3];
    const fx = farPoint[0] / farPoint[3];
    const fy = farPoint[1] / farPoint[3];
    const fz = farPoint[2] / farPoint[3];

    // Ray direction
    let dx = fx - nx;
    let dy = fy - ny;
    let dz = fz - nz;
    const dlen = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dlen === 0) return null;
    dx /= dlen;
    dy /= dlen;
    dz /= dlen;

    const right = camera.cameraRight;
    const up = camera.cameraUp;

    let closestHit: RaycastHit | null = null;
    let closestDist = Infinity;

    for (const el of elements) {
      const cx = el.position[0];
      const cy = el.position[1];
      const cz = el.position[2];

      // Billboard normal = cross(right, up) = camera forward
      const normalX = right[1] * up[2] - right[2] * up[1];
      const normalY = right[2] * up[0] - right[0] * up[2];
      const normalZ = right[0] * up[1] - right[1] * up[0];
      const nlen = Math.sqrt(normalX * normalX + normalY * normalY + normalZ * normalZ);
      if (nlen === 0) continue;

      // Ray-plane intersection: t = dot(center - origin, normal) / dot(dir, normal)
      const ocx = cx - camera.cameraPosition[0];
      const ocy = cy - camera.cameraPosition[1];
      const ocz = cz - camera.cameraPosition[2];
      const denom = dx * (normalX / nlen) + dy * (normalY / nlen) + dz * (normalZ / nlen);
      if (Math.abs(denom) < 1e-6) continue;
      const t = (ocx * (normalX / nlen) + ocy * (normalY / nlen) + ocz * (normalZ / nlen)) / denom;
      if (t < 0) continue; // behind camera

      // Intersection point
      const px = camera.cameraPosition[0] + dx * t;
      const py = camera.cameraPosition[1] + dy * t;
      const pz = camera.cameraPosition[2] + dz * t;

      // Convert to local UV on the billboard
      const localX = (px - cx) * right[0] + (py - cy) * right[1] + (pz - cz) * right[2];
      const localY = (px - cx) * up[0] + (py - cy) * up[1] + (pz - cz) * up[2];

      const halfW = el.size[0] * 0.5;
      const halfH = el.size[1] * 0.5;

      if (Math.abs(localX) > halfW || Math.abs(localY) > halfH) continue;

      const u = localX / el.size[0] + 0.5;
      const v = localY / el.size[1] + 0.5;

      if (t < closestDist) {
        closestDist = t;
        closestHit = { element: el, uv: [u, v] };
      }
    }

    return closestHit;
  }
}

interface RaycastHit {
  element: WorldSpaceUIElement;
  uv: [number, number];
}
