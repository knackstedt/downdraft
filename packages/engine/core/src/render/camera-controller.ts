// ============================================================================
// CameraController — batteries-included camera controller for renderer plugins
//
// Built on the existing core `Camera` math (spherical orbit/pan/zoom). Adds:
//  - Multi-camera support (named cameras + active selection)
//  - Lerp/smoothing between current and commanded position/target/rotation
//  - Orbit/pan/zoom input binding via `RendererInputBus` (no own DOM listeners)
//  - Real bounding-sphere `frameBounds` (replaces the model-viewer's magic
//    `distance = 3.5`)
//
// Implements `CameraControllerLike` so it can be registered as the active
// camera provider on a `RendererModuleContext`.
// ============================================================================

import type {
    CameraControllerLike,
    RendererInputBus,
} from "../module/renderer-module";
import { Camera } from "../scene/camera";
import type { CameraState } from "./camera";

export interface CameraControllerOptions {
  /** Smoothing factor in [0,1]. 0 = instant (no smoothing), 1 = never moves. */
  lerpFactor?: number;
  /** Default camera id to mark active on creation. */
  defaultCameraId?: string;
}

export interface OrbitInputOptions {
  /** Radians per pixel of drag for rotation. */
  rotateSpeed?: number;
  /** Multiplier applied to `distance` for pan sensitivity. */
  panSpeed?: number;
  /** Multiplier applied to `wheel.deltaY` for zoom. */
  zoomSpeed?: number;
  /** Min/max distance clamp. */
  minDistance?: number;
  maxDistance?: number;
  /**
   * Button mask that triggers panning instead of rotating. Defaults to
   * right-button (2) and shift+any-button. Matches the model-viewer's
   * `e.button === 2 || e.shiftKey` convention.
   */
  panButtonMask?: number;
  /** When true, shift+drag pans regardless of button. Default true. */
  shiftPans?: boolean;
}

const DEFAULT_ORBIT: Required<OrbitInputOptions> = {
  rotateSpeed: 0.005,
  panSpeed: 0.002,
  zoomSpeed: 0.1,
  minDistance: 0.1,
  maxDistance: 500,
  panButtonMask: 2,
  shiftPans: true,
};

// ── Quaternion helpers (for optional rotation slerp) ──

type Quat = [number, number, number, number];

function quatIdentity(): Quat {
  return [0, 0, 0, 1];
}

function quatSlerp(a: Quat, b: Quat, t: number): Quat {
  let cosOmega = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
  if (cosOmega < 0) {
    b0 = -b0; b1 = -b1; b2 = -b2; b3 = -b3;
    cosOmega = -cosOmega;
  }
  if (cosOmega > 0.9999) {
    return [
      a[0] + (b0 - a[0]) * t,
      a[1] + (b1 - a[1]) * t,
      a[2] + (b2 - a[2]) * t,
      a[3] + (b3 - a[3]) * t,
    ];
  }
  const omega = Math.acos(cosOmega);
  const sinOmega = Math.sin(omega);
  const s0 = Math.sin((1 - t) * omega) / sinOmega;
  const s1 = Math.sin(t * omega) / sinOmega;
  return [
    a[0] * s0 + b0 * s1,
    a[1] * s0 + b1 * s1,
    a[2] * s0 + b2 * s1,
    a[3] * s0 + b3 * s1,
  ];
}

export class CameraController implements CameraControllerLike {
  private cameras: Map<string, Camera> = new Map();
  private activeId: string | null = null;

  /** Lerp factor in [0,1]. 0 = instant, 1 = never moves. */
  lerpFactor: number;

  // Per-active-camera rendered (smoothed) state. Keyed by camera id.
  private renderedPos: Map<string, [number, number, number]> = new Map();
  private renderedTarget: Map<string, [number, number, number]> = new Map();
  private renderedRot: Map<string, Quat> = new Map();
  /** Optional explicit rotation goal (quaternion). When set, overrides lookAt orientation. */
  private rotationGoal: Map<string, Quat | null> = new Map();
  private initialized: Map<string, boolean> = new Map();

  // Cached CameraState per camera (reused across frames to avoid allocation).
  private cachedState: Map<string, CameraState> = new Map();

  // Unsubscribe fns for input bindings (so unbindOrbit can tear them down).
  private orbitUnsubs: Array<() => void> = [];

  constructor(opts: CameraControllerOptions = {}) {
    this.lerpFactor = opts.lerpFactor ?? 0;
    if (opts.defaultCameraId) {
      this.addCamera(opts.defaultCameraId, new Camera());
      this.activeId = opts.defaultCameraId;
    }
  }

  // ── Multi-camera management ──

  addCamera(id: string, camera: Camera): void {
    this.cameras.set(id, camera);
    if (this.activeId === null) this.activeId = id;
  }

  removeCamera(id: string): void {
    this.cameras.delete(id);
    this.renderedPos.delete(id);
    this.renderedTarget.delete(id);
    this.renderedRot.delete(id);
    this.rotationGoal.delete(id);
    this.initialized.delete(id);
    this.cachedState.delete(id);
    if (this.activeId === id) {
      this.activeId = this.cameras.size > 0 ? this.cameras.keys().next().value ?? null : null;
    }
  }

  setActive(id: string): void {
    if (!this.cameras.has(id)) throw new Error(`Camera "${id}" not registered`);
    this.activeId = id;
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  getCamera(id: string): Camera | undefined {
    return this.cameras.get(id);
  }

  getActiveCamera(): Camera | null {
    return this.activeId ? this.cameras.get(this.activeId) ?? null : null;
  }

  listCameras(): string[] {
    return Array.from(this.cameras.keys());
  }

  // ── Rotation goal (optional quaternion orientation) ──

  /**
   * Set an explicit rotation goal (quaternion [x,y,z,w]) for a camera. When
   * set, the controller slerps toward this orientation instead of deriving
   * orientation from lookAt(position, target, up). Pass null to revert to
   * lookAt-derived orientation.
   */
  setRotationGoal(id: string, q: Quat | null): void {
    this.rotationGoal.set(id, q);
  }

  // ── CameraControllerLike ──

  setAspect(w: number, h: number): void {
    for (const cam of this.cameras.values()) {
      cam.setAspect(w, h);
    }
  }

  frameBounds(min: [number, number, number], max: [number, number, number]): void {
    const cam = this.getActiveCamera();
    if (!cam) return;
    const cx = (min[0] + max[0]) / 2;
    const cy = (min[1] + max[1]) / 2;
    const cz = (min[2] + max[2]) / 2;
    cam.setTarget(cx, cy, cz);

    // Bounding-sphere framing: distance = (halfDiag / sin(fov/2)) * padding.
    // Account for aspect by using the smaller effective FOV.
    const dx = max[0] - min[0];
    const dy = max[1] - min[1];
    const dz = max[2] - min[2];
    const halfDiag = Math.sqrt(dx * dx + dy * dy + dz * dz) / 2 || 0.1;
    const fovRad = (cam.fov * Math.PI) / 180;
    const horizFov = 2 * Math.atan(Math.tan(fovRad / 2) * cam.aspect);
    const effectiveFov = Math.min(fovRad, horizFov);
    const padding = 1.5;
    const distance = (halfDiag / Math.sin(effectiveFov / 2)) * padding;

    // Scale the depth range to the framed subject: a fixed near/far either
    // clips large models (framing distance beyond far) or wastes precision
    // on small ones. Keep 500m far as the floor so ordinary scenes are
    // unchanged.
    cam.near = Math.max(0.01, distance / 1000);
    cam.far = Math.max(500, distance * 8);

    // Drive the orbit params directly so subsequent orbit/zoom/pan work.
    cam.distance = Math.max(0.1, distance);
    cam.yaw = Math.PI * 0.25;
    cam.pitch = Math.PI * 0.15;
    // Recompute position from the new spherical params.
    cam.setPosition(
      cx + cam.distance * Math.cos(cam.pitch) * Math.sin(cam.yaw),
      cy + cam.distance * Math.sin(cam.pitch),
      cz + cam.distance * Math.cos(cam.pitch) * Math.cos(cam.yaw),
    );

    // Reset smoothing so the framed view snaps instead of lerping from afar.
    const id = this.activeId!;
    this.initialized.set(id, false);
  }

  /**
   * Returns the smoothed `CameraState` for the active camera (or the given
   * viewport's camera if multi-viewport mapping is configured). Viewport
   * index is currently ignored (single active camera); subclasses can
   * override to map viewports to cameras.
   */
  getCameraState(viewportIdx: number): CameraState {
    void viewportIdx; // single-camera-per-controller for now
    const id = this.activeId;
    if (!id) {
      // Fallback: a default camera at origin looking down -Z.
      return {
        position: [0, 5, 10],
        target: [0, 0, 0],
        up: [0, 1, 0],
        fov: 60,
        near: 0.1,
        far: 1000,
        aspect: 1,
      };
    }
    const cam = this.cameras.get(id)!;
    this.tickSmoothing(id, cam);

    // Build (or reuse) a CameraState with cached view/proj matrices so
    // consumers that call calculateViewProjInto can take the fast path.
    let state = this.cachedState.get(id);
    if (!state) {
      state = {
        position: [0, 0, 0],
        target: [0, 0, 0],
        up: [0, 1, 0],
        fov: cam.fov,
        near: cam.near,
        far: cam.far,
        aspect: cam.aspect,
        projectionMatrix: cam.getProjectionMatrix(),
        viewMatrix: cam.getViewMatrix(),
      };
      this.cachedState.set(id, state);
    }
    const rp = this.renderedPos.get(id)!;
    const rt = this.renderedTarget.get(id)!;
    state.position[0] = rp[0]; state.position[1] = rp[1]; state.position[2] = rp[2];
    state.target[0] = rt[0]; state.target[1] = rt[1]; state.target[2] = rt[2];
    state.fov = cam.fov;
    state.near = cam.near;
    state.far = cam.far;
    state.aspect = cam.aspect;
    // If a rotation goal is set, the view matrix is derived from it rather
    // than lookAt; otherwise let the consumer derive view from position/target/up.
    const rotGoal = this.rotationGoal.get(id);
    if (rotGoal) {
      // We don't bake the quaternion into viewMatrix here — consumers that
      // respect `viewMatrix` will get the lookAt-derived one. A future
      // extension can build a view matrix from the quaternion; for now the
      // slerped quaternion is exposed via getRenderedRotation() for callers
      // that need it (e.g. XR rigs).
      state.viewMatrix = cam.getViewMatrix();
    } else {
      state.viewMatrix = cam.getViewMatrix();
    }
    state.projectionMatrix = cam.getProjectionMatrix();
    return state;
  }

  /** Current slerped rotation quaternion for a camera (or identity). */
  getRenderedRotation(id: string): Quat {
    return this.renderedRot.get(id) ?? quatIdentity();
  }

  // ── Orbit input binding ──

  /**
   * Wires orbit/pan/zoom input from the bus to the active camera. Returns an
   * unsubscribe function. While bound, left-drag rotates, shift/right-drag
   * pans, and wheel zooms — matching the model-viewer's OrbitCamera.
   */
  bindOrbit(bus: RendererInputBus, opts: OrbitInputOptions = {}): () => void {
    const o = { ...DEFAULT_ORBIT, ...opts };
    const unsubs = this.orbitUnsubs;

    const onDrag = (d: { dx: number; dy: number; buttons: number; shift: boolean }) => {
      const cam = this.getActiveCamera();
      if (!cam) return;
      const isPan = (o.shiftPans && d.shift) || (d.buttons & o.panButtonMask) !== 0;
      if (isPan) {
        const panX = -d.dx * o.panSpeed * cam.distance;
        const panY = d.dy * o.panSpeed * cam.distance;
        cam.pan(panX, panY);
      } else {
        cam.orbit(-d.dx * o.rotateSpeed, d.dy * o.rotateSpeed);
      }
    };
    const onWheel = (e: WheelEvent) => {
      const cam = this.getActiveCamera();
      if (!cam) return;
      e.preventDefault();
      const factor = 1 + e.deltaY * o.zoomSpeed * 0.01;
      cam.distance *= factor;
      cam.distance = Math.max(o.minDistance, Math.min(o.maxDistance, cam.distance));
      // Recompute position from the new distance.
      cam.setPosition(
        cam.target[0] + cam.distance * Math.cos(cam.pitch) * Math.sin(cam.yaw),
        cam.target[1] + cam.distance * Math.sin(cam.pitch),
        cam.target[2] + cam.distance * Math.cos(cam.pitch) * Math.cos(cam.yaw),
      );
    };

    unsubs.push(bus.onDrag(onDrag, 100));
    unsubs.push(bus.onWheel(onWheel, 100));
    return () => {
      while (unsubs.length) unsubs.pop()!();
    };
  }

  /** Tear down any orbit input bindings. */
  unbindOrbit(): void {
    while (this.orbitUnsubs.length) this.orbitUnsubs.pop()!();
  }

  // ── Smoothing ──

  /**
   * Advance the rendered (smoothed) position/target/rotation toward the
   * camera's commanded goal by one frame's worth of lerp. Called from
   * getCameraState so consumers always read post-smoothing state.
   *
   * Uses the same `1 - Math.pow(1-lerpFactor, dt*60)` shape as
   * `CameraSystem`'s third-person smoothing (render/camera.ts:233). We
   * assume a 60Hz reference frame when dt is unknown (getCameraState has no
   * dt param); callers that want frame-rate-independent smoothing should
   * call `tick(dt)` explicitly each frame.
   */
  private tickSmoothing(id: string, cam: Camera): void {
    const goalPos = cam.position;
    const goalTarget = cam.target;
    const goalRot = this.rotationGoal.get(id) ?? null;

    if (!this.initialized.get(id)) {
      this.renderedPos.set(id, [goalPos[0], goalPos[1], goalPos[2]]);
      this.renderedTarget.set(id, [goalTarget[0], goalTarget[1], goalTarget[2]]);
      this.renderedRot.set(id, goalRot ? [...goalRot] as Quat : quatIdentity());
      this.initialized.set(id, true);
      return;
    }

    const t = 1 - this.lerpFactor; // lerpFactor 0 → t=1 (snap), 1 → t=0 (frozen)
    const rp = this.renderedPos.get(id)!;
    const rt = this.renderedTarget.get(id)!;
    rp[0] += (goalPos[0] - rp[0]) * t;
    rp[1] += (goalPos[1] - rp[1]) * t;
    rp[2] += (goalPos[2] - rp[2]) * t;
    rt[0] += (goalTarget[0] - rt[0]) * t;
    rt[1] += (goalTarget[1] - rt[1]) * t;
    rt[2] += (goalTarget[2] - rt[2]) * t;

    if (goalRot) {
      const rr = this.renderedRot.get(id) ?? quatIdentity();
      this.renderedRot.set(id, quatSlerp(rr, goalRot, t));
    }
  }

  /**
   * Frame-rate-independent smoothing tick. Call once per frame with the
   * frame dt (seconds) before reading getCameraState. If not called, the
   * controller falls back to the 60Hz assumption inside getCameraState.
   */
  tick(dt: number): void {
    if (this.lerpFactor <= 0) {
      // Snapping — just ensure initialized.
      for (const [id, cam] of this.cameras) this.tickSmoothing(id, cam);
      return;
    }
    const t = 1 - Math.pow(this.lerpFactor, dt * 60);
    for (const [id, cam] of this.cameras) {
      const goalPos = cam.position;
      const goalTarget = cam.target;
      const goalRot = this.rotationGoal.get(id) ?? null;
      if (!this.initialized.get(id)) {
        this.renderedPos.set(id, [goalPos[0], goalPos[1], goalPos[2]]);
        this.renderedTarget.set(id, [goalTarget[0], goalTarget[1], goalTarget[2]]);
        this.renderedRot.set(id, goalRot ? [...goalRot] as Quat : quatIdentity());
        this.initialized.set(id, true);
        continue;
      }
      const rp = this.renderedPos.get(id)!;
      const rt = this.renderedTarget.get(id)!;
      rp[0] += (goalPos[0] - rp[0]) * t;
      rp[1] += (goalPos[1] - rp[1]) * t;
      rp[2] += (goalPos[2] - rp[2]) * t;
      rt[0] += (goalTarget[0] - rt[0]) * t;
      rt[1] += (goalTarget[1] - rt[1]) * t;
      rt[2] += (goalTarget[2] - rt[2]) * t;
      if (goalRot) {
        const rr = this.renderedRot.get(id) ?? quatIdentity();
        this.renderedRot.set(id, quatSlerp(rr, goalRot, t));
      }
    }
  }

  // ── Lifecycle ──

  dispose(): void {
    this.unbindOrbit();
    this.cameras.clear();
    this.renderedPos.clear();
    this.renderedTarget.clear();
    this.renderedRot.clear();
    this.rotationGoal.clear();
    this.initialized.clear();
    this.cachedState.clear();
  }
}
