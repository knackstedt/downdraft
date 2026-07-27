// ============================================================================
// PortMeshGenerator — procedural mesh generation for port entities
// Produces vertex/index arrays in the same format as boat/island meshes:
// 9 floats per vertex: [px, py, pz, nx, ny, nz, r, g, b]
// ============================================================================

import { PortSize, PortTheme, PortService, BiomeType } from "../../../shared/types";
import { PORT_DIMENSIONS } from "../../../shared/constants";

export interface PortMeshParams {
  size: PortSize;
  theme: PortTheme;
  services: PortService[];
  seed: number; // for deterministic variation
  biome: BiomeType; // biome-specific geometry variation
}

export interface GeneratedMesh {
  vertices: number[];   // 8 floats per vertex
  indices: number[];    // triangle indices
}

// --- Theme color palettes ---

interface ThemePalette {
  wood: [number, number, number];
  roof: [number, number, number];
  stone: [number, number, number];
  metal: [number, number, number];
  accent: [number, number, number];
}

function getThemePalette(theme: PortTheme): ThemePalette {
  switch (theme) {
    case PortTheme.Tropical:
      return { wood: [0.62, 0.47, 0.30], roof: [0.80, 0.45, 0.25], stone: [0.55, 0.50, 0.40], metal: [0.40, 0.38, 0.35], accent: [0.90, 0.70, 0.30] };
    case PortTheme.Industrial:
      return { wood: [0.35, 0.30, 0.25], roof: [0.25, 0.25, 0.28], stone: [0.42, 0.42, 0.45], metal: [0.30, 0.32, 0.38], accent: [0.60, 0.50, 0.20] };
    case PortTheme.Pirate:
      return { wood: [0.28, 0.18, 0.12], roof: [0.20, 0.14, 0.08], stone: [0.35, 0.30, 0.25], metal: [0.22, 0.18, 0.15], accent: [0.50, 0.35, 0.15] };
    case PortTheme.Mafia:
      return { wood: [0.40, 0.35, 0.30], roof: [0.30, 0.25, 0.20], stone: [0.45, 0.42, 0.38], metal: [0.30, 0.28, 0.25], accent: [0.70, 0.55, 0.20] };
    case PortTheme.Arctic:
      return { wood: [0.50, 0.45, 0.38], roof: [0.70, 0.75, 0.85], stone: [0.55, 0.58, 0.62], metal: [0.35, 0.38, 0.42], accent: [0.60, 0.70, 0.90] };
    case PortTheme.Volcanic:
      return { wood: [0.25, 0.18, 0.15], roof: [0.35, 0.18, 0.10], stone: [0.30, 0.25, 0.22], metal: [0.25, 0.20, 0.18], accent: [0.80, 0.30, 0.10] };
    case PortTheme.Ghost:
      return { wood: [0.30, 0.28, 0.32], roof: [0.20, 0.18, 0.25], stone: [0.35, 0.33, 0.38], metal: [0.25, 0.23, 0.28], accent: [0.50, 0.45, 0.70] };
    case PortTheme.Military:
      return { wood: [0.30, 0.32, 0.28], roof: [0.20, 0.25, 0.20], stone: [0.40, 0.42, 0.38], metal: [0.28, 0.30, 0.28], accent: [0.50, 0.55, 0.45] };
    case PortTheme.Research:
      return { wood: [0.45, 0.45, 0.48], roof: [0.35, 0.38, 0.42], stone: [0.50, 0.52, 0.55], metal: [0.40, 0.42, 0.45], accent: [0.50, 0.60, 0.80] };
    case PortTheme.Resort:
      return { wood: [0.60, 0.50, 0.35], roof: [0.75, 0.55, 0.30], stone: [0.55, 0.52, 0.45], metal: [0.40, 0.38, 0.35], accent: [0.85, 0.75, 0.40] };
    case PortTheme.Trading:
      return { wood: [0.50, 0.40, 0.28], roof: [0.55, 0.40, 0.25], stone: [0.52, 0.50, 0.46], metal: [0.36, 0.35, 0.33], accent: [0.70, 0.55, 0.25] };
    case PortTheme.Salvage:
      return { wood: [0.32, 0.25, 0.18], roof: [0.25, 0.20, 0.15], stone: [0.38, 0.35, 0.30], metal: [0.28, 0.25, 0.22], accent: [0.55, 0.40, 0.18] };
    case PortTheme.Fishing:
      return { wood: [0.55, 0.42, 0.28], roof: [0.65, 0.40, 0.22], stone: [0.50, 0.48, 0.42], metal: [0.38, 0.36, 0.33], accent: [0.75, 0.55, 0.25] };
    default:
      return { wood: [0.55, 0.40, 0.25], roof: [0.50, 0.35, 0.20], stone: [0.50, 0.50, 0.52], metal: [0.35, 0.35, 0.38], accent: [0.60, 0.50, 0.30] };
  }
}

// --- Port dimensions by size ---

interface PortDimensions {
  dockWidth: number;
  dockDepth: number;
  dockHeight: number;
  pierWidth: number;
  pierLength: number;
  pierHeight: number;
  buildingCount: number;
  craneCount: number;
  hasLighthouse: boolean;
  hasBreakwater: boolean;
  mooringPostCount: number;
}

function getDimensions(size: PortSize): PortDimensions {
  const d = PORT_DIMENSIONS[size];
  // Additional visual-only properties not in shared constants
  const extras = {
    [PortSize.Small]: { buildingCount: 2, craneCount: 0, hasLighthouse: false, hasBreakwater: false, mooringPostCount: 4 },
    [PortSize.Medium]: { buildingCount: 3, craneCount: 1, hasLighthouse: false, hasBreakwater: false, mooringPostCount: 6 },
    [PortSize.Large]: { buildingCount: 4, craneCount: 2, hasLighthouse: true, hasBreakwater: true, mooringPostCount: 8 },
  };
  const e = extras[size];
  return {
    dockWidth: d.dockWidth, dockDepth: d.dockDepth, dockHeight: d.dockHeight,
    pierWidth: d.pierWidth, pierLength: d.pierLength, pierHeight: d.pierHeight,
    buildingCount: e.buildingCount, craneCount: e.craneCount,
    hasLighthouse: e.hasLighthouse, hasBreakwater: e.hasBreakwater,
    mooringPostCount: e.mooringPostCount,
  };
}

// --- Simple seeded RNG ---

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Mesh builder helper ---

class MeshBuilder {
  vertices: number[] = [];
  indices: number[] = [];
  private vertCount = 0;

  addBox(
    cx: number, cy: number, cz: number,
    hw: number, hh: number, hd: number,
    color: [number, number, number],
  ): void {
    const [r, g, b] = color;
    const x0 = cx - hw, x1 = cx + hw;
    const y0 = cy - hh, y1 = cy + hh;
    const z0 = cz - hd, z1 = cz + hd;
    const vi = this.vertCount;

    // 8 corner vertices
    const corners = [
      [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], // front
      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], // back
    ];

    // Faces: [v0, v1, v2, v3, normal]
    const faces: number[][] = [
      [0, 1, 2, 3, 0, 0, -1], // front  (-z)
      [5, 4, 7, 6, 0, 0, 1],  // back   (+z)
      [4, 0, 3, 7, -1, 0, 0], // left   (-x)
      [1, 5, 6, 2, 1, 0, 0],  // right  (+x)
      [3, 2, 6, 7, 0, 1, 0],  // top    (+y)
      [4, 5, 1, 0, 0, -1, 0], // bottom (-y)
    ];

    for (let f = 0; f < faces.length; f++) {
      const face = faces[f];
      const [i0, i1, i2, i3, nx, ny, nz] = face;
      const c0 = corners[i0], c1 = corners[i1], c2 = corners[i2], c3 = corners[i3];
      this.vertices.push(
        c0[0], c0[1], c0[2], nx, ny, nz, r, g, b,
        c1[0], c1[1], c1[2], nx, ny, nz, r, g, b,
        c2[0], c2[1], c2[2], nx, ny, nz, r, g, b,
        c3[0], c3[1], c3[2], nx, ny, nz, r, g, b,
      );
      const base = vi + f * 4;
      this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }

    this.vertCount += 24;
  }

  addCylinder(
    cx: number, cy: number, cz: number,
    radius: number, height: number, segments: number,
    color: [number, number, number],
  ): void {
    const [r, g, b] = color;
    const y0 = cy - height / 2;
    const y1 = cy + height / 2;
    const vi = this.vertCount;

    // Side vertices (top and bottom rings)
    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      const x = cx + Math.cos(angle) * radius;
      const z = cz + Math.sin(angle) * radius;
      const nx = Math.cos(angle);
      const nz = Math.sin(angle);
      // bottom
      this.vertices.push(x, y0, z, nx, 0, nz, r, g, b);
      // top
      this.vertices.push(x, y1, z, nx, 0, nz, r, g, b);
    }

    for (let i = 0; i < segments; i++) {
      const ni = (i + 1) % segments;
      const b0 = vi + i * 2;
      const b1 = vi + i * 2 + 1;
      const b2 = vi + ni * 2 + 1;
      const b3 = vi + ni * 2;
      this.indices.push(b0, b1, b2, b0, b2, b3);
    }

    this.vertCount += segments * 2;

    // Cap: top
    const capVi = this.vertCount;
    this.vertices.push(cx, y1, cz, 0, 1, 0, r, g, b);
    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      const x = cx + Math.cos(angle) * radius;
      const z = cz + Math.sin(angle) * radius;
      this.vertices.push(x, y1, z, 0, 1, 0, r, g, b);
    }
    for (let i = 0; i < segments; i++) {
      const ni = (i + 1) % segments;
      this.indices.push(capVi, capVi + 1 + i, capVi + 1 + ni);
    }
    this.vertCount += 1 + segments;

    // Cap: bottom
    const capBotVi = this.vertCount;
    this.vertices.push(cx, y0, cz, 0, -1, 0, r, g, b);
    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      const x = cx + Math.cos(angle) * radius;
      const z = cz + Math.sin(angle) * radius;
      this.vertices.push(x, y0, z, 0, -1, 0, r, g, b);
    }
    for (let i = 0; i < segments; i++) {
      const ni = (i + 1) % segments;
      this.indices.push(capBotVi, capBotVi + 1 + ni, capBotVi + 1 + i);
    }
    this.vertCount += 1 + segments;
  }

  addCone(
    cx: number, cy: number, cz: number,
    radius: number, height: number, segments: number,
    color: [number, number, number],
  ): void {
    const [r, g, b] = color;
    const y0 = cy;
    const y1 = cy + height;
    const vi = this.vertCount;

    // Bottom ring
    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      const x = cx + Math.cos(angle) * radius;
      const z = cz + Math.sin(angle) * radius;
      this.vertices.push(x, y0, z, 0, -1, 0, r, g, b);
    }

    // Apex
    const apexVi = vi + segments;
    this.vertices.push(cx, y1, cz, 0, 1, 0, r, g, b);

    // Side faces
    for (let i = 0; i < segments; i++) {
      const ni = (i + 1) % segments;
      // Approximate normal pointing outward
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = (ni / segments) * Math.PI * 2;
      const nx = (Math.cos(a0) + Math.cos(a1)) * 0.5;
      const nz = (Math.sin(a0) + Math.sin(a1)) * 0.5;
      // We can't easily set per-face normals with shared vertices,
      // so just use the approximate outward direction
      this.indices.push(vi + i, apexVi, vi + ni);
    }

    // Bottom cap
    const capVi = this.vertCount;
    this.vertices.push(cx, y0, cz, 0, -1, 0, r, g, b);
    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      const x = cx + Math.cos(angle) * radius;
      const z = cz + Math.sin(angle) * radius;
      this.vertices.push(x, y0, z, 0, -1, 0, r, g, b);
    }
    for (let i = 0; i < segments; i++) {
      const ni = (i + 1) % segments;
      this.indices.push(capVi, capVi + 1 + ni, capVi + 1 + i);
    }

    this.vertCount += (segments + 1) + (1 + segments);
  }

  addQuad(
    p0: [number, number, number], p1: [number, number, number],
    p2: [number, number, number], p3: [number, number, number],
    normal: [number, number, number],
    color: [number, number, number],
  ): void {
    const [nx, ny, nz] = normal;
    const [r, g, b] = color;
    const vi = this.vertCount;
    this.vertices.push(
      p0[0], p0[1], p0[2], nx, ny, nz, r, g, b,
      p1[0], p1[1], p1[2], nx, ny, nz, r, g, b,
      p2[0], p2[1], p2[2], nx, ny, nz, r, g, b,
      p3[0], p3[1], p3[2], nx, ny, nz, r, g, b,
    );
    this.indices.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
    this.vertCount += 4;
  }

  getMesh(): GeneratedMesh {
    return { vertices: this.vertices, indices: this.indices };
  }
}

// --- Main generator ---

// --- Biome-specific geometry modifiers ---

interface BiomeGeometryMods {
  dockMaterial: [number, number, number];  // override dock surface color
  buildingHeightMul: number;               // multiply building height
  buildingWidthMul: number;                // multiply building width
  hasIceBlocks: boolean;                   // Arctic: ice blocks around dock
  hasPalmRoofs: boolean;                   // Tropical: sloped palm roofs
  hasVolcanicRocks: boolean;               // Volcanic: black rock formations
  hasSandbagWalls: boolean;                // Desert: sandbag defensive walls
  extraDockDetail: number;                 // 0-2: level of dock detail
}

function getBiomeMods(biome: BiomeType): BiomeGeometryMods {
  switch (biome) {
    case BiomeType.Arctic:
      return {
        dockMaterial: [0.70, 0.75, 0.82],
        buildingHeightMul: 0.7,  // shorter buildings (snow load)
        buildingWidthMul: 1.2,   // wider, stockier
        hasIceBlocks: true,
        hasPalmRoofs: false,
        hasVolcanicRocks: false,
        hasSandbagWalls: false,
        extraDockDetail: 1,
      };
    case BiomeType.Desert:
      return {
        dockMaterial: [0.65, 0.55, 0.38],
        buildingHeightMul: 0.8,
        buildingWidthMul: 1.1,
        hasIceBlocks: false,
        hasPalmRoofs: false,
        hasVolcanicRocks: false,
        hasSandbagWalls: true,
        extraDockDetail: 0,
      };
    case BiomeType.Tropical:
    case BiomeType.SubTropical:
    case BiomeType.CoralReef:
      return {
        dockMaterial: [0.55, 0.42, 0.28],
        buildingHeightMul: 1.1,  // taller, airy buildings
        buildingWidthMul: 0.9,   // narrower
        hasIceBlocks: false,
        hasPalmRoofs: true,
        hasVolcanicRocks: false,
        hasSandbagWalls: false,
        extraDockDetail: 2,
      };
    case BiomeType.Volcanic:
    case BiomeType.Hell:
      return {
        dockMaterial: [0.25, 0.20, 0.18],
        buildingHeightMul: 1.0,
        buildingWidthMul: 1.0,
        hasIceBlocks: false,
        hasPalmRoofs: false,
        hasVolcanicRocks: true,
        hasSandbagWalls: false,
        extraDockDetail: 0,
      };
    case BiomeType.BorealForest:
      return {
        dockMaterial: [0.40, 0.35, 0.28],
        buildingHeightMul: 0.9,
        buildingWidthMul: 1.15,
        hasIceBlocks: false,
        hasPalmRoofs: false,
        hasVolcanicRocks: false,
        hasSandbagWalls: false,
        extraDockDetail: 1,
      };
    default:
      return {
        dockMaterial: [0.50, 0.50, 0.52],
        buildingHeightMul: 1.0,
        buildingWidthMul: 1.0,
        hasIceBlocks: false,
        hasPalmRoofs: false,
        hasVolcanicRocks: false,
        hasSandbagWalls: false,
        extraDockDetail: 0,
      };
  }
}

export function generatePortMesh(params: PortMeshParams): GeneratedMesh {
  const dims = getDimensions(params.size);
  const palette = getThemePalette(params.theme);
  const mods = getBiomeMods(params.biome);
  const rng = mulberry32(params.seed);
  const mb = new MeshBuilder();

  const { dockWidth: dw, dockDepth: dd, dockHeight: dh } = dims;
  const halfDW = dw / 2;
  const halfDD = dd / 2;

  // 1. Main dock platform (biome-specific material)
  mb.addBox(0, dh / 2, 0, halfDW, dh / 2, halfDD, mods.dockMaterial);

  // 2. Pier (extends in -z direction from dock front edge)
  const pierZ = -halfDD - dims.pierLength / 2;
  mb.addBox(0, dims.pierHeight / 2, pierZ, dims.pierWidth / 2, dims.pierHeight / 2, dims.pierLength / 2, palette.wood);

  // 3. Buildings on back of dock (+z side)
  const buildingAreaDepth = dd * 0.45;
  const buildingZStart = halfDD - buildingAreaDepth;
  const buildingZCenter = (halfDD + buildingZStart) / 2;

  for (let i = 0; i < dims.buildingCount; i++) {
    const slotWidth = dw / dims.buildingCount;
    const bx = -halfDW + slotWidth * (i + 0.5);
    const bw = slotWidth * 0.7 * mods.buildingWidthMul;
    const bd = buildingAreaDepth * 0.75;
    const bh = (3 + rng() * 5) * mods.buildingHeightMul;
    const by = dh + bh / 2;
    mb.addBox(bx, by, buildingZCenter, bw / 2, bh / 2, bd / 2, palette.wood);

    // Roof — biome-specific style
    if (mods.hasPalmRoofs) {
      // Tropical: sloped cone roof (thatched look)
      mb.addCone(bx, dh + bh, buildingZCenter, bw / 2 + 0.5, 2.5, 8, palette.roof);
    } else {
      // Default: flat roof
      mb.addBox(bx, dh + bh + 0.3, buildingZCenter, bw / 2 + 0.3, 0.3, bd / 2 + 0.3, palette.roof);
    }
  }

  // 3b. Biome-specific dock features
  if (mods.hasIceBlocks) {
    // Arctic: ice blocks scattered around dock perimeter
    const iceColor: [number, number, number] = [0.80, 0.85, 0.92];
    const iceCount = 6;
    for (let i = 0; i < iceCount; i++) {
      const angle = (i / iceCount) * Math.PI * 2;
      const ix = Math.cos(angle) * (halfDW + 2 + rng() * 3);
      const iz = Math.sin(angle) * (halfDD + 2 + rng() * 3);
      const ih = 1.5 + rng() * 2;
      mb.addBox(ix, ih / 2, iz, 1.0 + rng(), ih / 2, 1.0 + rng(), iceColor);
    }
  }

  if (mods.hasVolcanicRocks) {
    // Volcanic: black jagged rock formations near dock
    const rockColor: [number, number, number] = [0.15, 0.12, 0.10];
    const rockCount = 4;
    for (let i = 0; i < rockCount; i++) {
      const angle = (i / rockCount) * Math.PI * 2 + 0.5;
      const rx = Math.cos(angle) * (halfDW + 1 + rng() * 2);
      const rz = Math.sin(angle) * (halfDD + 1 + rng() * 2);
      const rh = 2 + rng() * 3;
      mb.addCone(rx, 0, rz, 1.5 + rng(), rh, 6, rockColor);
    }
  }

  if (mods.hasSandbagWalls) {
    // Desert: sandbag defensive walls along dock sides
    const sandColor: [number, number, number] = [0.70, 0.58, 0.35];
    const wallH = 1.2;
    const wallY = dh + wallH / 2;
    // Left wall
    mb.addBox(-halfDW - 0.5, wallY, 0, 0.5, wallH / 2, halfDD * 0.7, sandColor);
    // Right wall
    mb.addBox(halfDW + 0.5, wallY, 0, 0.5, wallH / 2, halfDD * 0.7, sandColor);
  }

  if (mods.extraDockDetail >= 1) {
    // Dock surface planks (visual lines on dock top)
    const plankColor: [number, number, number] = [
      mods.dockMaterial[0] * 0.85,
      mods.dockMaterial[1] * 0.85,
      mods.dockMaterial[2] * 0.85,
    ];
    const plankCount = Math.floor(dw / 4);
    for (let i = 0; i < plankCount; i++) {
      const px = -halfDW + (i + 0.5) * (dw / plankCount);
      mb.addBox(px, dh + 0.05, 0, 0.1, 0.05, halfDD * 0.9, plankColor);
    }
  }

  if (mods.extraDockDetail >= 2) {
    // Tropical: decorative posts with round tops
    const postCount = 4;
    for (let i = 0; i < postCount; i++) {
      const px = -halfDW + (i + 0.5) * (dw / postCount);
      mb.addCylinder(px, dh + 1.5, halfDD - 1, 0.2, 3, 8, palette.wood);
    }
  }

  // 4. Cranes (along dock edge, -z side of buildings)
  for (let i = 0; i < dims.craneCount; i++) {
    const cx = -halfDW * 0.5 + (dw * 0.5) * (i / Math.max(1, dims.craneCount - 1));
    const cy = dh;
    const cz = 0;

    // Tower
    const towerH = 10 + rng() * 5;
    mb.addBox(cx, cy + towerH / 2, cz, 0.6, towerH / 2, 0.6, palette.metal);

    // Horizontal arm
    const armLen = 6 + rng() * 4;
    mb.addBox(cx + armLen / 2, cy + towerH - 0.5, cz, armLen / 2, 0.4, 0.4, palette.metal);

    // Counterweight
    mb.addBox(cx - 1.5, cy + towerH - 0.5, cz, 1.0, 0.8, 0.8, palette.metal);

    // Cable hanging from arm end
    const cableX = cx + armLen;
    mb.addBox(cableX, cy + towerH - 3, cz, 0.08, 2.5, 0.08, palette.metal);
    // Hook block
    mb.addBox(cableX, cy + towerH - 6, cz, 0.3, 0.3, 0.3, palette.accent);
  }

  // 5. Lighthouse (large ports only)
  if (dims.hasLighthouse) {
    const lhX = 0;
    const lhZ = pierZ - dims.pierLength / 2 - 3;
    const lhBaseY = dims.pierHeight;

    // Tower
    mb.addCylinder(lhX, lhBaseY + 10, lhZ, 2.0, 20, 12, palette.stone);

    // Light room
    mb.addBox(lhX, lhBaseY + 22, lhZ, 1.8, 1.5, 1.8, palette.accent);

    // Cone roof
    mb.addCone(lhX, lhBaseY + 23.5, lhZ, 2.2, 3, 12, palette.roof);
  }

  // 6. Mooring posts along pier sides
  for (let i = 0; i < dims.mooringPostCount; i++) {
    const t = (i + 0.5) / dims.mooringPostCount;
    const pz = pierZ - dims.pierLength / 2 + t * dims.pierLength;
    const offset = dims.pierWidth / 2 + 0.3;

    // Left post
    mb.addCylinder(-offset, dims.pierHeight + 0.75, pz, 0.25, 1.5, 8, palette.wood);
    // Right post
    mb.addCylinder(offset, dims.pierHeight + 0.75, pz, 0.25, 1.5, 8, palette.wood);
  }

  // 7. Breakwater (large ports only) — row of blocks in front of pier
  if (dims.hasBreakwater) {
    const bwZ = pierZ - dims.pierLength / 2 - 6;
    const bwCount = 7;
    const bwSpacing = dw / bwCount;
    for (let i = 0; i < bwCount; i++) {
      const bx = -halfDW + bwSpacing * (i + 0.5);
      const bh = 2 + rng() * 1.5;
      mb.addBox(bx, bh / 2, bwZ, bwSpacing * 0.35, bh / 2, 1.5, palette.stone);
    }
  }

  // 8. Dock edge trim (visual accent along dock perimeter)
  const trimH = 0.3;
  const trimY = dh + trimH / 2;
  // Front edge (facing pier, -z side)
  mb.addBox(0, trimY, -halfDD, halfDW + 0.2, trimH / 2, 0.3, palette.accent);
  // Back edge (+z side)
  mb.addBox(0, trimY, halfDD, halfDW + 0.2, trimH / 2, 0.3, palette.accent);
  // Left edge
  mb.addBox(-halfDW, trimY, 0, 0.3, trimH / 2, halfDD, palette.accent);
  // Right edge
  mb.addBox(halfDW, trimY, 0, 0.3, trimH / 2, halfDD, palette.accent);

  // 9. Ramp connecting dock to pier (fills the gap)
  const rampLen = halfDD - (halfDD + pierZ - dims.pierLength / 2) + dims.pierLength / 2;
  // Actually the pier starts at -halfDD and extends to -halfDD - pierLength
  // The dock front is at z = -halfDD, pier back is at z = -halfDD
  // They connect directly, so we just need a small transition piece
  const rampZ = -halfDD;
  const rampH = (dh + dims.pierHeight) / 2;
  mb.addBox(0, rampH, rampZ - 0.5, dims.pierWidth / 2, Math.abs(dh - dims.pierHeight) / 2 + 0.3, 0.5, palette.wood);

  return mb.getMesh();
}
