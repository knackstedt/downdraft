// ============================================================================
// Boat Design Presets — five canonical boats from the production schema
// ============================================================================

import type { Vec2, Vec3, Quat } from "../types";
import {
  BoatClass,
  BoatDesign,
  BoatDesignMetadata,
  DeckLevel,
  Hardpoint,
  HullBody,
  HullStation,
  SymmetryMode,
} from "./types";
import { generateDesignId } from "./schema";

const DEG2RAD = Math.PI / 180;

const identityQuat: Quat = { x: 0, y: 0, z: 0, w: 1 };

function vec2(x: number, y: number): Vec2 {
  return { x, y };
}

function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

/** Interpolate between two hull section shapes. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Generate N evenly-spaced hull stations between zStart and zEnd. */
function stationRange(
  zStart: number,
  zEnd: number,
  count: number,
  generator: (z: number, t: number) => Vec2[],
): HullStation[] {
  const stations: HullStation[] = [];
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0;
    const z = lerp(zStart, zEnd, t);
    stations.push({ z, points: generator(z, t) });
  }
  return stations;
}

/**
 * V-shaped monohull section. Points are ordered counter-clockwise when looking
 * from stern to bow (negative to positive Z). Y=0 is the calm-water design waterline;
 * positive Y is above water, negative Y is below.
 */
function vSection(
  beam: number,
  draft: number,
  freeboard: number,
  chineY: number = -draft * 0.35,
): Vec2[] {
  const halfBeam = beam * 0.5;
  const chineBeam = halfBeam * 0.85;
  return [
    vec2(-halfBeam, freeboard), // port deck
    vec2(-chineBeam, chineY), // port chine
    vec2(0, -draft), // keel
    vec2(chineBeam, chineY), // starboard chine
    vec2(halfBeam, freeboard), // starboard deck
  ];
}

/** Round-bilged monohull section — flatter bottom with radiused turn of bilge. */
function roundBilgeSection(beam: number, draft: number, freeboard: number, n: number = 7): Vec2[] {
  const halfBeam = beam * 0.5;
  const bilgeY = -draft * 0.55;
  const bilgeX = halfBeam * 0.55;
  const r = Math.min(draft * 0.35, halfBeam * 0.25);
  const centerY = bilgeY;
  const centerX = bilgeX;
  const points: Vec2[] = [vec2(-halfBeam, freeboard), vec2(-bilgeX, bilgeY)];
  // Arc across the bottom
  for (let i = 1; i < n - 1; i++) {
    const ang = Math.PI - (i / (n - 1)) * Math.PI;
    points.push(vec2(centerX + Math.cos(ang) * r, centerY + Math.sin(ang) * r));
  }
  points.push(vec2(bilgeX, bilgeY));
  points.push(vec2(halfBeam, freeboard));
  return points;
}

/** Flat-bottom barge / houseboat rectangular section. */
function boxSection(beam: number, draft: number, freeboard: number): Vec2[] {
  const halfBeam = beam * 0.5;
  return [
    vec2(-halfBeam, freeboard),
    vec2(-halfBeam, -draft),
    vec2(halfBeam, -draft),
    vec2(halfBeam, freeboard),
  ];
}

/** Closed circular / elliptical pontoon section. */
function pontoonSection(radius: number, n: number = 12): Vec2[] {
  const points: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2;
    points.push(vec2(Math.cos(ang) * radius, Math.sin(ang) * radius));
  }
  return points;
}

/** Taper factor for bow/stern. 0 = full section, 1 = point. */
function endTaper(t: number, start: number, end: number, taperLen: number): number {
  const total = Math.abs(end - start);
  if (total <= 0) return 1;
  const distToStart = Math.abs(t - 0);
  const distToEnd = Math.abs(t - 1);
  const d = Math.min(distToStart, distToEnd);
  if (d >= taperLen) return 1;
  return Math.max(0.03, d / taperLen);
}

function baseMetadata(name: string, boatClass: BoatClass, description: string): BoatDesignMetadata {
  const now = Date.now();
  return {
    id: generateDesignId(name, now),
    schemaVersion: "1.0.0",
    name,
    description,
    class: boatClass,
    immutable: true,
    createdAt: now,
    updatedAt: now,
  };
}

function createDefaultHelm(z: number, y: number): Hardpoint {
  return { id: "helm", type: "helm", position: vec3(0, y, z), rotation: identityQuat, label: "Helm" };
}

function createDeckRect(
  id: string,
  height: number,
  length: number,
  beam: number,
  zOffset: number = 0,
): DeckLevel {
  const halfL = length * 0.5;
  const halfB = beam * 0.5;
  return {
    id,
    height,
    outline: [
      vec2(-halfB + zOffset * 0, -halfL + zOffset),
      vec2(halfB, -halfL + zOffset),
      vec2(halfB, halfL + zOffset),
      vec2(-halfB, halfL + zOffset),
    ],
    thickness: 0.15,
    material: "wood",
  };
}

// ----------------------------------------------------------------------------
// 1. Pontoon starter — small twin-pontoon with bridge deck
// ----------------------------------------------------------------------------
export function createPontoonDesign(): BoatDesign {
  const length = 12;
  const radius = 0.5;
  const hullSpacing = 1.6; // center-to-center of pontoons
  const pontoonTopY = radius;
  const deckHeight = pontoonTopY + 0.18; // clearance above pontoon tops
  const deckHalfBeam = hullSpacing * 0.5 + radius + 0.05; // slight overhang past pontoons
  const deckHalfLength = length * 0.5 - 0.1; // covers nearly full pontoon length

  const makePontoon = (xOffset: number, id: string): HullBody => ({
    id,
    position: vec3(xOffset, 0, 0),
    rotation: identityQuat,
    isWatertight: true,
    material: "aluminum",
    stations: stationRange(-length * 0.5, length * 0.5, 11, (z, t) => {
      const end = endTaper(t, -length * 0.5, length * 0.5, 0.14);
      return pontoonSection(radius * end, 12);
    }),
  });

  return {
    metadata: baseMetadata(
      "Pontoon",
      BoatClass.Pontoon,
      "Compact twin-pontoon starter — open deck, perfect for fishing",
    ),
    hullBodies: [makePontoon(-hullSpacing * 0.5, "pontoon-port"), makePontoon(hullSpacing * 0.5, "pontoon-starboard")],
    decks: [
      {
        id: "bridge-deck",
        height: deckHeight,
        outline: [
          vec2(-deckHalfBeam, -deckHalfLength),
          vec2(deckHalfBeam, -deckHalfLength),
          vec2(deckHalfBeam, deckHalfLength),
          vec2(-deckHalfBeam, deckHalfLength),
        ],
        thickness: 0.06,
        material: "wood",
      },
    ],
    hardpoints: [createDefaultHelm(1.0, deckHeight + 0.9)],
    modules: [],
    symmetry: SymmetryMode.PortStarboard,
  };
}

// ----------------------------------------------------------------------------
// 2. Monohull yacht — classic round-bilge cruiser
// ----------------------------------------------------------------------------
export function createMonohullDesign(): BoatDesign {
  const length = 14;
  const beam = 4.0;
  const draft = 1.2;
  const freeboard = 1.3;
  const stationCount = 11;

  const generator = (z: number, t: number): Vec2[] => {
    // Bow at t=0, stern at t=1
    const taper = endTaper(t, 0, 1, 0.2);
    const beamNow = beam * taper;
    const draftNow = draft * (0.25 + 0.75 * taper); // keel stays deeper near bow
    const freeboardNow = freeboard * Math.max(0.1, taper);
    return vSection(beamNow, draftNow, freeboardNow);
  };

  return {
    metadata: baseMetadata(
      "Monohull Yacht",
      BoatClass.MonohullYacht,
      "Classic round-bilge cruising yacht with generous freeboard and a single helm",
    ),
    hullBodies: [
      {
        id: "main-hull",
        position: vec3(0, 0, 0),
        rotation: identityQuat,
        isWatertight: true,
        material: "fiberglass",
        stations: stationRange(-length * 0.5, length * 0.5, stationCount, generator),
      },
    ],
    decks: [
      {
        id: "foredeck",
        height: freeboard,
        outline: [
          vec2(-beam * 0.4, -length * 0.45),
          vec2(beam * 0.4, -length * 0.45),
          vec2(beam * 0.45, -length * 0.05),
          vec2(-beam * 0.45, -length * 0.05),
        ],
        thickness: 0.12,
        material: "wood",
      },
      {
        id: "aft-deck",
        height: freeboard,
        outline: [
          vec2(-beam * 0.45, -length * 0.05),
          vec2(beam * 0.45, -length * 0.05),
          vec2(beam * 0.45, length * 0.48),
          vec2(-beam * 0.45, length * 0.48),
        ],
        thickness: 0.12,
        material: "wood",
      },
    ],
    hardpoints: [createDefaultHelm(length * 0.35, freeboard + 1.5)],
    modules: [],
    symmetry: SymmetryMode.PortStarboard,
  };
}

// ----------------------------------------------------------------------------
// 3. Catamaran — narrow hulls connected by a wide bridgedeck
// ----------------------------------------------------------------------------
export function createCatamaranDesign(): BoatDesign {
  const length = 16;
  const beam = 6.5;
  const hullHalfBeam = 0.95;
  const spacing = beam * 0.5 - hullHalfBeam; // hull center X
  const draft = 1.0;
  const freeboard = 1.5;
  const bridgeHeight = 1.4;

  const makeHull = (xOffset: number, id: string): HullBody => ({
    id,
    position: vec3(xOffset, 0, 0),
    rotation: identityQuat,
    isWatertight: true,
    material: "fiberglass",
    stations: stationRange(-length * 0.5, length * 0.5, 13, (z, t) => {
      const taper = endTaper(t, 0, 1, 0.16);
      const beamNow = hullHalfBeam * 2 * taper;
      const draftNow = draft * (0.3 + 0.7 * taper);
      const freeboardNow = freeboard * Math.max(0.1, taper);
      return vSection(beamNow, draftNow, freeboardNow);
    }),
  });

  return {
    metadata: baseMetadata(
      "Catamaran",
      BoatClass.Catamaran,
      "Twin narrow hulls with a wide bridgedeck — stable, fast, and spacious",
    ),
    hullBodies: [makeHull(-spacing, "hull-port"), makeHull(spacing, "hull-starboard")],
    decks: [
      {
        id: "bridgedeck",
        height: bridgeHeight,
        outline: [
          vec2(-beam * 0.48, -length * 0.45),
          vec2(beam * 0.48, -length * 0.45),
          vec2(beam * 0.48, length * 0.42),
          vec2(-beam * 0.48, length * 0.42),
        ],
        thickness: 0.15,
        material: "wood",
      },
    ],
    hardpoints: [createDefaultHelm(0.2, bridgeHeight + 1.6)],
    modules: [],
    symmetry: SymmetryMode.PortStarboard,
  };
}

// ----------------------------------------------------------------------------
// 4. Houseboat — flat-bottomed box hull with raised cabin
// ----------------------------------------------------------------------------
export function createHouseboatDesign(): BoatDesign {
  const length = 13;
  const beam = 4.8;
  const draft = 0.7;
  const freeboard = 0.9;
  const deckHeight = freeboard;
  const cabinHeight = 2.4;
  const cabinLength = 7.0;
  const cabinBeam = 3.6;

  const hull: HullBody = {
    id: "lower-hull",
    position: vec3(0, 0, 0),
    rotation: identityQuat,
    isWatertight: true,
    material: "steel",
    stations: stationRange(-length * 0.5, length * 0.5, 9, () =>
      boxSection(beam, draft, freeboard),
    ),
  };

  // Cabin treated as non-watertight superstructure
  const cabinStations: HullStation[] = [];
  const cabinZStart = -cabinLength * 0.5;
  const cabinZEnd = cabinLength * 0.5;
  const halfCB = cabinBeam * 0.5;
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    const z = lerp(cabinZStart, cabinZEnd, t);
    cabinStations.push({
      z,
      points: [vec2(-halfCB, 0), vec2(-halfCB, cabinHeight), vec2(halfCB, cabinHeight), vec2(halfCB, 0)],
    });
  }
  const cabin: HullBody = {
    id: "cabin",
    position: vec3(0, deckHeight, 0),
    rotation: identityQuat,
    isWatertight: false,
    material: "fiberglass",
    stations: cabinStations,
  };

  return {
    metadata: baseMetadata(
      "Houseboat",
      BoatClass.Houseboat,
      "Flat-bottomed liveaboard with enclosed cabin and open aft deck",
    ),
    hullBodies: [hull, cabin],
    decks: [
      {
        id: "roof-deck",
        height: deckHeight + cabinHeight,
        outline: [
          vec2(-cabinBeam * 0.52, cabinZStart - 0.2),
          vec2(cabinBeam * 0.52, cabinZStart - 0.2),
          vec2(cabinBeam * 0.52, cabinZEnd + 0.2),
          vec2(-cabinBeam * 0.52, cabinZEnd + 0.2),
        ],
        thickness: 0.12,
        material: "wood",
      },
      {
        id: "aft-deck",
        height: deckHeight,
        outline: [
          vec2(-beam * 0.48, cabinZEnd),
          vec2(beam * 0.48, cabinZEnd),
          vec2(beam * 0.48, length * 0.45),
          vec2(-beam * 0.48, length * 0.45),
        ],
        thickness: 0.12,
        material: "wood",
      },
    ],
    hardpoints: [createDefaultHelm(length * 0.25, deckHeight + 1.3)],
    modules: [],
    symmetry: SymmetryMode.PortStarboard,
  };
}

// ----------------------------------------------------------------------------
// 5. Barge — large, simple cargo box hull
// ----------------------------------------------------------------------------
export function createBargeDesign(): BoatDesign {
  const length = 22;
  const beam = 6.2;
  const draft = 1.5;
  const freeboard = 1.8;

  return {
    metadata: baseMetadata(
      "Barge",
      BoatClass.Barge,
      "Large rectangular cargo barge with massive capacity and shallow draft",
    ),
    hullBodies: [
      {
        id: "cargo-hull",
        position: vec3(0, 0, 0),
        rotation: identityQuat,
        isWatertight: true,
        material: "steel",
        stations: stationRange(-length * 0.5, length * 0.5, 9, () => boxSection(beam, draft, freeboard)),
      },
    ],
    decks: [
      {
        id: "cargo-deck",
        height: freeboard,
        outline: [
          vec2(-beam * 0.48, -length * 0.48),
          vec2(beam * 0.48, -length * 0.48),
          vec2(beam * 0.48, length * 0.48),
          vec2(-beam * 0.48, length * 0.48),
        ],
        thickness: 0.2,
        material: "steel",
      },
    ],
    hardpoints: [
      createDefaultHelm(length * 0.35, freeboard + 1.2),
      { id: "crane", type: "crane", position: vec3(0, freeboard, -length * 0.2), rotation: identityQuat, label: "Crane" },
    ],
    modules: [],
    symmetry: SymmetryMode.PortStarboard,
  };
}

// ----------------------------------------------------------------------------
// Preset registry
// ----------------------------------------------------------------------------

export const BOAT_DESIGN_PRESETS: Record<string, () => BoatDesign> = {
  pontoon: createPontoonDesign,
  monohull: createMonohullDesign,
  catamaran: createCatamaranDesign,
  houseboat: createHouseboatDesign,
  barge: createBargeDesign,
};

export const BOAT_DESIGN_PRESET_LIST = Object.values(BOAT_DESIGN_PRESETS);

export const BOAT_STARTER_PRESET = "pontoon";
