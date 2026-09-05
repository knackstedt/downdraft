// ============================================================================
// Grid-builder worker — offloads instance data + texture padding from the
// render thread to a dedicated Web Worker.
//
// The worker polls the sim SAB's tick. When it advances, the worker:
//   1. Reads foreground + background grids from the sim SAB
//   2. Builds instance data (4 layers: 2 fg + 2 bg) with neighbor face culling
//   3. Pads fg/bg block IDs into 256-byte-aligned rows for GPU textures
//   4. Pads light (RGBA8) + explored (R8) into 256-byte-aligned rows
//   5. Atomically publishes the build tick (release ordering)
//
// The renderer reads the pre-built data from the render SAB and uploads it
// directly to the GPU — no JS loops on the main thread.
// ============================================================================

import { usingRealSAB, type BufferSyncConfig } from "@downdraft/core";
import "@downdraft/core/sab/sab-polyfill";
import { expose } from "@downdraft/core/worker/rpc";
import {
    ACTIVE_GRID_H,
    ACTIVE_GRID_W,
    BLOCK_WATER,
    SLOPE_ELIGIBLE,
} from "../shared/constants";
import { CROP_LOOKUP } from "../shared/crops";
import {
    PADDED_EXPLORED_ROW_BYTES,
    PADDED_GRID_ROW_BYTES,
    PADDED_LIGHT_ROW_BYTES,
    RenderBufferWriter
} from "../shared/render-buffer";
import { SimBufferReader } from "../shared/sim-buffer";
import { isTreeBlock } from "../shared/tree-species";

// --- Face mask bits (must match block-grid-pass-3d.ts + shader) ---
const FACE_RIGHT  = 1 << 0; // +X
const FACE_LEFT   = 1 << 1; // -X
const FACE_BOTTOM = 1 << 2; // +Y
const FACE_TOP    = 1 << 3; // -Y
const FACE_FRONT  = 1 << 4; // +Z
const FACE_BACK   = 1 << 5; // -Z

// --- Corner mask bits (must match block-grid-pass-3d.ts + shader) ---
// Packed into bits 8-11 of the faceMask. Each bit indicates a 45° chamfer
// at that block corner (marching-squares slope VFX).
const CORNER_TL = 1 << 8;  // top-left corner (x=0, y=0)
const CORNER_TR = 1 << 9;  // top-right corner (x=1, y=0)
const CORNER_BL = 1 << 10; // bottom-left corner (x=0, y=1)
const CORNER_BR = 1 << 11; // bottom-right corner (x=1, y=1)

/** Compute the 4-bit corner mask for marching-squares slope VFX.
 *  A corner is cut (diagonal chamfer) only when its 2×2 cell neighborhood
 *  has EXACTLY 1 filled cell (this cell itself) — the contour then passes
 *  entirely within this one cell. The 3-filled case does NOT cut (the
 *  contour is split across cells as edge segments, not a corner cut).
 *
 *  Parameters are the "solid" state of the 8 neighbors (cardinal + diagonal),
 *  using whatever "solid" means for the calling layer (fg: !isAirOrCrop,
 *  bg wall: isWall, bg tree/terrain: isSolid). `self` is always filled. */
function computeCornerMask(
  nSolid: boolean, eSolid: boolean, sSolid: boolean, wSolid: boolean,
  nw: boolean, ne: boolean, sw: boolean, se: boolean,
): number {
  const self = 1; // this block is filled
  let mask = 0;
  // TL: nw, n, w, self — cut only if self is the sole filled cell
  if (((nw ? 1 : 0) + (nSolid ? 1 : 0) + (wSolid ? 1 : 0) + self) === 1) mask |= CORNER_TL;
  // TR: n, ne, self, e
  if (((nSolid ? 1 : 0) + (ne ? 1 : 0) + self + (eSolid ? 1 : 0)) === 1) mask |= CORNER_TR;
  // BL: w, self, sw, s
  if (((wSolid ? 1 : 0) + self + (sw ? 1 : 0) + (sSolid ? 1 : 0)) === 1) mask |= CORNER_BL;
  // BR: self, e, s, se
  if ((self + (eSolid ? 1 : 0) + (sSolid ? 1 : 0) + (se ? 1 : 0)) === 1) mask |= CORNER_BR;
  return mask;
}

// --- Depth layers (must match block-grid-pass-3d.ts) ---
const FG_Z_LAYERS = [0, -1];
const BG_Z_LAYERS = [-2, -3];
const NUM_FG_LAYERS = FG_Z_LAYERS.length;

const W = ACTIVE_GRID_W;
const H = ACTIVE_GRID_H;

/** A foreground neighbor is "transparent" for face-culling purposes if it's
 *  air OR a crop/wild forageable block (bushes, mushrooms, ...). Those are
 *  rendered as 2D sprites by CropSpritePass, not 3D cubes, so a solid block
 *  adjacent to one must show its face — otherwise the bush leaves a visual
 *  hole in the terrain surface that interrupts the light gradient. */
const isAirOrCrop = (id: number): boolean => id === 0 || CROP_LOOKUP[id] !== 0;

let simReader: SimBufferReader | null = null;
let renderWriter: RenderBufferWriter | null = null;
let lastBuiltTick = -1;
let running = false;
// SAB polyfill: buffer sync worker (only created when SAB is unavailable).
let syncWorker: { syncToMain: (regionNames?: string[]) => void; start: (onAfterReceive?: () => void) => void } | null = null;
// SAB polyfill: throttle render SAB sync. The render SAB is ~16MB; syncing it
// every build (30Hz) would copy ~500MB/s on mobile. Instead, sync the render
// header (32 bytes) every build so the renderer knows a new build exists, and
// sync the full render data every N builds. The renderer renders with stale
// data for a few frames between full syncs — acceptable for a block game.
let renderSyncCounter = 0;
const RENDER_SYNC_INTERVAL = 6; // sync textures every 6 builds (~375ms at 16 builds/s)

/** Build instance data + padded textures from the current sim SAB state. */
let buildProfTimer = 0;
const buildProfTimes: number[] = [];

function build(): void {
  if (!simReader || !renderWriter) return;

  const foreground = simReader.foreground;
  const background = simReader.background;
  const light = simReader.light;
  const explored = simReader.explored;
  const tick = simReader.getTick();
  if (tick === lastBuiltTick) return; // no new sim tick

  const buildStart = performance.now();
  const writer = renderWriter;
  const data = writer.instanceData;
  let idx = 0;

  // --- View culling bounds ---
  // Compute the visible rectangle in active-grid coordinates and only build
  // instances for cells within it. The full grid textures (fg/bg/light/
  // explored) are still padded and uploaded at full size — the shader samples
  // neighbors and light at arbitrary positions, so it needs the complete
  // textures. Only the instance data (vertex shader work + draw call count)
  // is culled.
  //
  // At default zoom (96), only ~20×11 blocks are visible but the active
  // grid is 448×448 — without culling, 99.9% of instances are off-screen.
  // The margin accounts for the 20° camera pitch, block faces extending
  // beyond their cell, and a small buffer to avoid edge popping.
  //
  // CULL CENTER: The renderer writes the camera WORLD position (origin-
  // independent) to the SAB. We convert it to sim-origin active-grid coords
  // using the sim SAB's own origin — this is always consistent with the grid
  // data we're reading, even during chunk-boundary crossings when the sim
  // origin has advanced but the render origin hasn't caught up yet. Using
  // the camera (not the blockhead) ensures detached-camera mode works: the
  // camera can be far from the player, and culling must follow the camera.
  const inpF = simReader.inputF32;
  const camZoom = inpF[15];
  const camCW = inpF[16];
  const camCH = inpF[17];
  const camWorldX = inpF[18];
  const camWorldY = inpF[19];
  let xMin = 0, xMax = W, yMin = 0, yMax = H;
  if (camZoom > 0 && camCW > 0 && camCH > 0) {
    const CULL_MARGIN = 8; // blocks beyond the flat visible rect
    const visW = camCW / camZoom;
    const visH = camCH / camZoom;
    // Convert camera world position → sim-origin active-grid coords.
    const simOriginCx = simReader.getOriginCx();
    const simOriginCy = simReader.getOriginCy();
    const cx = camWorldX - simOriginCx * 64; // CHUNK_W = CHUNK_H = 64
    const cy = camWorldY - simOriginCy * 64;
    xMin = Math.max(0, Math.floor(cx - visW * 0.5 - CULL_MARGIN));
    xMax = Math.min(W, Math.ceil(cx + visW * 0.5 + CULL_MARGIN));
    yMin = Math.max(0, Math.floor(cy - visH * 0.5 - CULL_MARGIN));
    yMax = Math.min(H, Math.ceil(cy + visH * 0.5 + CULL_MARGIN));
  }

  // --- Pad fg/bg block IDs into 256-byte-aligned rows ---
  // Always pad the FULL grid — the shader samples neighbor block IDs and
  // light at arbitrary positions (including just outside the visible area
  // for edge blending), so partial textures would cause artifacts.
  //
  // Use typed array .set() with subarray for native-speed row copies instead
  // of a per-element JS loop. Uint8Array.set(Uint16Array.subarray()) copies
  // each element, truncating to uint8 (equivalent to & 0xFF) — but the engine
  // uses optimized memcpy-like operations internally, making it ~10x faster
  // than a per-element JS loop on mobile.
  const paddedFg = writer.paddedFgGrid;
  const paddedBg = writer.paddedBgGrid;
  const rowBytes = PADDED_GRID_ROW_BYTES;
  for (let y = 0; y < H; y++) {
    const srcOff = y * W;
    paddedFg.set(foreground.subarray(srcOff, srcOff + W), y * rowBytes);
    paddedBg.set(background.subarray(srcOff, srcOff + W), y * rowBytes);
  }

  // --- Foreground blocks (rendered at 2 Z depths: Z=0 and Z=-1) ---
  // Only iterate the visible rectangle — off-screen cells are skipped,
  // dramatically reducing instance count and vertex shader work.
  for (let layer = 0; layer < NUM_FG_LAYERS; layer++) {
    const layerZ = FG_Z_LAYERS[layer];
    for (let y = yMin; y < yMax; y++) {
      for (let x = xMin; x < xMax; x++) {
        const cellIdx = y * W + x;
        const packedFg = foreground[cellIdx];
        const blockId = packedFg & 0xFF;
        if (blockId === 0) continue;
        // Crop + wild forageable blocks are rendered as 2D sprites by
        // CropSpritePass, not as 3D cubes here.
        if (CROP_LOOKUP[blockId] !== 0) continue;
        // Water is rendered in a separate transparent pass (after characters)
        // so the player stays visible behind it. Skip it here to avoid
        // double-rendering in the opaque pass.
        if (blockId === BLOCK_WATER) continue;

        let faceMask = 0;
        const e = x >= W - 1 || isAirOrCrop(foreground[y * W + (x + 1)] & 0xFF);
        const w = x <= 0 || isAirOrCrop(foreground[y * W + (x - 1)] & 0xFF);
        const s = y >= H - 1 || isAirOrCrop(foreground[(y + 1) * W + x] & 0xFF);
        const n = y <= 0 || isAirOrCrop(foreground[(y - 1) * W + x] & 0xFF);
        if (e) faceMask |= FACE_RIGHT;
        if (w) faceMask |= FACE_LEFT;
        if (s) faceMask |= FACE_BOTTOM;
        if (n) faceMask |= FACE_TOP;

        // --- Corner mask (marching-squares slope VFX) ---
        // Only terrain-eligible blocks get slopes; structural/utility blocks
        // stay blocky. See computeCornerMask for the neighborhood rule.
        if (SLOPE_ELIGIBLE.has(blockId)) {
          const nw = (x > 0 && y > 0) ? !isAirOrCrop(foreground[(y - 1) * W + (x - 1)] & 0xFF) : false;
          const ne = (x < W - 1 && y > 0) ? !isAirOrCrop(foreground[(y - 1) * W + (x + 1)] & 0xFF) : false;
          const sw = (x > 0 && y < H - 1) ? !isAirOrCrop(foreground[(y + 1) * W + (x - 1)] & 0xFF) : false;
          const se = (x < W - 1 && y < H - 1) ? !isAirOrCrop(foreground[(y + 1) * W + (x + 1)] & 0xFF) : false;
          faceMask |= computeCornerMask(!n, !e, !s, !w, nw, ne, sw, se);
        }

        if (layer === 0) {
          faceMask |= FACE_FRONT;
        } else {
          if ((background[cellIdx] & 0xFF) === 0) faceMask |= FACE_BACK;
          faceMask |= FACE_FRONT;
        }

        data[idx * 5 + 0] = x;
        data[idx * 5 + 1] = y;
        data[idx * 5 + 2] = layerZ;
        data[idx * 5 + 3] = blockId;
        data[idx * 5 + 4] = faceMask;
        idx++;
      }
    }
  }
  const fgInstanceCount = idx;

  // --- Background layer 4: back wall (terrain only, no trees) at Z=-3 ---
  for (let y = yMin; y < yMax; y++) {
    for (let x = xMin; x < xMax; x++) {
      const cellIdx = y * W + x;
      const packedBg = background[cellIdx];
      const blockId = packedBg & 0xFF;
      if (blockId === 0) continue;
      if (isTreeBlock(blockId)) continue;

      let faceMask = 0;
      faceMask |= FACE_FRONT;
      const isWall = (v: number) => v !== 0 && !isTreeBlock(v);
      const n = y <= 0 || !isWall(background[(y - 1) * W + x] & 0xFF);
      const s = y >= H - 1 || !isWall(background[(y + 1) * W + x] & 0xFF);
      const e = x >= W - 1 || !isWall(background[y * W + (x + 1)] & 0xFF);
      const w = x <= 0 || !isWall(background[y * W + (x - 1)] & 0xFF);
      if (n) faceMask |= FACE_TOP;
      if (s) faceMask |= FACE_BOTTOM;
      if (e) faceMask |= FACE_RIGHT;
      if (w) faceMask |= FACE_LEFT;

      // --- Corner mask (marching-squares slope VFX) ---
      if (SLOPE_ELIGIBLE.has(blockId)) {
        const nw = (x > 0 && y > 0) ? isWall(background[(y - 1) * W + (x - 1)] & 0xFF) : false;
        const ne = (x < W - 1 && y > 0) ? isWall(background[(y - 1) * W + (x + 1)] & 0xFF) : false;
        const sw = (x > 0 && y < H - 1) ? isWall(background[(y + 1) * W + (x - 1)] & 0xFF) : false;
        const se = (x < W - 1 && y < H - 1) ? isWall(background[(y + 1) * W + (x + 1)] & 0xFF) : false;
        faceMask |= computeCornerMask(!n, !e, !s, !w, nw, ne, sw, se);
      }

      data[idx * 5 + 0] = x;
      data[idx * 5 + 1] = y;
      data[idx * 5 + 2] = BG_Z_LAYERS[1]; // Z=-3
      data[idx * 5 + 3] = blockId;
      data[idx * 5 + 4] = faceMask;
      idx++;
    }
  }
  const bgWallInstanceCount = idx - fgInstanceCount;

  // --- Background layer 3: all background blocks (trees + terrain) at Z=-2 ---
  for (let y = yMin; y < yMax; y++) {
    for (let x = xMin; x < xMax; x++) {
      const cellIdx = y * W + x;
      const packedBg = background[cellIdx];
      const blockId = packedBg & 0xFF;
      if (blockId === 0) continue;

      let faceMask = 0;
      faceMask |= FACE_FRONT;
      const isSolid = (v: number) => v !== 0;
      const n = y <= 0 || !isSolid(background[(y - 1) * W + x] & 0xFF);
      const s = y >= H - 1 || !isSolid(background[(y + 1) * W + x] & 0xFF);
      const e = x >= W - 1 || !isSolid(background[y * W + (x + 1)] & 0xFF);
      const w = x <= 0 || !isSolid(background[y * W + (x - 1)] & 0xFF);
      if (n) faceMask |= FACE_TOP;
      if (s) faceMask |= FACE_BOTTOM;
      if (e) faceMask |= FACE_RIGHT;
      if (w) faceMask |= FACE_LEFT;

      // --- Corner mask (marching-squares slope VFX) ---
      // Trees are not in SLOPE_ELIGIBLE, so only terrain blocks get slopes.
      if (SLOPE_ELIGIBLE.has(blockId)) {
        const nw = (x > 0 && y > 0) ? isSolid(background[(y - 1) * W + (x - 1)] & 0xFF) : false;
        const ne = (x < W - 1 && y > 0) ? isSolid(background[(y - 1) * W + (x + 1)] & 0xFF) : false;
        const sw = (x > 0 && y < H - 1) ? isSolid(background[(y + 1) * W + (x - 1)] & 0xFF) : false;
        const se = (x < W - 1 && y < H - 1) ? isSolid(background[(y + 1) * W + (x + 1)] & 0xFF) : false;
        faceMask |= computeCornerMask(!n, !e, !s, !w, nw, ne, sw, se);
      }

      data[idx * 5 + 0] = x;
      data[idx * 5 + 1] = y;
      data[idx * 5 + 2] = BG_Z_LAYERS[0]; // Z=-2
      data[idx * 5 + 3] = blockId;
      data[idx * 5 + 4] = faceMask;
      idx++;
    }
  }
  const bgTreeInstanceCount = idx - fgInstanceCount - bgWallInstanceCount;

  // --- Water (transparent) instances — rendered separately after characters ---
  // Water is excluded from the fg loop above so it's not double-rendered in
  // the opaque pass. Here we build water-only instances at the end of the
  // instance data, using the same 2-layer (Z=0, Z=-1) scheme as fg blocks.
  for (let layer = 0; layer < NUM_FG_LAYERS; layer++) {
    const layerZ = FG_Z_LAYERS[layer];
    for (let y = yMin; y < yMax; y++) {
      for (let x = xMin; x < xMax; x++) {
        const cellIdx = y * W + x;
        const packedFg = foreground[cellIdx];
        const blockId = packedFg & 0xFF;
        if (blockId !== BLOCK_WATER) continue;

        let faceMask = 0;
        if (x >= W - 1 || isAirOrCrop(foreground[y * W + (x + 1)] & 0xFF)) faceMask |= FACE_RIGHT;
        if (x <= 0 || isAirOrCrop(foreground[y * W + (x - 1)] & 0xFF)) faceMask |= FACE_LEFT;
        if (y >= H - 1 || isAirOrCrop(foreground[(y + 1) * W + x] & 0xFF)) faceMask |= FACE_BOTTOM;
        if (y <= 0 || isAirOrCrop(foreground[(y - 1) * W + x] & 0xFF)) faceMask |= FACE_TOP;

        if (layer === 0) {
          faceMask |= FACE_FRONT;
        } else {
          if ((background[cellIdx] & 0xFF) === 0) faceMask |= FACE_BACK;
          faceMask |= FACE_FRONT;
        }

        data[idx * 5 + 0] = x;
        data[idx * 5 + 1] = y;
        data[idx * 5 + 2] = layerZ;
        data[idx * 5 + 3] = blockId;
        data[idx * 5 + 4] = faceMask;
        idx++;
      }
    }
  }
  const waterInstanceCount = idx - fgInstanceCount - bgWallInstanceCount - bgTreeInstanceCount;

  // --- Pad light (RGBA8) into 256-byte-aligned rows ---
  const paddedLight = writer.paddedLight;
  const lightRowBytes = PADDED_LIGHT_ROW_BYTES;
  const srcLightRowBytes = W * 4;
  for (let y = 0; y < H; y++) {
    paddedLight.set(
      light.subarray(y * srcLightRowBytes, (y + 1) * srcLightRowBytes),
      y * lightRowBytes,
    );
  }

  // --- Pad explored (R8) into 256-byte-aligned rows ---
  const paddedExplored = writer.paddedExplored;
  const exploredRowBytes = PADDED_EXPLORED_ROW_BYTES;
  for (let y = 0; y < H; y++) {
    paddedExplored.set(
      explored.subarray(y * W, (y + 1) * W),
      y * exploredRowBytes,
    );
  }

  // --- Atomically publish (release) ---
  // The origin is published alongside the build tick so the renderer can use
  // an origin that always matches the grid data on the GPU (eliminating the
  // chunk-boundary flash where the sim SAB origin advances before the
  // grid-builder has published the matching grid data).
  writer.publishBuild(
    tick, fgInstanceCount, bgWallInstanceCount, bgTreeInstanceCount,
    simReader.getOriginCx(), simReader.getOriginCy(), waterInstanceCount,
  );
  lastBuiltTick = tick;

  // SAB polyfill: sync render data to the main thread after each build.
  // No-op when real SAB is available (desktop).
  // Throttled: sync the render header (32 bytes) every build so the renderer
  // knows a new build exists, and sync the full render data (~16MB) every
  // RENDER_SYNC_INTERVAL builds to avoid copying 500MB/s on mobile.
  if (syncWorker) {
    renderSyncCounter++;
    if (renderSyncCounter >= RENDER_SYNC_INTERVAL) {
      // Sync textures + instances together every RENDER_SYNC_INTERVAL builds.
      // Instances are needed for the block grid to render at all.
      syncWorker.syncToMain(["render-textures", "render-instances"]);
      renderSyncCounter = 0;
    }
    // Sync the header every build so the renderer knows a new build exists.
    syncWorker.syncToMain(["render-header"]);
  }

  // Build profiling: accumulate + log every 5s
  const buildMs = performance.now() - buildStart;
  buildProfTimes.push(buildMs);
  const now = performance.now();
  if (now - buildProfTimer >= 5000) {
    buildProfTimer = now;
    const count = buildProfTimes.length;
    const avg = buildProfTimes.reduce((a, b) => a + b, 0) / count;
    const max = Math.max(...buildProfTimes);
    console.warn(`[GridBuilder Profiling] ${count} builds over 5s: avg=${avg.toFixed(2)}ms max=${max.toFixed(2)}ms`);
    buildProfTimes.length = 0;
  }
}

const api = {
  async init(simSab: SharedArrayBuffer, renderSab: SharedArrayBuffer): Promise<void> {
    simReader = new SimBufferReader(simSab);
    renderWriter = new RenderBufferWriter(renderSab);
    running = true;

    // SAB polyfill: set up buffer sync if SAB is unavailable.
    // The BufferSyncWorker receives sim data from the main thread (readRegions)
    // and posts render data to the main thread (writeRegions) after each build.
    if (!usingRealSAB) {
      const { BufferSyncWorker } = await import("@downdraft/core/worker/buffer-sync");
      // Render SAB layout offsets — computed locally from byteLength to avoid
      // importing constants that Vite tree-shakes incorrectly in the mobile bundle.
      // Layout: HEADER(32) | INSTANCE_DATA | PADDED_FG | PADDED_BG | PADDED_LIGHT | PADDED_EXPLORED
      // Texture sizes (ACTIVE_GRID_W=448, ACTIVE_GRID_H=448):
      //   PADDED_GRID_ROW = ceil(448/256)*256 = 512; grid tex = 512*448 = 229376
      //   PADDED_LIGHT_ROW = ceil(448*4/256)*256 = 1792; light tex = 1792*448 = 802816
      //   Total textures = 2*229376 + 802816 + 229376 = 1490944
      const R_HDR = 32;
      const R_TEX_SIZE = 1490944;
      const R_INSTANCE_OFFSET = R_HDR;
      const R_TEXTURE_OFFSET = renderSab.byteLength - R_TEX_SIZE;
      const R_TOTAL_COUNT_OFFSET = 16; // RENDER_HEADER_TOTAL_COUNT
      const R_INSTANCE_STRIDE = 5;
      const syncConfig: BufferSyncConfig = {
        buffers: { sim: simSab, render: renderSab },
        regions: {
          // Sim SAB: main thread sends sim data (readRegions = what the
          // grid builder reads from the main thread). Grid builder doesn't
          // write to the sim SAB, so no writeRegions.
          // Split into named regions to mirror the host's write regions.
          sim: {
            writeRegions: [],
            readRegions: [
              { offset: 0, length: 48, name: "header" },
              { offset: 48, length: simSab.byteLength - 128 - 48 - 2048 - 16384, name: "grids" },
              { offset: simSab.byteLength - 128 - 16384 - 2048, length: 2048, name: "blockheads" },
              { offset: simSab.byteLength - 128 - 16384, length: 16384, name: "drops" },
            ],
          },
          // Render SAB: grid builder writes everything (writeRegions).
          // Main thread doesn't write to the render SAB, so no readRegions.
          // Split into 3 regions for efficient sync:
          //   render-header (32B): synced every build — tick + instance counts
          //   render-instances (dynamic): synced every 3 builds — only active
          //     instance data (typically 200-800KB vs 15.3MB full allocation)
          //   render-textures (~1.5MB): synced every 3 builds — padded grid +
          //     light + explored textures
          render: {
            writeRegions: [
              { offset: 0, length: R_HDR, name: "render-header" },
              {
                offset: R_INSTANCE_OFFSET,
                length: renderSab.byteLength - R_INSTANCE_OFFSET,
                name: "render-instances",
                // Dynamic length: only sync the active instances, not the
                // full 15.3MB allocation. The actual count is in
                // RENDER_HEADER_TOTAL_COUNT (Uint32 at offset 16).
                lengthFieldOffset: R_TOTAL_COUNT_OFFSET,
                lengthMultiplier: 4 * R_INSTANCE_STRIDE, // count * floats * bytes
              },
              {
                offset: R_TEXTURE_OFFSET,
                length: R_TEX_SIZE,
                name: "render-textures",
              },
            ],
            readRegions: [],
          },
        },
        seqFields: {
          render: { offset: 0 }, // RENDER_HEADER_TICK (Uint32 at offset 0)
        },
      };
      syncWorker = new BufferSyncWorker(syncConfig);
      // Event-driven build: build immediately when new sim data arrives,
      // instead of polling on a timer. This avoids Android WebView's
      // timer throttling in workers (which can throttle setInterval to
      // ~100ms+ intervals, causing the grid builder to miss 30Hz ticks).
      syncWorker.start(() => { if (running) build(); });
    }

    // Build once immediately so the renderer has data on the first frame.
    build();
  },

  shutdown(): void {
    running = false;
    syncWorker = null;
    simReader = null;
    renderWriter = null;
    lastBuiltTick = -1;
  },

  /** Force an immediate build (used for deterministic test mode). */
  buildNow(): void {
    build();
  },
};

expose(api);
