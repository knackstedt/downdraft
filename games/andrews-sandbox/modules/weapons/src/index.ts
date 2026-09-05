// ============================================================================
// @andrews-sandbox/module-weapons — physgun, toolgun, pistol, paintgun.
// Renderer-side weapon controllers that send commands to the sim worker.
// ============================================================================

import { SimBufferReader } from "@downdraft/core";
import { ENT } from "@downdraft/core";
import { EntityType, FunMode, ToolType, ToolgunContext } from "@sandbox/shared/types";

/** Minimal sim API for weapon commands. */
export interface WeaponSimApi {
  sendCommand(cmd: any): void;
}

/** Minimal renderer API for weapons. */
export interface WeaponRendererApi {
  getCameraPosition(): [number, number, number];
  getCameraTarget(): [number, number, number];
}

export interface WeaponContext {
  sim: WeaponSimApi;
  renderer: WeaponRendererApi;
  simSAB: SharedArrayBuffer;
}

// ── Physgun ──

export class Physgun {
  private ctx: WeaponContext;
  private grabbedEntity: number | null = null;
  private grabDistance = 5;

  constructor(ctx: WeaponContext) {
    this.ctx = ctx;
  }

  /** Start grabbing — raycast from camera center, find closest prop. */
  onPrimaryDown(): void {
    if (this.grabbedEntity !== null) return;
    const entityId = this.raycastForProp();
    if (entityId === null) return;
    this.grabbedEntity = entityId;
    this.ctx.sim.sendCommand({ type: "grabProp", entityId, origin: this.ctx.renderer.getCameraPosition() });
  }

  /** Release grabbed prop. */
  onPrimaryUp(): void {
    if (this.grabbedEntity === null) return;
    this.ctx.sim.sendCommand({ type: "releaseProp", entityId: this.grabbedEntity, velocity: [0, 0, 0] });
    this.grabbedEntity = null;
  }

  /** Update grabbed prop position (called every frame while grabbing). */
  tick(): void {
    if (this.grabbedEntity === null) return;
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
  }

  /** Adjust grab distance (scroll wheel). */
  adjustDistance(delta: number): void {
    this.grabDistance = Math.max(1, Math.min(20, this.grabDistance + delta));
  }

  isGrabbing(): boolean {
    return this.grabbedEntity !== null;
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
      if (type !== EntityType.Prop && type !== EntityType.Mannequin) continue;
      const px = slot.f32[ENT.POS_X];
      const py = slot.f32[ENT.POS_Y];
      const pz = slot.f32[ENT.POS_Z];

      // Simple sphere intersection (treat props as 0.5 radius spheres)
      const ox = px - cam[0];
      const oy = py - cam[1];
      const oz = pz - cam[2];
      const proj = ox * dir[0] + oy * dir[1] + oz * dir[2];
      if (proj < 0) continue;
      const perpSq = ox * ox + oy * oy + oz * oz - proj * proj;
      if (perpSq > 1.0) continue; // within 1m of ray
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
          const shape = this.selectedContentId.includes("sphere") || this.selectedContentId.includes("ball") ? "sphere" : "box";
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
      if (type !== EntityType.Prop && type !== EntityType.Mannequin) continue;
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
