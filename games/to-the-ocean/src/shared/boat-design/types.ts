// ============================================================================
// Boat Design Domain — authoritative types for the hybrid smooth-hull system
// ============================================================================

import type { Vec2, Vec3, Quat } from "../types";

export type { Vec2, Vec3, Quat };

export const BOAT_DESIGN_SCHEMA_VERSION = "1.0.0";

export type BoatDesignId = string;

export enum BoatClass {
  MonohullYacht = "monohull-yacht",
  Catamaran = "catamaran",
  Pontoon = "pontoon",
  Houseboat = "houseboat",
  Barge = "barge",
  Custom = "custom",
}

export enum SymmetryMode {
  None = "none",
  PortStarboard = "port-starboard",
  Longitudinal = "longitudinal",
}

export type HardpointType =
  | "helm"
  | "engine"
  | "anchor"
  | "mooring"
  | "mast"
  | "weapon"
  | "crane"
  | "dock";

export interface BoatDesignMetadata {
  id: BoatDesignId;
  schemaVersion: string;
  name: string;
  description: string;
  class: BoatClass;
  author?: string;
  immutable?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A single transverse section of a hull body in local (x=starboard, y=up) space. */
export interface HullStation {
  /** Longitudinal position; bow is negative Z, stern is positive Z. */
  z: number;
  /** Closed polygon representing the section, ordered counter-clockwise when
   *  looking from stern toward bow (positive Z toward negative Z). */
  points: Vec2[];
}

export interface HullCompartment {
  id: string;
  /** Station index range (inclusive start, exclusive end). */
  stationRange: [number, number];
  /** Deck / bulkhead ids that bound this compartment. Empty = full body. */
  bounds?: string[];
  /** Maximum floodable volume in m³. */
  capacity?: number;
}

export interface HullBody {
  id: string;
  /** Local offset of this hull relative to the boat origin. */
  position: Vec3;
  rotation: Quat;
  stations: HullStation[];
  /** Whether this body contributes to water displacement. */
  isWatertight: boolean;
  /** Material id used for rendering, physics, and mass properties. */
  material?: string;
  /** Density in kg/m³; undefined uses the material default. */
  density?: number;
  compartments?: HullCompartment[];
}

export interface DeckLevel {
  id: string;
  /** Vertical height of the deck surface in boat-local space. */
  height: number;
  /** Closed XZ polygon for the deck footprint. */
  outline: Vec2[];
  holes?: Vec2[][];
  /** Thickness of the deck slab (used for collision and meshing). */
  thickness?: number;
  material?: string;
}

export interface Hardpoint {
  id: string;
  type: HardpointType;
  position: Vec3;
  rotation?: Quat;
  /** Human-readable label shown in the dockyard. */
  label?: string;
}

export interface PlacedModule {
  moduleId: string;
  position: Vec3;
  rotation: Quat;
  /** If true, this module contributes to superstructure mass only. */
  cosmetic?: boolean;
}

export interface BoatDesign {
  metadata: BoatDesignMetadata;
  hullBodies: HullBody[];
  decks: DeckLevel[];
  hardpoints: Hardpoint[];
  modules: PlacedModule[];
  symmetry: SymmetryMode;
  /** Optional per-design tuning overrides (e.g., drag, stability). */
  tuning?: Record<string, number>;
}

/** Immutable edit command for the design domain. */
export type BoatDesignCommand =
  | { type: "addHullBody"; body: HullBody }
  | { type: "updateHullBody"; id: string; body: Partial<HullBody> }
  | { type: "removeHullBody"; id: string }
  | { type: "addDeck"; deck: DeckLevel }
  | { type: "updateDeck"; id: string; deck: Partial<DeckLevel> }
  | { type: "removeDeck"; id: string }
  | { type: "addHardpoint"; hardpoint: Hardpoint }
  | { type: "moveHardpoint"; id: string; position: Vec3; rotation?: Quat }
  | { type: "removeHardpoint"; id: string }
  | { type: "placeModule"; module: PlacedModule }
  | { type: "removeModule"; position: Vec3; tolerance?: number }
  | { type: "setSymmetry"; symmetry: SymmetryMode }
  | { type: "rename"; name: string; description?: string }
  | { type: "setTuning"; key: string; value: number };

/** Validation result returned by all validators. */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Hash / fingerprint of a design for deterministic comparisons. */
export interface DesignFingerprint {
  hash: string;
  /** Stable stringified form used for hashing. */
  canonical: string;
}
