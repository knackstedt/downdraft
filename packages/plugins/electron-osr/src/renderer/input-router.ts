// ============================================================================
// OSR Input Router — Raycasts against billboards and forwards input to OSR windows
// ============================================================================

import type { AtlasLayout, OSRInputEvent, OSRRendererStatus, WorldSpaceUIElement } from "../types.ts";
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
  /** Map of rendererId → texture pixel dimensions */
  rendererDimensions: Map<string, { width: number; height: number }>;
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
    const dims = this.config.rendererDimensions.get(rendererId);
    const w = dims?.width ?? 512;
    const h = dims?.height ?? 384;
    return { x: hit.uv[0] * w, y: hit.uv[1] * h };
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
    const inv = invertMat4(vp);
    if (!inv) return null;

    // Ray origin = camera position
    // Ray direction = unproject NDC point at far plane, normalize
    const nearPoint = transformVec4Mat4(inv, [ndcX, ndcY, -1, 1]);
    const farPoint = transformVec4Mat4(inv, [ndcX, ndcY, 1, 1]);
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

// --- Matrix helpers for raycasting ---

function invertMat4(m: Float32Array): Float32Array | null {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (det === 0) return null;
  det = 1.0 / det;

  const out = new Float32Array(16);
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

function transformVec4Mat4(m: Float32Array, v: [number, number, number, number]): [number, number, number, number] {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
    m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
  ];
}
