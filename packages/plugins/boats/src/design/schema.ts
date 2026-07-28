// ============================================================================
// Boat Design Schema — version, migrations, (de)serialization, and cloning
// ============================================================================

import { BoatDesign, BoatDesignId, BOAT_DESIGN_SCHEMA_VERSION, DesignFingerprint } from "./types";

export type DesignMigration = (input: unknown) => unknown;

const MIGRATIONS: Record<string, DesignMigration> = {
  // Current version is canonical; no older migrations yet.
  [BOAT_DESIGN_SCHEMA_VERSION]: (input) => input,
};

/** Determine the schema version of an arbitrary design value. */
function getSchemaVersion(input: unknown): string {
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (typeof obj.schemaVersion === "string") return obj.schemaVersion;
    if (obj.metadata && typeof obj.metadata === "object") {
      const meta = obj.metadata as Record<string, unknown>;
      if (typeof meta.schemaVersion === "string") return meta.schemaVersion;
    }
  }
  return "";
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/** Produce a deterministic canonical string of a design (no id/timestamp drift). */
function canonicalString(design: BoatDesign): string {
  const canonical = {
    schemaVersion: design.metadata.schemaVersion,
    name: design.metadata.name,
    description: design.metadata.description,
    class: design.metadata.class,
    hullBodies: design.hullBodies.map((b) => ({
      id: b.id,
      position: b.position,
      rotation: b.rotation,
      isWatertight: b.isWatertight,
      material: b.material,
      density: b.density,
      stations: b.stations.map((s) => ({ z: s.z, points: s.points })),
      compartments: b.compartments,
    })),
    decks: design.decks.map((d) => ({
      id: d.id,
      height: d.height,
      outline: d.outline,
      holes: d.holes,
      thickness: d.thickness,
      material: d.material,
    })),
    hardpoints: design.hardpoints.map((h) => ({
      id: h.id,
      type: h.type,
      position: h.position,
      rotation: h.rotation,
      label: h.label,
    })),
    modules: design.modules.map((m) => ({
      moduleId: m.moduleId,
      position: m.position,
      rotation: m.rotation,
      cosmetic: m.cosmetic,
    })),
    symmetry: design.symmetry,
    tuning: design.tuning,
  };
  return JSON.stringify(canonical, Object.keys(canonical).sort());
}

/** Compute a simple, deterministic 53-bit hash for design comparisons. */
export function hashDesign(design: BoatDesign): string {
  const str = canonicalString(design);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = (4294967296 * (2097151 & h2) + (h1 >>> 0)) / 4503599627370496;
  return n.toString(36).slice(2, 14);
}

export function fingerprintDesign(design: BoatDesign): DesignFingerprint {
  const canonical = canonicalString(design);
  return { hash: hashDesign(design), canonical };
}

export function serializeDesign(design: BoatDesign): string {
  return JSON.stringify(design, Object.keys(design).sort());
}

export function deserializeDesign(json: string): unknown {
  return JSON.parse(json);
}

/** Migrate a raw design object to the current schema version without validation. */
export function migrateDesign(input: unknown): unknown {
  if (input === null || typeof input !== "object") return input;
  const version = getSchemaVersion(input);
  const migration = MIGRATIONS[version] ?? MIGRATIONS[BOAT_DESIGN_SCHEMA_VERSION];
  return migration ? migration(input) : input;
}

/** Assign a fresh, stable id to a design. */
export function generateDesignId(name: string, timestamp?: number): BoatDesignId {
  const t = timestamp ?? Date.now();
  const prefix = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 32);
  return `${prefix}-${t.toString(36)}`;
}

/** Create a mutable copy of a design with a new id and updated timestamps. */
export function cloneDesign(design: BoatDesign, newName?: string): BoatDesign {
  const now = Date.now();
  const clone = deepClone(design);
  clone.metadata.id = generateDesignId(newName ?? design.metadata.name, now);
  clone.metadata.schemaVersion = BOAT_DESIGN_SCHEMA_VERSION;
  clone.metadata.name = newName ?? design.metadata.name;
  clone.metadata.immutable = false;
  clone.metadata.createdAt = now;
  clone.metadata.updatedAt = now;
  return clone;
}

/** Apply an immutable edit command to a design and return a new design instance. */
export function applyEditCommand(design: BoatDesign, command: any): BoatDesign {
  const next = deepClone(design);
  next.metadata.updatedAt = Date.now();
  switch (command?.type) {
    case "rename":
      if (command.name !== undefined) next.metadata.name = String(command.name);
      if (command.description !== undefined) next.metadata.description = String(command.description);
      break;
    case "addHullBody":
      if (command.body) next.hullBodies.push(command.body);
      break;
    case "updateHullBody": {
      const idx = next.hullBodies.findIndex((b) => b.id === command.id);
      if (idx >= 0 && command.body) {
        next.hullBodies[idx] = { ...next.hullBodies[idx], ...command.body };
      }
      break;
    }
    case "removeHullBody":
      next.hullBodies = next.hullBodies.filter((b) => b.id !== command.id);
      break;
    case "addDeck":
      if (command.deck) next.decks.push(command.deck);
      break;
    case "updateDeck": {
      const idx = next.decks.findIndex((d) => d.id === command.id);
      if (idx >= 0 && command.deck) {
        next.decks[idx] = { ...next.decks[idx], ...command.deck };
      }
      break;
    }
    case "removeDeck":
      next.decks = next.decks.filter((d) => d.id !== command.id);
      break;
    case "addHardpoint":
      if (command.hardpoint) next.hardpoints.push(command.hardpoint);
      break;
    case "moveHardpoint": {
      const hp = next.hardpoints.find((h) => h.id === command.id);
      if (hp && command.position) {
        hp.position = command.position;
        if (command.rotation) hp.rotation = command.rotation;
      }
      break;
    }
    case "removeHardpoint":
      next.hardpoints = next.hardpoints.filter((h) => h.id !== command.id);
      break;
    case "placeModule":
      if (command.module) next.modules.push(command.module);
      break;
    case "removeModule": {
      const tol = command.tolerance ?? 0.001;
      const p = command.position;
      next.modules = next.modules.filter((m) => {
        if (!p) return false;
        const dx = m.position.x - p.x;
        const dy = m.position.y - p.y;
        const dz = m.position.z - p.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz) > tol;
      });
      break;
    }
    case "setSymmetry":
      if (command.symmetry) next.symmetry = command.symmetry;
      break;
    case "setTuning":
      if (!next.tuning) next.tuning = {};
      if (command.key !== undefined && command.value !== undefined) {
        next.tuning[command.key] = Number(command.value);
      }
      break;
    default:
      break;
  }
  return next;
}
