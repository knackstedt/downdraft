// ============================================================================
// Ship Builder — hull building, module placement, interior/exterior
// ============================================================================

import { ShipDesign, HullSection, ModuleDef, Vec3, Quat, PortSize } from "../../shared/types";
import { PORT_MAX_HULL_SIZE } from "../../shared/constants";
import { StructureIntegrity } from "../physics/StructureIntegrity";

export class ShipBuilder {
  private designs = new Map<string, ShipDesign>();

  // Create a new ship design
  createDesign(name: string): ShipDesign {
    const id = `design_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const design: ShipDesign = {
      id,
      name,
      hullSections: [],
      modules: [],
      placeables: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.designs.set(id, design);
    return design;
  }

  // Add a hull section (only at medium/large ports)
  addHullSection(designId: string, section: HullSection, portSize: PortSize): boolean {
    const design = this.designs.get(designId);
    if (!design) return false;

    // Hull modification requires medium or large port
    if (portSize < PortSize.Medium) return false;

    // Check hull size limit
    const totalVolume = this.calculateTotalHullVolume(design) + section.size.x * section.size.y * section.size.z;
    if (totalVolume > PORT_MAX_HULL_SIZE[portSize]) return false;

    design.hullSections.push(section);
    design.updatedAt = Date.now();
    return true;
  }

  removeHullSection(designId: string, sectionId: string, portSize: PortSize): boolean {
    const design = this.designs.get(designId);
    if (!design) return false;
    if (portSize < PortSize.Medium) return false;

    design.hullSections = design.hullSections.filter(s => s.id !== sectionId);
    design.updatedAt = Date.now();
    return true;
  }

  addModule(designId: string, moduleDefId: string, position: Vec3, rotation: Quat): boolean {
    const design = this.designs.get(designId);
    if (!design) return false;

    // Check if module fits within hull volume
    if (!this.isWithinHull(design, position)) return false;

    design.modules.push({ moduleDefId, position, rotation });
    design.updatedAt = Date.now();
    return true;
  }

  removeModule(designId: string, index: number): boolean {
    const design = this.designs.get(designId);
    if (!design || index < 0 || index >= design.modules.length) return false;
    design.modules.splice(index, 1);
    design.updatedAt = Date.now();
    return true;
  }

  addPlaceable(designId: string, placeableId: string, position: Vec3, rotation: Quat): boolean {
    const design = this.designs.get(designId);
    if (!design) return false;
    if (!this.isWithinHull(design, position)) return false;
    design.placeables.push({ placeableId, position, rotation });
    design.updatedAt = Date.now();
    return true;
  }

  removePlaceable(designId: string, index: number): boolean {
    const design = this.designs.get(designId);
    if (!design || index < 0 || index >= design.placeables.length) return false;
    design.placeables.splice(index, 1);
    design.updatedAt = Date.now();
    return true;
  }

  saveDesign(designId: string): boolean {
    const design = this.designs.get(designId);
    if (!design) return false;
    design.updatedAt = Date.now();
    return true;
  }

  deleteDesign(designId: string): boolean {
    return this.designs.delete(designId);
  }

  loadDesign(designId: string): ShipDesign | null {
    return this.designs.get(designId) ?? null;
  }

  getAllDesigns(): ShipDesign[] {
    return Array.from(this.designs.values());
  }

  // Calculate total hull integrity
  calculateIntegrity(design: ShipDesign): number {
    let total = 0;
    for (const section of design.hullSections) {
      total += section.integrity;
    }
    // Modules can add or reduce integrity
    for (const mod of design.modules) {
      // In full implementation, look up module def for integrity contribution
      total += 5; // placeholder
    }
    return total;
  }

  // Calculate total hull volume
  private calculateTotalHullVolume(design: ShipDesign): number {
    let volume = 0;
    for (const section of design.hullSections) {
      volume += section.size.x * section.size.y * section.size.z;
    }
    return volume;
  }

  // Check if a position is within the hull envelope
  private isWithinHull(design: ShipDesign, position: Vec3): boolean {
    for (const section of design.hullSections) {
      const dx = Math.abs(position.x - section.position.x);
      const dy = Math.abs(position.y - section.position.y);
      const dz = Math.abs(position.z - section.position.z);
      if (dx <= section.size.x / 2 && dy <= section.size.y / 2 && dz <= section.size.z / 2) {
        return true;
      }
    }
    return false;
  }

  // Get max module count for a design
  getMaxModules(design: ShipDesign): number {
    const volume = this.calculateTotalHullVolume(design);
    return Math.floor(volume * 0.5);
  }
}
