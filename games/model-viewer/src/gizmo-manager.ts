// ============================================================================
// GizmoManager — 3D translate gizmo for bone manipulation in the model viewer
// ============================================================================
// Renders a 3-axis translate gizmo at a bone's world position and handles
// mouse picking + dragging to move the bone along a selected axis.
//
// The gizmo is rendered as part of the skeleton renderer's line buffer, but
// picking and dragging are handled here using screen-space projection.
//
// Interaction model:
// 1. On pointerdown: project the 3 axis endpoints to screen space, find the
//    closest axis within a pixel threshold. If hit, start dragging.
// 2. On pointermove (while dragging): project the mouse onto the screen-space
//    axis direction, compute the delta in world units, convert to local bone
//    space, and call the onOffset callback.
// 3. On pointerup: stop dragging.
//

import { calculateViewProj, type CameraState } from "@downdraft/core";

export type GizmoAxis = "x" | "y" | "z";

export interface GizmoState {
  /** World-space position of the gizmo (the selected bone's world position). */
  position: [number, number, number];
  /** Which axis is currently being dragged, or null. */
  activeAxis: GizmoAxis | null;
  /** Which axis is hovered (for highlight). */
  hoveredAxis: GizmoAxis | null;
  /** World-space position at drag start. */
  dragStartWorld: [number, number, number];
  /** Mouse screen position at drag start. */
  dragStartScreen: { x: number; y: number };
  /** Screen-space direction of the active axis at drag start (normalized). */
  dragAxisScreenDir: { x: number; y: number };
  /** World-space direction of the active axis (unit vector). */
  dragAxisWorldDir: [number, number, number];
  /** The offset value at drag start. */
  dragStartOffset: [number, number, number];
  /** Scale factor: world units per screen pixel at the gizmo distance. */
  worldPerPixel: number;
}

const AXIS_COLORS: Record<GizmoAxis, [number, number, number]> = {
  x: [1.0, 0.3, 0.3], // red
  y: [0.3, 1.0, 0.3], // green
  z: [0.3, 0.5, 1.0], // blue
};

const AXIS_HIGHLIGHT: [number, number, number] = [1.0, 1.0, 0.3]; // yellow

const AXIS_VECTORS: Record<GizmoAxis, [number, number, number]> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
};

/** Project a 3D world position to 2D screen coordinates. */
function projectToScreen(
  worldPos: [number, number, number],
  viewProj: Float32Array,
  canvasWidth: number,
  canvasHeight: number,
): { x: number; y: number; visible: boolean } {
  const wx = worldPos[0], wy = worldPos[1], wz = worldPos[2];
  const clipX = viewProj[0] * wx + viewProj[4] * wy + viewProj[8] * wz + viewProj[12];
  const clipY = viewProj[1] * wx + viewProj[5] * wy + viewProj[9] * wz + viewProj[13];
  const clipZ = viewProj[2] * wx + viewProj[6] * wy + viewProj[10] * wz + viewProj[14];
  const clipW = viewProj[3] * wx + viewProj[7] * wy + viewProj[11] * wz + viewProj[15];
  if (clipW <= 0) return { x: 0, y: 0, visible: false };
  const ndcX = clipX / clipW;
  const ndcY = clipY / clipW;
  const ndcZ = clipZ / clipW;
  return {
    x: (ndcX + 1) / 2 * canvasWidth,
    y: (1 - ndcY) / 2 * canvasHeight,
    visible: ndcZ >= -1 && ndcZ <= 1,
  };
}

/** Distance from point to a line segment in 2D. */
function distToSegment(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-6) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export class GizmoManager {
  state: GizmoState | null = null;
  /** Gizmo size in world units (length of each axis line). */
  gizmoSize = 0.15;
  /** Picking threshold in screen pixels. */
  pickThreshold = 12;
  /** Model matrix (column-major 4x4) to transform gizmo positions to render space. */
  modelMatrix: Float32Array | null = null;

  /** Set the model transform (same as the ModelRenderer's pos/rot/scale). */
  setModelMatrix(m: Float32Array | null) {
    this.modelMatrix = m;
  }

  /** Transform a point by the model matrix (column-major). */
  private transformPoint(p: [number, number, number]): [number, number, number] {
    if (!this.modelMatrix) return p;
    const m = this.modelMatrix;
    return [
      m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
      m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
      m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
    ];
  }

  /** Set the gizmo position (call when selected bone changes). */
  setPosition(pos: [number, number, number]) {
    if (this.state) {
      this.state.position = pos;
    } else {
      this.state = {
        position: pos,
        activeAxis: null,
        hoveredAxis: null,
        dragStartWorld: [0, 0, 0],
        dragStartScreen: { x: 0, y: 0 },
        dragAxisScreenDir: { x: 0, y: 0 },
        dragAxisWorldDir: [0, 0, 0],
        dragStartOffset: [0, 0, 0],
        worldPerPixel: 0.01,
      };
    }
  }

  clear() {
    this.state = null;
  }

  isDragging(): boolean {
    return this.state?.activeAxis !== null && this.state?.activeAxis !== undefined;
  }

  /**
   * Try to pick an axis at the given screen position.
   * Returns the picked axis or null.
   */
  pickAxis(
    mouseX: number,
    mouseY: number,
    camera: CameraState,
    canvasWidth: number,
    canvasHeight: number,
  ): GizmoAxis | null {
    if (!this.state) return null;
    const viewProj = calculateViewProj(camera);
    const pos = this.transformPoint(this.state.position);
    const size = this.gizmoSize;

    let bestAxis: GizmoAxis | null = null;
    let bestDist = this.pickThreshold;

    for (const axis of ["x", "y", "z"] as GizmoAxis[]) {
      const dir = AXIS_VECTORS[axis];
      const startPos: [number, number, number] = pos;
      const endPos: [number, number, number] = [pos[0] + dir[0] * size, pos[1] + dir[1] * size, pos[2] + dir[2] * size];
      const startScreen = projectToScreen(startPos, viewProj, canvasWidth, canvasHeight);
      const endScreen = projectToScreen(endPos, viewProj, canvasWidth, canvasHeight);
      const dist = distToSegment(mouseX, mouseY, startScreen.x, startScreen.y, endScreen.x, endScreen.y);
      if (dist < bestDist) {
        bestDist = dist;
        bestAxis = axis;
      }
    }

    return bestAxis;
  }

  /**
   * Start dragging an axis.
   * Returns true if the drag was started (axis was picked).
   */
  startDrag(
    mouseX: number,
    mouseY: number,
    camera: CameraState,
    canvasWidth: number,
    canvasHeight: number,
    currentOffset: [number, number, number],
  ): boolean {
    if (!this.state) return false;
    const axis = this.pickAxis(mouseX, mouseY, camera, canvasWidth, canvasHeight);
    if (!axis) return false;

    const viewProj = calculateViewProj(camera);
    const pos = this.transformPoint(this.state.position);
    const dir = AXIS_VECTORS[axis];
    const size = this.gizmoSize;

    const startScreen = projectToScreen(pos, viewProj, canvasWidth, canvasHeight);
    const endPos: [number, number, number] = [pos[0] + dir[0] * size, pos[1] + dir[1] * size, pos[2] + dir[2] * size];
    const endScreen = projectToScreen(endPos, viewProj, canvasWidth, canvasHeight);

    // Screen-space direction of the axis
    const sdx = endScreen.x - startScreen.x;
    const sdy = endScreen.y - startScreen.y;
    const sdLen = Math.hypot(sdx, sdy);
    const screenDir = sdLen > 0.1 ? { x: sdx / sdLen, y: sdy / sdLen } : { x: 0, y: 0 };

    // Compute world units per screen pixel at the gizmo distance.
    // Use the camera's distance and FOV to compute the world size visible at
    // the gizmo's depth, then divide by canvas height.
    const cam = camera as any;
    const distance = Math.hypot(
      cam.position[0] - pos[0],
      cam.position[1] - pos[1],
      cam.position[2] - pos[2],
    );
    // Note: the gizmo axes are in bone world space (pre-model-transform), but
    // the drag delta is applied in bone local space. The worldPerPixel scale
    // is approximately correct because the model transform is mostly translation
    // + Y rotation (no scale change), so world distances are preserved.
    const fovRad = (cam.fov ?? 45) * Math.PI / 180;
    const visibleHeight = 2 * distance * Math.tan(fovRad / 2);
    const worldPerPixel = visibleHeight / canvasHeight;

    this.state.activeAxis = axis;
    this.state.dragStartWorld = [...pos] as [number, number, number];
    this.state.dragStartScreen = { x: mouseX, y: mouseY };
    this.state.dragAxisScreenDir = screenDir;
    this.state.dragAxisWorldDir = [...dir] as [number, number, number];
    this.state.dragStartOffset = [...currentOffset] as [number, number, number];
    this.state.worldPerPixel = worldPerPixel;

    return true;
  }

  /**
   * Update the drag with a new mouse position.
   * Returns the new offset, or null if not dragging.
   */
  updateDrag(mouseX: number, mouseY: number): [number, number, number] | null {
    if (!this.state || !this.state.activeAxis) return null;

    // Project mouse delta onto the screen-space axis direction
    const dx = mouseX - this.state.dragStartScreen.x;
    const dy = mouseY - this.state.dragStartScreen.y;
    const projection = dx * this.state.dragAxisScreenDir.x + dy * this.state.dragAxisScreenDir.y;

    // Convert screen pixels to world units
    const worldDelta = projection * this.state.worldPerPixel;

    // Apply along the world axis direction
    const axis = this.state.activeAxis;
    const newOffset: [number, number, number] = [
      this.state.dragStartOffset[0],
      this.state.dragStartOffset[1],
      this.state.dragStartOffset[2],
    ];

    // The offset is in the bone's LOCAL space, but the gizmo shows world axes.
    // For the root bone (no parent), local = world (ignoring normalization).
    // For child bones, we'd need to convert, but for debugging purposes the
    // world-axis offset is the most intuitive. We store the offset in the
    // bone's local space by applying the inverse of the parent's world rotation.
    // For simplicity, we apply the offset directly in local space along the
    // same axis — this is correct for root bones and approximately correct for
    // children when the parent rotation is small.
    if (axis === "x") newOffset[0] = this.state.dragStartOffset[0] + worldDelta;
    else if (axis === "y") newOffset[1] = this.state.dragStartOffset[1] + worldDelta;
    else newOffset[2] = this.state.dragStartOffset[2] + worldDelta;

    return newOffset;
  }

  /** End the current drag. */
  endDrag() {
    if (this.state) {
      this.state.activeAxis = null;
    }
  }

  /** Set the hovered axis (for highlight). */
  setHovered(axis: GizmoAxis | null) {
    if (this.state) {
      this.state.hoveredAxis = axis;
    }
  }

  /**
   * Build vertex data for the gizmo (3 axis lines + arrowheads).
   * Returns { vertices: Float32Array, vertexCount: number } or null.
   * Each vertex: [x, y, z, r, g, b] (position + color).
   */
  buildVertices(): { vertices: Float32Array; vertexCount: number } | null {
    if (!this.state) return null;
    const pos = this.state.position;
    const size = this.gizmoSize;
    const verts: number[] = [];

    const axisList: GizmoAxis[] = ["x", "y", "z"];
    for (const axis of axisList) {
      const dir = AXIS_VECTORS[axis];
      const isActive = this.state.activeAxis === axis;
      const isHovered = this.state.hoveredAxis === axis;
      const color = isActive || isHovered ? AXIS_HIGHLIGHT : AXIS_COLORS[axis];

      // Main axis line
      verts.push(
        pos[0], pos[1], pos[2], color[0], color[1], color[2],
        pos[0] + dir[0] * size, pos[1] + dir[1] * size, pos[2] + dir[2] * size, color[0], color[1], color[2],
      );

      // Small arrowhead (perpendicular cross at the tip)
      const tip: [number, number, number] = [pos[0] + dir[0] * size, pos[1] + dir[1] * size, pos[2] + dir[2] * size];
      const arrowSize = size * 0.2;
      // Two perpendicular lines at the tip
      if (axis === "x") {
        verts.push(tip[0], tip[1] - arrowSize, tip[2], color[0], color[1], color[2], tip[0], tip[1] + arrowSize, tip[2], color[0], color[1], color[2]);
        verts.push(tip[0], tip[1], tip[2] - arrowSize, color[0], color[1], color[2], tip[0], tip[1], tip[2] + arrowSize, color[0], color[1], color[2]);
      } else if (axis === "y") {
        verts.push(tip[0] - arrowSize, tip[1], tip[2], color[0], color[1], color[2], tip[0] + arrowSize, tip[1], tip[2], color[0], color[1], color[2]);
        verts.push(tip[0], tip[1], tip[2] - arrowSize, color[0], color[1], color[2], tip[0], tip[1], tip[2] + arrowSize, color[0], color[1], color[2]);
      } else {
        verts.push(tip[0] - arrowSize, tip[1], tip[2], color[0], color[1], color[2], tip[0] + arrowSize, tip[1], tip[2], color[0], color[1], color[2]);
        verts.push(tip[0], tip[1] - arrowSize, tip[2], color[0], color[1], color[2], tip[0], tip[1] + arrowSize, tip[2], color[0], color[1], color[2]);
      }
    }

    return {
      vertices: new Float32Array(verts),
      vertexCount: verts.length / 6,
    };
  }
}
