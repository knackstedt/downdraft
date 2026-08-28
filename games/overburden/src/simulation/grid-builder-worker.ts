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

import { expose } from "@downdraft/core/worker/rpc";
import {
    ACTIVE_GRID_H,
    ACTIVE_GRID_W,
} from "../shared/constants";
import { CROP_LOOKUP } from "../shared/crops";
import {
    PADDED_EXPLORED_ROW_BYTES,
    PADDED_GRID_ROW_BYTES,
    PADDED_LIGHT_ROW_BYTES,
    RenderBufferWriter,
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
let pollTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

/** Build instance data + padded textures from the current sim SAB state. */
function build(): void {
  if (!simReader || !renderWriter) return;

  const foreground = simReader.foreground;
  const background = simReader.background;
  const light = simReader.light;
  const explored = simReader.explored;
  const tick = simReader.getTick();
  if (tick === lastBuiltTick) return; // no new sim tick

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
  const paddedFg = writer.paddedFgGrid;
  const paddedBg = writer.paddedBgGrid;
  const rowBytes = PADDED_GRID_ROW_BYTES;
  for (let y = 0; y < H; y++) {
    const srcOff = y * W;
    const dstOff = y * rowBytes;
    for (let x = 0; x < W; x++) {
      paddedFg[dstOff + x] = foreground[srcOff + x] & 0xFF;
      paddedBg[dstOff + x] = background[srcOff + x] & 0xFF;
    }
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
      if (y <= 0 || !isWall(background[(y - 1) * W + x] & 0xFF)) faceMask |= FACE_TOP;
      if (y >= H - 1 || !isWall(background[(y + 1) * W + x] & 0xFF)) faceMask |= FACE_BOTTOM;
      if (x >= W - 1 || !isWall(background[y * W + (x + 1)] & 0xFF)) faceMask |= FACE_RIGHT;
      if (x <= 0 || !isWall(background[y * W + (x - 1)] & 0xFF)) faceMask |= FACE_LEFT;

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
      if (y <= 0 || !isSolid(background[(y - 1) * W + x] & 0xFF)) faceMask |= FACE_TOP;
      if (y >= H - 1 || !isSolid(background[(y + 1) * W + x] & 0xFF)) faceMask |= FACE_BOTTOM;
      if (x >= W - 1 || !isSolid(background[y * W + (x + 1)] & 0xFF)) faceMask |= FACE_RIGHT;
      if (x <= 0 || !isSolid(background[y * W + (x - 1)] & 0xFF)) faceMask |= FACE_LEFT;

      data[idx * 5 + 0] = x;
      data[idx * 5 + 1] = y;
      data[idx * 5 + 2] = BG_Z_LAYERS[0]; // Z=-2
      data[idx * 5 + 3] = blockId;
      data[idx * 5 + 4] = faceMask;
      idx++;
    }
  }
  const bgTreeInstanceCount = idx - fgInstanceCount - bgWallInstanceCount;

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
    simReader.getOriginCx(), simReader.getOriginCy(),
  );
  lastBuiltTick = tick;
}

/** Poll loop — checks for new sim ticks and builds when one arrives. */
function poll(): void {
  if (!running || !simReader) return;
  build();
}

const api = {
  init(simSab: SharedArrayBuffer, renderSab: SharedArrayBuffer): void {
    simReader = new SimBufferReader(simSab);
    renderWriter = new RenderBufferWriter(renderSab);
    running = true;
    // Poll at 2ms intervals — fast enough to catch 30Hz tick changes with
    // minimal latency, but not a tight busy-loop that burns CPU.
    pollTimer = setInterval(poll, 2);
  },

  shutdown(): void {
    running = false;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
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
