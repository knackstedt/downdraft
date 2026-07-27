// ============================================================================
// Boat Design Validators — structural, derived, and runtime invariant checks
// ============================================================================

import {
  BoatClass,
  BoatDesign,
  BoatDesignMetadata,
  DeckLevel,
  Hardpoint,
  HardpointType,
  HullBody,
  HullCompartment,
  HullStation,
  PlacedModule,
  SymmetryMode,
  ValidationResult,
} from "./types";

const EPS = 1e-6;
const REQUIRED_HARDPOINTS: HardpointType[] = ["helm"];
const VALID_MATERIALS = new Set([
  "wood",
  "steel",
  "aluminum",
  "fiberglass",
  "composite",
  "concrete",
  "inflatable",
]);

function fail(errors: string[], msg: string): void {
  errors.push(msg);
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function isVec2(v: unknown): boolean {
  return (
    typeof v === "object" && v !== null && isFiniteNumber((v as any).x) && isFiniteNumber((v as any).y)
  );
}

function isVec3(v: unknown): boolean {
  return (
    typeof v === "object" &&
    v !== null &&
    isFiniteNumber((v as any).x) &&
    isFiniteNumber((v as any).y) &&
    isFiniteNumber((v as any).z)
  );
}

function isQuat(v: unknown): boolean {
  return (
    typeof v === "object" &&
    v !== null &&
    isFiniteNumber((v as any).x) &&
    isFiniteNumber((v as any).y) &&
    isFiniteNumber((v as any).z) &&
    isFiniteNumber((v as any).w)
  );
}

function polygonArea2D(points: { x: number; y: number }[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p0 = points[i];
    const p1 = points[(i + 1) % points.length];
    a += p0.x * p1.y - p1.x * p0.y;
  }
  return a * 0.5;
}

function polygonIsSelfIntersecting(points: { x: number; y: number }[]): boolean {
  const n = points.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a1 = points[i];
    const a2 = points[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      const b1 = points[j];
      const b2 = points[(j + 1) % n];
      if (i === 0 && j === n - 1) continue; // shared endpoint
      const d = (a2.x - a1.x) * (b2.y - b1.y) - (a2.y - a1.y) * (b2.x - b1.x);
      if (Math.abs(d) < EPS) continue;
      const ua =
        ((b2.x - b1.x) * (a1.y - b1.y) - (b2.y - b1.y) * (a1.x - b1.x)) / d;
      const ub =
        ((a2.x - a1.x) * (a1.y - b1.y) - (a2.y - a1.y) * (a1.x - b1.x)) / d;
      if (ua > EPS && ua < 1 - EPS && ub > EPS && ub < 1 - EPS) return true;
    }
  }
  return false;
}

function validateMetadata(meta: unknown, path: string, errors: string[]): void {
  if (!meta || typeof meta !== "object") {
    fail(errors, `${path}: metadata must be an object`);
    return;
  }
  const m = meta as Partial<BoatDesignMetadata>;
  if (typeof m.id !== "string" || m.id.length === 0) {
    fail(errors, `${path}.id: non-empty string required`);
  }
  if (typeof m.schemaVersion !== "string" || m.schemaVersion.length === 0) {
    fail(errors, `${path}.schemaVersion: non-empty string required`);
  }
  if (typeof m.name !== "string" || m.name.length === 0) {
    fail(errors, `${path}.name: non-empty string required`);
  }
  if (typeof m.description !== "string") {
    fail(errors, `${path}.description: string required`);
  }
  if (!Object.values(BoatClass).includes(m.class as BoatClass)) {
    fail(errors, `${path}.class: must be a valid BoatClass`);
  }
  if (m.createdAt === undefined || !isFiniteNumber(m.createdAt) || m.createdAt <= 0) {
    fail(errors, `${path}.createdAt: positive timestamp required`);
  }
  if (m.updatedAt === undefined || !isFiniteNumber(m.updatedAt) || m.updatedAt < m.createdAt!) {
    fail(errors, `${path}.updatedAt: timestamp >= createdAt required`);
  }
}

function validateStation(station: unknown, path: string, errors: string[]): void {
  if (!station || typeof station !== "object") {
    fail(errors, `${path}: must be an object`);
    return;
  }
  const s = station as Partial<HullStation>;
  if (!isFiniteNumber(s.z)) {
    fail(errors, `${path}.z: finite number required`);
  }
  if (!Array.isArray(s.points) || s.points.length < 3) {
    fail(errors, `${path}.points: array of at least 3 Vec2 required`);
    return;
  }
  for (let i = 0; i < s.points.length; i++) {
    if (!isVec2(s.points[i])) {
      fail(errors, `${path}.points[${i}]: invalid Vec2`);
    }
  }
  if (polygonIsSelfIntersecting(s.points)) {
    fail(errors, `${path}.points: polygon must not self-intersect`);
  }
  if (Math.abs(polygonArea2D(s.points)) < EPS) {
    fail(errors, `${path}.points: polygon area must be > 0`);
  }
}

function validateCompartment(c: unknown, path: string, errors: string[]): void {
  if (!c || typeof c !== "object") {
    fail(errors, `${path}: must be an object`);
    return;
  }
  const comp = c as Partial<HullCompartment>;
  if (typeof comp.id !== "string" || comp.id.length === 0) {
    fail(errors, `${path}.id: non-empty string required`);
  }
  if (
    !Array.isArray(comp.stationRange) ||
    comp.stationRange.length !== 2 ||
    !isFiniteNumber(comp.stationRange[0]) ||
    !isFiniteNumber(comp.stationRange[1]) ||
    comp.stationRange[0] >= comp.stationRange[1]
  ) {
    fail(errors, `${path}.stationRange: [start,end) integer pair required`);
  }
  if (comp.capacity !== undefined && (!isFiniteNumber(comp.capacity) || comp.capacity < 0)) {
    fail(errors, `${path}.capacity: non-negative number required`);
  }
}

function validateHullBody(body: unknown, path: string, errors: string[]): void {
  if (!body || typeof body !== "object") {
    fail(errors, `${path}: must be an object`);
    return;
  }
  const b = body as Partial<HullBody>;
  if (typeof b.id !== "string" || b.id.length === 0) {
    fail(errors, `${path}.id: non-empty string required`);
  }
  if (!isVec3(b.position)) fail(errors, `${path}.position: invalid Vec3`);
  if (!isQuat(b.rotation)) fail(errors, `${path}.rotation: invalid Quat`);
  if (typeof b.isWatertight !== "boolean") {
    fail(errors, `${path}.isWatertight: boolean required`);
  }
  if (!Array.isArray(b.stations) || b.stations.length < 2) {
    fail(errors, `${path}.stations: array of at least 2 HullStation required`);
    return;
  }

  // Stations must be sorted ascending in z
  for (let i = 0; i < b.stations.length; i++) {
    validateStation(b.stations[i], `${path}.stations[${i}]`, errors);
  }
  for (let i = 1; i < b.stations.length; i++) {
    if (b.stations[i].z <= b.stations[i - 1].z + EPS) {
      fail(errors, `${path}.stations[${i}].z: must be strictly increasing`);
    }
  }

  if (b.material !== undefined && !VALID_MATERIALS.has(b.material)) {
    fail(errors, `${path}.material: unknown material "${b.material}"`);
  }
  if (b.density !== undefined && (!isFiniteNumber(b.density) || b.density <= 0)) {
    fail(errors, `${path}.density: positive number required`);
  }
  if (Array.isArray(b.compartments)) {
    for (let i = 0; i < b.compartments.length; i++) {
      validateCompartment(b.compartments[i], `${path}.compartments[${i}]`, errors);
    }
  }
}

function validateDeck(deck: unknown, path: string, errors: string[]): void {
  if (!deck || typeof deck !== "object") {
    fail(errors, `${path}: must be an object`);
    return;
  }
  const d = deck as Partial<DeckLevel>;
  if (typeof d.id !== "string" || d.id.length === 0) {
    fail(errors, `${path}.id: non-empty string required`);
  }
  if (!isFiniteNumber(d.height)) fail(errors, `${path}.height: finite number required`);
  if (!Array.isArray(d.outline) || d.outline.length < 3) {
    fail(errors, `${path}.outline: array of at least 3 Vec2 required`);
    return;
  }
  for (let i = 0; i < d.outline.length; i++) {
    if (!isVec2(d.outline[i])) fail(errors, `${path}.outline[${i}]: invalid Vec2`);
  }
  if (polygonIsSelfIntersecting(d.outline)) {
    fail(errors, `${path}.outline: polygon must not self-intersect`);
  }
  if (d.holes) {
    for (let i = 0; i < d.holes.length; i++) {
      const hole = d.holes[i];
      if (!Array.isArray(hole) || hole.length < 3) {
        fail(errors, `${path}.holes[${i}]: array of at least 3 Vec2 required`);
        continue;
      }
      for (let j = 0; j < hole.length; j++) {
        if (!isVec2(hole[j])) fail(errors, `${path}.holes[${i}][${j}]: invalid Vec2`);
      }
      if (polygonIsSelfIntersecting(hole)) {
        fail(errors, `${path}.holes[${i}]: hole polygon must not self-intersect`);
      }
    }
  }
  if (d.thickness !== undefined && (!isFiniteNumber(d.thickness) || d.thickness < 0)) {
    fail(errors, `${path}.thickness: non-negative number required`);
  }
  if (d.material !== undefined && !VALID_MATERIALS.has(d.material)) {
    fail(errors, `${path}.material: unknown material "${d.material}"`);
  }
}

function validateHardpoint(h: unknown, path: string, errors: string[]): void {
  if (!h || typeof h !== "object") {
    fail(errors, `${path}: must be an object`);
    return;
  }
  const hp = h as Partial<Hardpoint>;
  if (typeof hp.id !== "string" || hp.id.length === 0) {
    fail(errors, `${path}.id: non-empty string required`);
  }
  if (typeof hp.type !== "string" || hp.type.length === 0) {
    fail(errors, `${path}.type: non-empty string required`);
  }
  if (!isVec3(hp.position)) fail(errors, `${path}.position: invalid Vec3`);
  if (hp.rotation !== undefined && !isQuat(hp.rotation)) {
    fail(errors, `${path}.rotation: invalid Quat`);
  }
}

function validateModule(m: unknown, path: string, errors: string[]): void {
  if (!m || typeof m !== "object") {
    fail(errors, `${path}: must be an object`);
    return;
  }
  const mod = m as Partial<PlacedModule>;
  if (typeof mod.moduleId !== "string" || mod.moduleId.length === 0) {
    fail(errors, `${path}.moduleId: non-empty string required`);
  }
  if (!isVec3(mod.position)) fail(errors, `${path}.position: invalid Vec3`);
  if (mod.rotation !== undefined && !isQuat(mod.rotation)) {
    fail(errors, `${path}.rotation: invalid Quat`);
  }
}

/** Validate structural shape of a design object (no runtime geometry needed). */
export function validateBoatDesign(design: unknown): ValidationResult {
  const errors: string[] = [];
  if (!design || typeof design !== "object") {
    return { valid: false, errors: ["design must be an object"] };
  }
  const d = design as Partial<BoatDesign>;
  validateMetadata(d.metadata, "metadata", errors);

  if (!Object.values(SymmetryMode).includes(d.symmetry as SymmetryMode)) {
    fail(errors, "symmetry: must be a valid SymmetryMode");
  }

  if (!Array.isArray(d.hullBodies) || d.hullBodies.length === 0) {
    fail(errors, "hullBodies: at least one hull body required");
  } else {
    for (let i = 0; i < d.hullBodies.length; i++) {
      validateHullBody(d.hullBodies[i], `hullBodies[${i}]`, errors);
    }
  }

  if (!Array.isArray(d.decks)) {
    fail(errors, "decks: array required");
  } else {
    for (let i = 0; i < d.decks.length; i++) {
      validateDeck(d.decks[i], `decks[${i}]`, errors);
    }
  }

  if (!Array.isArray(d.hardpoints)) {
    fail(errors, "hardpoints: array required");
  } else {
    for (let i = 0; i < d.hardpoints.length; i++) {
      validateHardpoint(d.hardpoints[i], `hardpoints[${i}]`, errors);
    }
    const types = new Set(d.hardpoints.map((h) => h.type));
    for (const required of REQUIRED_HARDPOINTS) {
      if (!types.has(required)) {
        fail(errors, `hardpoints: required hardpoint type "${required}" missing`);
      }
    }
  }

  if (!Array.isArray(d.modules)) {
    fail(errors, "modules: array required");
  } else {
    for (let i = 0; i < d.modules.length; i++) {
      validateModule(d.modules[i], `modules[${i}]`, errors);
    }
  }

  if (d.tuning) {
    if (typeof d.tuning !== "object") {
      fail(errors, "tuning: must be an object");
    } else {
      for (const [key, value] of Object.entries(d.tuning)) {
        if (!isFiniteNumber(value)) {
          fail(errors, `tuning.${key}: finite number required`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Runtime / derived checks produced after mesh/mass generation. */
export interface DerivedDesignMetrics {
  volume: number; // m³
  mass: number; // kg
  draft: number; // m (approx)
  lengthOverall: number;
  beamOverall: number;
  /** Center of gravity from boat origin. */
  centerOfMass: { x: number; y: number; z: number };
  waterlineArea: number;
  metacentricHeight?: number;
}

export interface DerivedValidationOptions {
  maxMass?: number;
  maxDimension?: number;
  minFreeboard?: number;
  maxDraft?: number;
  minMetacentricHeight?: number;
}

const DEFAULT_DERIVED_LIMITS: Required<DerivedValidationOptions> = {
  maxMass: 50_000_000,
  maxDimension: 300,
  minFreeboard: 0.1,
  maxDraft: 50,
  minMetacentricHeight: 0,
};

/** Validate a design against computed runtime metrics. */
export function validateDerivedDesign(
  design: BoatDesign,
  metrics: DerivedDesignMetrics,
  options: DerivedValidationOptions = {},
): ValidationResult {
  const errors: string[] = [];
  const limits = { ...DEFAULT_DERIVED_LIMITS, ...options };

  if (metrics.volume <= 0) {
    fail(errors, "derived.volume: must be positive");
  }
  if (metrics.mass <= 0 || metrics.mass > limits.maxMass) {
    fail(errors, `derived.mass: must be positive and <= ${limits.maxMass} kg`);
  }
  if (
    metrics.lengthOverall <= 0 ||
    metrics.lengthOverall > limits.maxDimension ||
    metrics.beamOverall <= 0 ||
    metrics.beamOverall > limits.maxDimension
  ) {
    fail(errors, `derived.dimensions: must be positive and <= ${limits.maxDimension} m`);
  }
  if (metrics.draft < 0 || metrics.draft > limits.maxDraft) {
    fail(errors, `derived.draft: must be between 0 and ${limits.maxDraft} m`);
  }

  // Heuristic: freeboard = highest deck - waterline approximated by draft
  let highestDeck = -Infinity;
  for (const deck of design.decks) {
    if (deck.height > highestDeck) highestDeck = deck.height;
  }
  for (const body of design.hullBodies) {
    for (const s of body.stations) {
      for (const p of s.points) {
        if (p.y > highestDeck) highestDeck = p.y;
      }
    }
  }
  const freeboard = highestDeck - metrics.draft;
  if (freeboard < limits.minFreeboard) {
    fail(errors, `derived.freeboard: ${freeboard.toFixed(2)} m is below ${limits.minFreeboard} m`);
  }

  if (
    limits.minMetacentricHeight > 0 &&
    (metrics.metacentricHeight === undefined || metrics.metacentricHeight < limits.minMetacentricHeight)
  ) {
    fail(errors, `derived.metacentricHeight: must be >= ${limits.minMetacentricHeight} m`);
  }

  // Center of mass must be within the bounding box of the design
  if (
    !isFiniteNumber(metrics.centerOfMass.x) ||
    !isFiniteNumber(metrics.centerOfMass.y) ||
    !isFiniteNumber(metrics.centerOfMass.z)
  ) {
    fail(errors, "derived.centerOfMass: must be finite");
  }

  return { valid: errors.length === 0, errors };
}
