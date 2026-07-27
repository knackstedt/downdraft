// ============================================================================
// Boat Design System — runtime authoritative system for smooth-hull boats
// ============================================================================

import {
  BoatDesign,
  RuntimeBoatGeometry,
  MassProperties,
  BOAT_DESIGN_PRESETS,
  BOAT_STARTER_PRESET,
  applyEditCommand,
} from "../../shared/boat-design";
import { DEFAULT_HULL_DENSITY } from "../../shared/boat-design/geometry";

export { type MassProperties };

interface BoatEntry {
  entityId: number;
  design: BoatDesign;
  geometry: RuntimeBoatGeometry;
}

export class BoatDesignSystem {
  private boats = new Map<number, BoatEntry>();
  private onDesignChanged: ((entityId: number, design: BoatDesign) => void) | null = null;
  private density: number;

  constructor(density = DEFAULT_HULL_DENSITY) {
    this.density = density;
  }

  setOnDesignChanged(cb: ((entityId: number, design: BoatDesign) => void) | null): void {
    this.onDesignChanged = cb;
  }

  setDensity(density: number): void {
    this.density = density;
    const entries = Array.from(this.boats.values());
    for (let i = 0; i < entries.length; i++) {
      entries[i].geometry.rebuild(entries[i].design, density);
    }
  }

  createBoat(entityId: number, design?: BoatDesign): boolean {
    if (this.boats.has(entityId)) return false;
    const d = design ?? this.defaultDesign();
    const geometry = new RuntimeBoatGeometry(d, this.density);
    this.boats.set(entityId, { entityId, design: d, geometry });
    return true;
  }

  loadPreset(entityId: number, presetName: keyof typeof BOAT_DESIGN_PRESETS): boolean {
    const factory = BOAT_DESIGN_PRESETS[presetName];
    if (!factory) return false;
    return this.setDesign(entityId, factory());
  }

  setDesign(entityId: number, design: BoatDesign): boolean {
    const geometry = new RuntimeBoatGeometry(design, this.density);
    const entry: BoatEntry = { entityId, design, geometry };
    this.boats.set(entityId, entry);
    this.onDesignChanged?.(entityId, design);
    return true;
  }

  applyEdit(entityId: number, command: unknown): boolean {
    const entry = this.boats.get(entityId);
    if (!entry) return false;
    const next = applyEditCommand(entry.design, command as any);
    if (next === entry.design) return false;
    this.setDesign(entityId, next);
    return true;
  }

  removeBoat(entityId: number): void {
    this.boats.delete(entityId);
  }

  clear(): void {
    this.boats.clear();
  }

  getDesign(entityId: number): BoatDesign | null {
    return this.boats.get(entityId)?.design ?? null;
  }

  getGeometry(entityId: number): RuntimeBoatGeometry | null {
    return this.boats.get(entityId)?.geometry ?? null;
  }

  getDesigns(): { entityId: number; design: BoatDesign }[] {
    const result: { entityId: number; design: BoatDesign }[] = [];
    const entries = Array.from(this.boats.entries());
    for (let i = 0; i < entries.length; i++) {
      const [entityId, entry] = entries[i];
      result.push({ entityId, design: entry.design });
    }
    return result;
  }

  getMassProperties(entityId: number): MassProperties | null {
    return this.getGeometry(entityId)?.getMassProperties() ?? null;
  }

  getShipCollisionRadius(entityId: number): number {
    return this.getGeometry(entityId)?.getCollisionRadius() ?? 4;
  }

  isOverHull(entityId: number, localX: number, localZ: number): boolean {
    return this.getGeometry(entityId)?.isOverHull(localX, localZ) ?? false;
  }

  resolvePlayerCollision(
    entityId: number,
    localX: number,
    localY: number,
    localZ: number,
    radius: number,
    height: number,
  ): { x: number; z: number; floorY: number } {
    const geometry = this.getGeometry(entityId);
    if (!geometry) return { x: localX, z: localZ, floorY: 0 };
    const result = geometry.resolvePlayerCollision(localX, localY, localZ, radius, height);
    return { x: result.x, z: result.z, floorY: result.floorY };
  }

  findClimbableEdge(
    entityId: number,
    localX: number,
    localY: number,
    localZ: number,
    climbThreshold: number,
    _playerHeight: number,
    maxHorizontalDist: number,
  ): { gridX: number; gridY: number; gridZ: number; edgeLocalX: number; edgeLocalZ: number; topLocalY: number; targetLocalX: number; targetLocalZ: number } | null {
    const geometry = this.getGeometry(entityId);
    if (!geometry) return null;

    // Search outward from the player for an overhull point within climb range.
    const step = Math.min(0.25, maxHorizontalDist / 2);
    const maxSteps = Math.max(1, Math.ceil(maxHorizontalDist / step));

    for (let ix = -maxSteps; ix <= maxSteps; ix++) {
      for (let iz = -maxSteps; iz <= maxSteps; iz++) {
        const lx = localX + ix * step;
        const lz = localZ + iz * step;
        const dx = lx - localX;
        const dz = lz - localZ;
        if (dx * dx + dz * dz > maxHorizontalDist * maxHorizontalDist) continue;
        if (!geometry.isOverHull(lx, lz)) continue;
        const topY = geometry.getHeightAt(lx, lz);
        if (!Number.isFinite(topY)) continue;
        if (topY <= localY + 0.1) continue;
        if (topY - localY > climbThreshold) continue;
        return {
          gridX: Math.round(lx / 2), gridY: Math.round(topY), gridZ: Math.round(lz / 2),
          edgeLocalX: lx,
          edgeLocalZ: lz,
          topLocalY: topY,
          targetLocalX: lx,
          targetLocalZ: lz,
        };
      }
    }
    return null;
  }

  private defaultDesign(): BoatDesign {
    const factory = BOAT_DESIGN_PRESETS[BOAT_STARTER_PRESET];
    return factory();
  }
}
