// ============================================================================
// @andrews-sandbox/module-weapons — physgun, toolgun, pistol, paintgun.
// Renderer-side weapon controllers that send commands to the sim worker.
// ============================================================================

import { ENT, SimBufferReader } from "@downdraft/core";
import { EntityType, FunMode, PhysgunMode, RotAxis, ToolType, ToolgunContext } from "@sandbox/shared/types";

/** Minimal sim API for weapon commands. */
export interface WeaponSimApi {
  sendCommand(cmd: any): void;
}

/** Minimal renderer API for weapons. */
export interface WeaponRendererApi {
  getCameraPosition(): [number, number, number];
  getCameraTarget(): [number, number, number];
  /** Mark an entity as the physgun's ghost-grabbed prop so the renderer wraps
   *  it in the ghost-mode hologram shader. Pass null to clear. Optional —
   *  renderers that don't implement it simply skip the visual. */
  setGhostGrabEntity?(entityId: number | null): void;
  /** Mark an entity as the physgun's hover target so the renderer applies the
   *  hover outline shader. Pass null to clear. Optional. */
  setHoverEntity?(entityId: number | null): void;
}

export interface WeaponContext {
  sim: WeaponSimApi;
  renderer: WeaponRendererApi;
  simSAB: SharedArrayBuffer;
  /** Returns the shape for a content id, or undefined if unknown. */
  getShapeForContent?: (contentId: string) => "box" | "sphere" | undefined;
}

// ── Quaternion / vector helpers (xyzw quaternion layout) ──
// Used by the physgun's right-click-drag prop rotation. Rotations are applied
// as world-space premultiplies (delta * propQuat) so the prop spins around the
// camera's world axes — Garry's Mod trackball style.

type Quat = [number, number, number, number];
type Vec3 = [number, number, number];

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize3(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function quatNormalize(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

function quatFromAxisAngle(ax: number, ay: number, az: number, angle: number): Quat {
  const half = angle * 0.5;
  const s = Math.sin(half);
  return [ax * s, ay * s, az * s, Math.cos(half)];
}

/** Hamilton product r = a * b (applies b first, then a). */
function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

const ROT_AXIS_NAMES = ["Free", "Yaw", "Pitch", "Roll"] as const;

// ── Physgun ──

export class Physgun {
  private ctx: WeaponContext;
  private grabbedEntity: number | null = null;
  private grabDistance = 5;
  private mode: PhysgunMode = PhysgunMode.Solid;
  // Right-click-drag rotation state (GMod-style prop rotation).
  private rotating = false;
  private rotAxis: RotAxis = RotAxis.Free;
  // Authoritative orientation of the held prop while rotating. Seeded from the
  // SAB on rotation start, then updated locally so fast mouse movement can't
  // lose deltas to sim/render frame lag.
  private propQuat: Quat = [0, 0, 0, 1];
  // Entity currently under the crosshair (for the hover outline). Updated each
  // tick via raycast when the physgun is active and not grabbing/rotating.
  private hoverEntity: number | null = null;

  constructor(ctx: WeaponContext) {
    this.ctx = ctx;
  }

  /** Start grabbing — raycast from camera center, find closest prop. */
  onPrimaryDown(): void {
    if (this.grabbedEntity !== null) return;
    const entityId = this.raycastForProp();
    if (entityId === null) return;
    this.grabbedEntity = entityId;
    this.ctx.sim.sendCommand({ type: "grabProp", entityId, origin: this.ctx.renderer.getCameraPosition(), mode: this.mode });
    // In Ghost mode the renderer wraps the grabbed prop in a hologram shader
    // so the player can tell the grab ignores collisions. Solid mode renders
    // the prop normally (collisions are respected).
    if (this.mode === PhysgunMode.Ghost) {
      this.ctx.renderer.setGhostGrabEntity?.(entityId);
    }
  }

  /** Release grabbed prop. */
  onPrimaryUp(): void {
    if (this.grabbedEntity === null) return;
    this.ctx.sim.sendCommand({ type: "releaseProp", entityId: this.grabbedEntity, velocity: [0, 0, 0] });
    this.grabbedEntity = null;
    this.rotating = false;
    this.ctx.renderer.setGhostGrabEntity?.(null);
  }

  /** Update grabbed prop position (called every frame while grabbing).
   *  Also runs a hover raycast when not grabbing so the renderer can outline
   *  the prop under the crosshair. */
  tick(): void {
    if (this.grabbedEntity !== null) {
      const cam = this.ctx.renderer.getCameraPosition();
      const target = this.ctx.renderer.getCameraTarget();
      const dx = target[0] - cam[0];
      const dy = target[1] - cam[1];
      const dz = target[2] - cam[2];
      const dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const targetPos: [number, number, number] = [
        cam[0] + (dx / dl) * this.grabDistance,
        cam[1] + (dy / dl) * this.grabDistance,
        cam[2] + (dz / dl) * this.grabDistance,
      ];
      this.ctx.sim.sendCommand({ type: "updateGrab", entityId: this.grabbedEntity, targetPos });
      this.hoverEntity = null;
      return;
    }
    // Not grabbing — raycast to find the prop under the crosshair for the
    // hover outline. Cleared when rotating (right-click-drag) so the outline
    // doesn't fight the rotation visual.
    this.hoverEntity = this.rotating ? null : this.raycastForProp();
  }

  /** Adjust grab distance (scroll wheel). */
  adjustDistance(delta: number): void {
    this.grabDistance = Math.max(1, Math.min(20, this.grabDistance + delta));
  }

  isGrabbing(): boolean {
    return this.grabbedEntity !== null;
  }

  /** Current grab mode (Ghost = no collision blockers, Solid = collision-aware). */
  getMode(): PhysgunMode {
    return this.mode;
  }

  /** Entity currently under the crosshair (null if none / grabbing / rotating).
   *  The renderer uses this to apply a hover outline shader to the looked-at prop. */
  getHoverTarget(): number | null {
    return this.hoverEntity;
  }

  /** Cycle the grab mode. Takes effect on the next grab; the active grab
   *  keeps its original mode until released. */
  toggleMode(): void {
    this.mode = this.mode === PhysgunMode.Ghost ? PhysgunMode.Solid : PhysgunMode.Ghost;
    console.log(`[Physgun] Mode: ${this.mode === PhysgunMode.Ghost ? "Ghost (no collision)" : "Solid (collision-aware)"}`);
  }

  /** Begin right-click-drag rotation of the held prop. No-op if not grabbing. */
  onSecondaryDown(): void {
    if (this.grabbedEntity === null) {
      this.rotating = false;
      return;
    }
    this.propQuat = this.readPropQuat(this.grabbedEntity);
    this.rotating = true;
  }

  /** End right-click-drag rotation. */
  onSecondaryUp(): void {
    this.rotating = false;
  }

  /** True while right-click is held and a prop is grabbed (mouse look is
   *  suppressed in this state so the mouse drives prop rotation instead). */
  isRotating(): boolean {
    return this.rotating && this.grabbedEntity !== null;
  }

  /** Current rotation axis (cycled by the scroll wheel while rotating). */
  getRotationAxis(): RotAxis {
    return this.rotAxis;
  }

  /** Cycle the rotation axis (Free → Yaw → Pitch → Roll → Free). Called when
   *  the scroll wheel is used while right-click rotating. */
  cycleRotationAxis(): void {
    this.rotAxis = ((this.rotAxis + 1) % 4) as RotAxis;
    console.log(`[Physgun] Rotation axis: ${ROT_AXIS_NAMES[this.rotAxis]}`);
  }

  /** Apply mouse delta to the held prop's rotation. Called from the mousemove
   *  handler while right-click is held. Mouse look is suppressed by the caller
   *  while this is active. */
  onRotateDrag(dx: number, dy: number): void {
    if (!this.rotating || this.grabbedEntity === null) return;
    const sens = 0.01;
    const { fwd, right, up } = this.cameraBasis();
    let q = this.propQuat;

    if (this.rotAxis === RotAxis.Free || this.rotAxis === RotAxis.Yaw) {
      if (dx !== 0) {
        const d = quatFromAxisAngle(up[0], up[1], up[2], -dx * sens);
        q = quatMul(d, q);
      }
    }
    if (this.rotAxis === RotAxis.Free || this.rotAxis === RotAxis.Pitch) {
      if (dy !== 0) {
        const d = quatFromAxisAngle(right[0], right[1], right[2], -dy * sens);
        q = quatMul(d, q);
      }
    }
    if (this.rotAxis === RotAxis.Roll) {
      if (dx !== 0) {
        const d = quatFromAxisAngle(fwd[0], fwd[1], fwd[2], -dx * sens);
        q = quatMul(d, q);
      }
    }

    this.propQuat = quatNormalize(q);
    this.ctx.sim.sendCommand({ type: "rotateGrab", entityId: this.grabbedEntity, quaternion: this.propQuat });
  }

  /** Camera world-space basis (forward, right, up) from the renderer's camera. */
  private cameraBasis(): { fwd: Vec3; right: Vec3; up: Vec3 } {
    const cam = this.ctx.renderer.getCameraPosition();
    const target = this.ctx.renderer.getCameraTarget();
    const fwd = normalize3([target[0] - cam[0], target[1] - cam[1], target[2] - cam[2]]);
    const right = normalize3(cross(fwd, [0, 1, 0]));
    const up = cross(right, fwd); // already unit (right ⊥ fwd)
    return { fwd, right, up };
  }

  /** Read a prop's current orientation from the SAB (entityId = slotIdx + 1). */
  private readPropQuat(entityId: number): Quat {
    const reader = new SimBufferReader(this.ctx.simSAB);
    const slot = reader.getEntitySlot(entityId - 1);
    return [slot.f32[ENT.ROT_X], slot.f32[ENT.ROT_Y], slot.f32[ENT.ROT_Z], slot.f32[ENT.ROT_W]];
  }

  /** Raycast from camera center and find the closest prop entity. */
  private raycastForProp(): number | null {
    const reader = new SimBufferReader(this.ctx.simSAB);
    const cam = this.ctx.renderer.getCameraPosition();
    const target = this.ctx.renderer.getCameraTarget();
    const dx = target[0] - cam[0];
    const dy = target[1] - cam[1];
    const dz = target[2] - cam[2];
    const dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const dir: [number, number, number] = [dx / dl, dy / dl, dz / dl];

    const count = reader.getEntityCount();
    let closestEntity: number | null = null;
    let closestDist = Infinity;

    for (let i = 0; i < count; i++) {
      const slot = reader.getEntitySlot(i);
      const type = slot.u32[ENT.TYPE];
      if (type === 255 || (type !== EntityType.Prop && type !== EntityType.Mannequin)) continue;
      const px = slot.f32[ENT.POS_X];
      const py = slot.f32[ENT.POS_Y];
      const pz = slot.f32[ENT.POS_Z];
      const scale = slot.f32[ENT.SCALE] || 1.0;

      // Sphere intersection using the prop's actual scale as radius.
      const ox = px - cam[0];
      const oy = py - cam[1];
      const oz = pz - cam[2];
      const proj = ox * dir[0] + oy * dir[1] + oz * dir[2];
      if (proj < 0) continue;
      const perpSq = ox * ox + oy * oy + oz * oz - proj * proj;
      const radius = scale * 0.5; // prop extends ~0.5× scale from center
      if (perpSq > radius * radius) continue;
      if (proj < closestDist) {
        closestDist = proj;
        closestEntity = i + 1; // entityId = slotIdx + 1 (sim assigns sequentially from 1)
      }
    }

    return closestEntity;
  }
}

// ── Toolgun ──

export class Toolgun {
  private ctx: WeaponContext;
  private context: ToolgunContext = ToolgunContext.Spawn;
  private selectedContentId: string | null = null;
  private selectedFunMode: FunMode = FunMode.Normal;

  constructor(ctx: WeaponContext) {
    this.ctx = ctx;
  }

  setContext(context: ToolgunContext): void {
    this.context = context;
  }

  getContext(): ToolgunContext {
    return this.context;
  }

  setSelectedContent(contentId: string): void {
    this.selectedContentId = contentId;
  }

  setFunMode(mode: FunMode): void {
    this.selectedFunMode = mode;
  }

  /** Primary fire — context-dependent action. */
  onPrimaryDown(): void {
    switch (this.context) {
      case ToolgunContext.Spawn:
        if (this.selectedContentId) {
          const cam = this.ctx.renderer.getCameraPosition();
          const target = this.ctx.renderer.getCameraTarget();
          const dx = target[0] - cam[0];
          const dy = target[1] - cam[1];
          const dz = target[2] - cam[2];
          const dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
          const shape = this.ctx.getShapeForContent?.(this.selectedContentId)
            ?? (this.selectedContentId.includes("sphere") || this.selectedContentId.includes("ball") ? "sphere" : "box");
          this.ctx.sim.sendCommand({
            type: "spawn",
            contentId: this.selectedContentId,
            position: [cam[0] + (dx / dl) * 5, cam[1] + (dy / dl) * 5 + 2, cam[2] + (dz / dl) * 5],
            shape,
          });
        }
        break;
      case ToolgunContext.Remove: {
        // Raycast and remove the hit prop
        const entityId = this.raycastForProp();
        if (entityId !== null) {
          this.ctx.sim.sendCommand({ type: "remove", entityId });
        }
        break;
      }
      case ToolgunContext.SetFunMode:
        this.ctx.sim.sendCommand({ type: "setFunMode", mode: this.selectedFunMode });
        break;
    }
  }

  onPrimaryUp(): void { /* toolgun is instant-fire */ }

  tick(): void { /* toolgun has no per-frame action */ }

  private raycastForProp(): number | null {
    const reader = new SimBufferReader(this.ctx.simSAB);
    const cam = this.ctx.renderer.getCameraPosition();
    const target = this.ctx.renderer.getCameraTarget();
    const dx = target[0] - cam[0];
    const dy = target[1] - cam[1];
    const dz = target[2] - cam[2];
    const dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const dir: [number, number, number] = [dx / dl, dy / dl, dz / dl];

    const count = reader.getEntityCount();
    let closestEntity: number | null = null;
    let closestDist = Infinity;

    for (let i = 0; i < count; i++) {
      const slot = reader.getEntitySlot(i);
      const type = slot.u32[ENT.TYPE];
      if (type === 255 || (type !== EntityType.Prop && type !== EntityType.Mannequin)) continue;
      const px = slot.f32[ENT.POS_X];
      const py = slot.f32[ENT.POS_Y];
      const pz = slot.f32[ENT.POS_Z];
      const ox = px - cam[0];
      const oy = py - cam[1];
      const oz = pz - cam[2];
      const proj = ox * dir[0] + oy * dir[1] + oz * dir[2];
      if (proj < 0 || proj >= closestDist) continue;
      const perpSq = ox * ox + oy * oy + oz * oz - proj * proj;
      if (perpSq > 1.0) continue;
      closestDist = proj;
      closestEntity = i + 1;
    }
    return closestEntity;
  }
}

// ── Pistol ──

export class Pistol {
  private ctx: WeaponContext;
  private fireCooldown = 0;
  private readonly fireRate = 0.15; // seconds between shots

  constructor(ctx: WeaponContext) {
    this.ctx = ctx;
  }

  onPrimaryDown(): void { this.fire(); }
  onPrimaryUp(): void { /* pistol is semi-auto */ }

  tick(dt: number): void {
    if (this.fireCooldown > 0) this.fireCooldown -= dt;
  }

  private fire(): void {
    if (this.fireCooldown > 0) return;
    this.fireCooldown = this.fireRate;

    const cam = this.ctx.renderer.getCameraPosition();
    const target = this.ctx.renderer.getCameraTarget();
    const dx = target[0] - cam[0];
    const dy = target[1] - cam[1];
    const dz = target[2] - cam[2];
    const dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const dir: [number, number, number] = [dx / dl, dy / dl, dz / dl];

    this.ctx.sim.sendCommand({
      type: "fireWeapon",
      origin: [cam[0] + dir[0] * 1, cam[1] + dir[1] * 1, cam[2] + dir[2] * 1],
      direction: dir,
    });
  }
}

// ── Paintgun (stub — full implementation in Phase 5) ──

export class Paintgun {
  private ctx: WeaponContext;
  private firing = false;

  constructor(ctx: WeaponContext) {
    this.ctx = ctx;
  }

  onPrimaryDown(): void { this.firing = true; }
  onPrimaryUp(): void { this.firing = false; }
  tick(_dt: number): void {
    if (!this.firing) return;
    // Paint implementation in Phase 5
  }
}

// ── Weapon Controller ──

export class WeaponController {
  private physgun: Physgun;
  private toolgun: Toolgun;
  private pistol: Pistol;
  private paintgun: Paintgun;
  private currentTool: ToolType = ToolType.Physgun;
  private ctx: WeaponContext;

  constructor(ctx: WeaponContext) {
    this.ctx = ctx;
    this.physgun = new Physgun(ctx);
    this.toolgun = new Toolgun(ctx);
    this.pistol = new Pistol(ctx);
    this.paintgun = new Paintgun(ctx);
  }

  setTool(tool: ToolType): void {
    if (this.currentTool === tool) return;
    // Release physgun grab if switching away
    if (this.currentTool === ToolType.Physgun && this.physgun.isGrabbing()) {
      this.physgun.onPrimaryUp();
    }
    this.currentTool = tool;
  }

  getTool(): ToolType {
    return this.currentTool;
  }

  getPhysgun(): Physgun { return this.physgun; }
  getToolgun(): Toolgun { return this.toolgun; }
  getPistol(): Pistol { return this.pistol; }
  getPaintgun(): Paintgun { return this.paintgun; }

  onPrimaryDown(): void {
    switch (this.currentTool) {
      case ToolType.Physgun: this.physgun.onPrimaryDown(); break;
      case ToolType.Toolgun: this.toolgun.onPrimaryDown(); break;
      case ToolType.Pistol: this.pistol.onPrimaryDown(); break;
      case ToolType.Paintgun: this.paintgun.onPrimaryDown(); break;
    }
  }

  onPrimaryUp(): void {
    switch (this.currentTool) {
      case ToolType.Physgun: this.physgun.onPrimaryUp(); break;
      case ToolType.Toolgun: this.toolgun.onPrimaryUp(); break;
      case ToolType.Pistol: this.pistol.onPrimaryUp(); break;
      case ToolType.Paintgun: this.paintgun.onPrimaryUp(); break;
    }
  }

  tick(dt: number): void {
    this.physgun.tick();
    this.toolgun.tick();
    this.pistol.tick(dt);
    this.paintgun.tick(dt);
  }
}
