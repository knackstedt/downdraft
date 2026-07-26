/// Cross-process shared memory IPC for Bun <-> Rust native-renderer.
/// Uses Bun.mmap to memory-map a file created by the Rust binary.

import { createLogger } from "../util/logger.ts";

const log = createLogger();

// Shared memory layout (must match native-renderer/src/ipc.rs)
export const SHM_SIZE = 256 * 1024 * 1024; // 256MB — mesh data needs ~120MB for 6 islands at 10x resolution
const CMD_SEQ_OFFSET = 0;
const CMD_TYPE_OFFSET = 4;
const CMD_SIZE_OFFSET = 8;
const CMD_PAYLOAD_OFFSET = 12;
const CMD_PAYLOAD_SIZE = 512;
const TLM_SEQ_OFFSET = 524;
const TLM_FPS_OFFSET = 528;
const TLM_FRAME_TIME_OFFSET = 532;
const TLM_ENTITY_COUNT_OFFSET = 536;
const TLM_STATUS_OFFSET = 540;

// Render data section (written by Bun, read by Rust renderer)
const RENDER_SEQ_OFFSET = 544;
const RENDER_ENTITY_COUNT_OFFSET = 548;
const RENDER_CAM_POS_OFFSET = 552;       // 3 × f32 = 12 bytes
const RENDER_CAM_TARGET_OFFSET = 564;    // 3 × f32 = 12 bytes
const RENDER_ENTITIES_OFFSET = 576;      // array of RenderEntityData
export const RENDER_MAX_ENTITIES = 96;
export const RENDER_ENTITY_STRIDE = 28;  // type(4) + pos(12) + color(12) = 28 bytes

// Input section (written by Rust renderer, read by Bun)
// 96 entities * 28 bytes = 2688, starting at 576, ends at 3264
export const INPUT_OFFSET = 3264;        // held_keys: u32 bitfield
export const INPUT_PRESSED_OFFSET = 3268; // pressed_keys: u32 bitfield (one-shot)
export const INPUT_MOUSE_DX_OFFSET = 3272;  // mouse delta X (f32)
export const INPUT_MOUSE_DY_OFFSET = 3276;  // mouse delta Y (f32)
export const INPUT_WHEEL_OFFSET = 3280;     // mouse wheel delta (f32)
export const INPUT_EXT_OFFSET = 3284;        // held_keys_ext: u32 bitfield (numpad etc.)
export const INPUT_PRESSED_EXT_OFFSET = 3288; // pressed_keys_ext: u32 bitfield (one-shot)

// Weather visual data (written by Bun each tick, read by Rust renderer)
export const WEATHER_SEQ_OFFSET = 3292;          // seqlock (u32)
export const WEATHER_SKY_COLOR_OFFSET = 3296;    // 3 × f32 (rgb)
export const WEATHER_WATER_COLOR_OFFSET = 3308;  // 3 × f32 (rgb)
export const WEATHER_FOG_COLOR_OFFSET = 3320;    // 3 × f32 (rgb)
export const WEATHER_FOG_DENSITY_OFFSET = 3332;  // f32
export const WEATHER_LIGHT_INTENSITY_OFFSET = 3336; // f32
export const WEATHER_TYPE_OFFSET = 3340;            // u32 (WeatherType enum value)
export const WEATHER_IS_NIGHT_OFFSET = 3344;        // u32 (0 or 1)

// Mesh data section (written by Bun once at init, read by Rust once)
export const MESH_SEQ_OFFSET = 3348;       // seqlock (u32)
export const MESH_COUNT_OFFSET = 3352;     // number of meshes (u32)
export const MESH_DATA_OFFSET = 3356;      // mesh data starts here

// Water data section (written by Bun each tick, read by Rust renderer)
// Chunk-based: up to 25 chunks, each 644x644 f32 heights + header (10x resolution)
// Placed at 128MB offset to leave ~128MB for mesh data
export const WATER_MAX_CHUNKS = 25;
export const WATER_CHUNK_GRID = 68; // CHUNK_SIZE + 2*CHUNK_OVERLAP
export const WATER_SEQ_OFFSET = 134217728;           // seqlock (u32) — 128MB
export const WATER_CHUNK_COUNT_OFFSET = 134217732;    // chunk count (u32)
export const WATER_PATCH_SIZE_OFFSET = 134217736;     // patch size (f32)
export const WATER_CHUNK_DATA_OFFSET = 134217740;     // first chunk starts here
export const WATER_CHUNK_HEADER_SIZE = 12;            // originX(i32) + originZ(i32) + grid_size(u32)
export const WATER_CHUNK_HEIGHTS_SIZE = WATER_CHUNK_GRID * WATER_CHUNK_GRID * 4; // 68*68*4 = 18496
export const WATER_CHUNK_STRIDE = WATER_CHUNK_HEADER_SIZE + WATER_CHUNK_HEIGHTS_SIZE; // 18508
export const WATER_DATA_END = WATER_CHUNK_DATA_OFFSET + WATER_MAX_CHUNKS * WATER_CHUNK_STRIDE; // 134217740 + 25*18508 = 134681940

// Game state section (written by Bun each tick, read by Rust renderer)
export const GAME_STATE_OFFSET = WATER_DATA_END;             // is_dead: u32 (0 or 1)
export const GAME_STATE_CAUSE_OFFSET = WATER_DATA_END + 4;   // cause: [u8; 64]
export const GAME_STATE_CAUSE_SIZE = 64;

// Respawn request (written by Rust renderer, read by Bun)
export const RESPAWN_REQUEST_OFFSET = WATER_DATA_END + 68;   // respawn_requested: u32 (0 or 1)

// Inventory data section (written by Bun each tick, read by Rust renderer)
// Stored as a JSON string for flexibility — grid slots, item names, quantities, spoil
export const INVENTORY_SEQ_OFFSET = WATER_DATA_END + 72;       // seqlock (u32)
export const INVENTORY_DATA_OFFSET = WATER_DATA_END + 76;      // JSON string
export const INVENTORY_DATA_SIZE = 8192;                        // max bytes for inventory JSON

// Craft request (written by Rust renderer, read by Bun)
// 64-byte buffer for recipe ID (null-terminated string)
export const CRAFT_REQUEST_OFFSET = INVENTORY_DATA_OFFSET + INVENTORY_DATA_SIZE; // [u8; 64]
export const CRAFT_REQUEST_SIZE = 64;

// Key bit assignments
export const KEY_BITS: Record<string, number> = {
  w: 0, a: 1, s: 2, d: 3,
  shift: 4, arrowleft: 5, arrowright: 6, arrowup: 7, arrowdown: 8,
  e: 9, q: 10, r: 11, f: 12, c: 13, b: 14, t: 15,
  g: 16, x: 17, v: 18, h: 19, j: 20, p: 21, y: 22,
  m: 23, space: 24, ctrl: 25, f5: 26,
  "1": 27, "2": 28, "3": 29, "4": 30, "5": 31,
};

// Extended key bits (second u32 word — numpad keys etc.)
export const KEY_BITS_EXT: Record<string, number> = {
  numpad0: 0, numpad1: 1, numpad2: 2, numpad3: 3, numpad4: 4,
  numpad5: 5, numpad6: 6, numpad7: 7, numpad8: 8, numpad9: 9,
  numpaddivide: 10, numpadmultiply: 11, numpadsubtract: 12, numpadadd: 13,
  i: 14,
};

const KEY_BITS_ENTRIES = Object.entries(KEY_BITS);
const KEY_BITS_EXT_ENTRIES = Object.entries(KEY_BITS_EXT);

export enum RenderEntityType {
  Player = 0,
  Ship = 1,
  Shark = 2,
  Fish = 3,
  Debris = 4,
  Water = 5,
  Island = 6,
  Buildable = 7,
  Pirate = 8,
  Port = 9,
  Animal = 10,
  Plant = 11,
  Pet = 12,
}

export interface RenderEntityData {
  type: RenderEntityType;
  x: number; y: number; z: number;
  r: number; g: number; b: number;
}

export interface RenderData {
  cameraPos: [number, number, number];
  cameraTarget: [number, number, number];
  entities: RenderEntityData[];
}

export interface MeshData {
  vertexCount: number;
  indexCount: number;
  posX: number;
  posZ: number;
  lodLevel: number;
  lodDistance: number;
  verts: Float32Array;    // 9 floats per vertex: pos.xyz, normal.xyz, color.rgb
  indices: Uint32Array;   // u32 indices
}

export enum CommandType {
  None = 0,
  LoadScene = 1,
  SetTimeScale = 2,
  Pause = 3,
  Resume = 4,
  Resize = 5,
  Quit = 6,
}

export interface Telemetry {
  fps: number;
  frameTimeUs: number;
  entityCount: number;
  status: number;
}

export class SharedMemoryIPC {
  private bytes: Uint8Array;
  private view: DataView;
  private u32: Uint32Array;
  private u8!: Uint8Array;

  /** Attach to an existing shared memory file created by the Rust renderer */
  attach(path: string): boolean {
    try {
      this.bytes = Bun.mmap(path);
      if (this.bytes.length < SHM_SIZE) {
        log.error("ipc", `Mapped file too small: ${this.bytes.length} < ${SHM_SIZE}`);
        return false;
      }
      this.view = new DataView(
        this.bytes.buffer,
        this.bytes.byteOffset,
        SHM_SIZE,
      );
      this.u32 = new Uint32Array(
        this.bytes.buffer,
        this.bytes.byteOffset,
        SHM_SIZE / 4,
      );
      this.u8 = this.bytes;
      return true;
    } catch (e) {
      log.error("ipc", `Failed to mmap shared memory file: ${path} ${e}`);
      return false;
    }
  }

  /** Read telemetry from the shared memory (seqlock read) */
  readTelemetry(): Telemetry | null {
    const s1 = this.u32[TLM_SEQ_OFFSET / 4];
    if (s1 & 1) return null;

    const fps = this.u32[TLM_FPS_OFFSET / 4];
    const frameTimeUs = this.u32[TLM_FRAME_TIME_OFFSET / 4];
    const entityCount = this.u32[TLM_ENTITY_COUNT_OFFSET / 4];
    const status = this.u32[TLM_STATUS_OFFSET / 4];

    const s2 = this.u32[TLM_SEQ_OFFSET / 4];
    if (s1 !== s2 || s2 & 1) return null;

    return { fps, frameTimeUs, entityCount, status };
  }

  /** Write a command to the shared memory (seqlock write) */
  sendCommand(type: CommandType, payload: Uint8Array = new Uint8Array(0)): boolean {
    const seq = this.u32[CMD_SEQ_OFFSET / 4];

    // Begin write (increment to odd)
    this.u32[CMD_SEQ_OFFSET / 4] = seq + 1;

    // Write command type
    this.u32[CMD_TYPE_OFFSET / 4] = type;

    // Write payload size
    const size = Math.min(payload.length, CMD_PAYLOAD_SIZE);
    this.u32[CMD_SIZE_OFFSET / 4] = size;

    // Write payload
    if (size > 0) {
      this.bytes.set(payload.subarray(0, size), CMD_PAYLOAD_OFFSET);
    }

    // End write (increment to even)
    this.u32[CMD_SEQ_OFFSET / 4] = seq + 2;

    return true;
  }

  /** Convenience: send quit command */
  quit(): void {
    this.sendCommand(CommandType.Quit);
  }

  /** Convenience: send pause command */
  pause(): void {
    this.sendCommand(CommandType.Pause);
  }

  /** Convenience: send resume command */
  resume(): void {
    this.sendCommand(CommandType.Resume);
  }

  /** Convenience: send resize command */
  resize(width: number, height: number): void {
    const payload = new Uint8Array(8);
    new DataView(payload.buffer).setUint32(0, width, true);
    new DataView(payload.buffer).setUint32(4, height, true);
    this.sendCommand(CommandType.Resize, payload);
  }

  /** Convenience: send load scene command */
  loadScene(scenePath: string): void {
    const payload = new TextEncoder().encode(scenePath);
    this.sendCommand(CommandType.LoadScene, payload);
  }

  /** Convenience: set time scale */
  setTimeScale(scale: number): void {
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setFloat32(0, scale, true);
    this.sendCommand(CommandType.SetTimeScale, payload);
  }

  /** Write render data (camera + entities) to shared memory */
  writeRenderData(data: RenderData): void {
    const seq = this.u32[RENDER_SEQ_OFFSET / 4];
    this.u32[RENDER_SEQ_OFFSET / 4] = seq + 1; // begin write (odd)

    const entityCount = Math.min(data.entities.length, RENDER_MAX_ENTITIES);
    this.u32[RENDER_ENTITY_COUNT_OFFSET / 4] = entityCount;

    // Camera position
    this.view.setFloat32(RENDER_CAM_POS_OFFSET, data.cameraPos[0], true);
    this.view.setFloat32(RENDER_CAM_POS_OFFSET + 4, data.cameraPos[1], true);
    this.view.setFloat32(RENDER_CAM_POS_OFFSET + 8, data.cameraPos[2], true);

    // Camera target
    this.view.setFloat32(RENDER_CAM_TARGET_OFFSET, data.cameraTarget[0], true);
    this.view.setFloat32(RENDER_CAM_TARGET_OFFSET + 4, data.cameraTarget[1], true);
    this.view.setFloat32(RENDER_CAM_TARGET_OFFSET + 8, data.cameraTarget[2], true);

    // Entities
    for (let i = 0; i < entityCount; i++) {
      const e = data.entities[i];
      const off = RENDER_ENTITIES_OFFSET + i * RENDER_ENTITY_STRIDE;
      this.u32[off / 4] = e.type;
      this.view.setFloat32(off + 4, e.x, true);
      this.view.setFloat32(off + 8, e.y, true);
      this.view.setFloat32(off + 12, e.z, true);
      this.view.setFloat32(off + 16, e.r, true);
      this.view.setFloat32(off + 20, e.g, true);
      this.view.setFloat32(off + 24, e.b, true);
    }

    this.u32[RENDER_SEQ_OFFSET / 4] = seq + 2; // end write (even)
  }

  /** Read render data from shared memory (seqlock read) */
  readRenderData(): RenderData | null {
    const s1 = this.u32[RENDER_SEQ_OFFSET / 4];
    if (s1 & 1) return null;

    const entityCount = this.u32[RENDER_ENTITY_COUNT_OFFSET / 4];
    const camPos: [number, number, number] = [
      this.view.getFloat32(RENDER_CAM_POS_OFFSET, true),
      this.view.getFloat32(RENDER_CAM_POS_OFFSET + 4, true),
      this.view.getFloat32(RENDER_CAM_POS_OFFSET + 8, true),
    ];
    const camTarget: [number, number, number] = [
      this.view.getFloat32(RENDER_CAM_TARGET_OFFSET, true),
      this.view.getFloat32(RENDER_CAM_TARGET_OFFSET + 4, true),
      this.view.getFloat32(RENDER_CAM_TARGET_OFFSET + 8, true),
    ];

    const entities: RenderEntityData[] = [];
    for (let i = 0; i < entityCount && i < RENDER_MAX_ENTITIES; i++) {
      const off = RENDER_ENTITIES_OFFSET + i * RENDER_ENTITY_STRIDE;
      entities.push({
        type: this.u32[off / 4],
        x: this.view.getFloat32(off + 4, true),
        y: this.view.getFloat32(off + 8, true),
        z: this.view.getFloat32(off + 12, true),
        r: this.view.getFloat32(off + 16, true),
        g: this.view.getFloat32(off + 20, true),
        b: this.view.getFloat32(off + 24, true),
      });
    }

    const s2 = this.u32[RENDER_SEQ_OFFSET / 4];
    if (s1 !== s2 || s2 & 1) return null;

    return { cameraPos: camPos, cameraTarget: camTarget, entities };
  }

  /** Read keyboard + mouse input from shared memory (written by Rust renderer) */
  readInput(): { keys: Set<string>; pressed: Set<string>; mouseDX: number; mouseDY: number; wheel: number } {
    const heldBits = this.u32[INPUT_OFFSET / 4] ?? 0;
    const pressedBits = this.u32[INPUT_PRESSED_OFFSET / 4] ?? 0;

    const keys = new Set<string>();
    const pressed = new Set<string>();

    for (let i = 0; i < KEY_BITS_ENTRIES.length; i++) {
      const [key, bit] = KEY_BITS_ENTRIES[i];
      if (heldBits & (1 << bit)) keys.add(key);
      if (pressedBits & (1 << bit)) pressed.add(key);
    }

    // Extended keys (numpad etc.)
    const heldExtBits = this.u32[INPUT_EXT_OFFSET / 4] ?? 0;
    const pressedExtBits = this.u32[INPUT_PRESSED_EXT_OFFSET / 4] ?? 0;
    for (let i = 0; i < KEY_BITS_EXT_ENTRIES.length; i++) {
      const [key, bit] = KEY_BITS_EXT_ENTRIES[i];
      if (heldExtBits & (1 << bit)) keys.add(key);
      if (pressedExtBits & (1 << bit)) pressed.add(key);
    }

    const mouseDX = this.view.getFloat32(INPUT_MOUSE_DX_OFFSET, true);
    const mouseDY = this.view.getFloat32(INPUT_MOUSE_DY_OFFSET, true);
    const wheel = this.view.getFloat32(INPUT_WHEEL_OFFSET, true);

    // Clear mouse deltas after reading (one-shot consumption)
    this.view.setFloat32(INPUT_MOUSE_DX_OFFSET, 0, true);
    this.view.setFloat32(INPUT_MOUSE_DY_OFFSET, 0, true);
    this.view.setFloat32(INPUT_WHEEL_OFFSET, 0, true);

    // Clear pressed key bits after reading (one-shot consumption)
    // This prevents Bun from seeing the same key press on multiple ticks
    // when the renderer runs faster than the simulation
    this.u32[INPUT_PRESSED_OFFSET / 4] = 0;
    this.u32[INPUT_PRESSED_EXT_OFFSET / 4] = 0;

    return { keys, pressed, mouseDX, mouseDY, wheel };
  }

  /** Write island mesh data to shared memory (called once after init) */
  writeMeshData(meshes: MeshData[]): void {
    const seq = this.u32[MESH_SEQ_OFFSET / 4];
    this.u32[MESH_SEQ_OFFSET / 4] = seq + 1; // begin write (odd)

    this.u32[MESH_COUNT_OFFSET / 4] = meshes.length;

    let offset = MESH_DATA_OFFSET;
    for (const mesh of meshes) {
      // Header: vertex_count, index_count, pos_x, pos_z, lod_level, lod_distance (24 bytes)
      this.u32[offset / 4] = mesh.vertexCount;
      this.u32[(offset + 4) / 4] = mesh.indexCount;
      this.view.setFloat32(offset + 8, mesh.posX, true);
      this.view.setFloat32(offset + 12, mesh.posZ, true);
      this.u32[(offset + 16) / 4] = mesh.lodLevel;
      this.view.setFloat32(offset + 20, mesh.lodDistance, true);
      offset += 24;

      // Vertices: vertexCount * 9 floats = vertexCount * 36 bytes
      const vertBytes = mesh.vertexCount * 36;
      if (offset + vertBytes > WATER_SEQ_OFFSET) break;
      const vertSrc = new Uint8Array(mesh.verts.buffer, mesh.verts.byteOffset, vertBytes);
      this.bytes.set(vertSrc, offset);
      offset += vertBytes;

      // Indices: indexCount * 4 bytes (u32)
      const idxBytes = mesh.indexCount * 4;
      if (offset + idxBytes > WATER_SEQ_OFFSET) break;
      const idxSrc = new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, idxBytes);
      this.bytes.set(idxSrc, offset);
      offset += idxBytes;
    }

    this.u32[MESH_SEQ_OFFSET / 4] = seq + 2; // end write (even)
  }

  /** Write water chunk data to shared memory (called each tick) */
  writeWaterData(data: { patchSize: number; chunks: { originX: number; originZ: number; gridSize: number; heights: Float32Array }[] }): void {
    const seq = this.u32[WATER_SEQ_OFFSET / 4];
    this.u32[WATER_SEQ_OFFSET / 4] = seq + 1; // begin write (odd)

    const chunkCount = Math.min(data.chunks.length, WATER_MAX_CHUNKS);
    this.u32[WATER_CHUNK_COUNT_OFFSET / 4] = chunkCount;
    this.view.setFloat32(WATER_PATCH_SIZE_OFFSET, data.patchSize, true);

    for (let i = 0; i < chunkCount; i++) {
      const chunk = data.chunks[i];
      const base = WATER_CHUNK_DATA_OFFSET + i * WATER_CHUNK_STRIDE;
      this.view.setInt32(base, chunk.originX, true);
      this.view.setInt32(base + 4, chunk.originZ, true);
      this.u32[(base + 8) / 4] = chunk.gridSize;

      // Bulk copy heights
      const count = chunk.gridSize * chunk.gridSize;
      const dst = new Float32Array(this.bytes.buffer, this.bytes.byteOffset + base + WATER_CHUNK_HEADER_SIZE, count);
      dst.set(chunk.heights.subarray(0, count));
    }

    this.u32[WATER_SEQ_OFFSET / 4] = seq + 2; // end write (even)
  }

  /** Write weather visual data to shared memory (called each tick) */
  writeWeatherVisual(data: { skyColor: [number, number, number]; waterColor: [number, number, number]; fogColor: [number, number, number]; fogDensity: number; lightIntensity: number; weatherType: number; isNight: boolean }): void {
    const seq = this.u32[WEATHER_SEQ_OFFSET / 4];
    this.u32[WEATHER_SEQ_OFFSET / 4] = seq + 1; // begin write (odd)

    this.view.setFloat32(WEATHER_SKY_COLOR_OFFSET, data.skyColor[0], true);
    this.view.setFloat32(WEATHER_SKY_COLOR_OFFSET + 4, data.skyColor[1], true);
    this.view.setFloat32(WEATHER_SKY_COLOR_OFFSET + 8, data.skyColor[2], true);

    this.view.setFloat32(WEATHER_WATER_COLOR_OFFSET, data.waterColor[0], true);
    this.view.setFloat32(WEATHER_WATER_COLOR_OFFSET + 4, data.waterColor[1], true);
    this.view.setFloat32(WEATHER_WATER_COLOR_OFFSET + 8, data.waterColor[2], true);

    this.view.setFloat32(WEATHER_FOG_COLOR_OFFSET, data.fogColor[0], true);
    this.view.setFloat32(WEATHER_FOG_COLOR_OFFSET + 4, data.fogColor[1], true);
    this.view.setFloat32(WEATHER_FOG_COLOR_OFFSET + 8, data.fogColor[2], true);

    this.view.setFloat32(WEATHER_FOG_DENSITY_OFFSET, data.fogDensity, true);
    this.view.setFloat32(WEATHER_LIGHT_INTENSITY_OFFSET, data.lightIntensity, true);
    this.u32[WEATHER_TYPE_OFFSET / 4] = data.weatherType;
    this.u32[WEATHER_IS_NIGHT_OFFSET / 4] = data.isNight ? 1 : 0;

    this.u32[WEATHER_SEQ_OFFSET / 4] = seq + 2; // end write (even)
  }

  /** Write game state (is_dead + cause) to shared memory (called each tick by Bun) */
  writeGameState(isDead: boolean, cause: string): void {
    this.u32[GAME_STATE_OFFSET / 4] = isDead ? 1 : 0;
    const causeBytes = new TextEncoder().encode(cause);
    const len = Math.min(causeBytes.length, GAME_STATE_CAUSE_SIZE - 1);
    this.bytes.set(causeBytes.subarray(0, len), GAME_STATE_CAUSE_OFFSET);
    // Null-terminate
    this.bytes[GAME_STATE_CAUSE_OFFSET + len] = 0;
  }

  /** Check if a respawn request is pending (called each tick by Bun) */
  readRespawnRequest(): boolean {
    const requested = (this.u32[RESPAWN_REQUEST_OFFSET / 4] ?? 0) !== 0;
    if (requested) {
      this.u32[RESPAWN_REQUEST_OFFSET / 4] = 0;
    }
    return requested;
  }

  /** Read a craft request (recipe ID) from the renderer, or null if none */
  readCraftRequest(): string | null {
    const firstByte = this.u8[CRAFT_REQUEST_OFFSET];
    if (firstByte === 0) return null;
    let str = "";
    for (let i = 0; i < CRAFT_REQUEST_SIZE; i++) {
      const b = this.u8[CRAFT_REQUEST_OFFSET + i];
      if (b === 0) break;
      str += String.fromCharCode(b);
    }
    // Clear the buffer
    for (let i = 0; i < CRAFT_REQUEST_SIZE; i++) {
      this.u8[CRAFT_REQUEST_OFFSET + i] = 0;
    }
    return str || null;
  }

  /** Write inventory JSON to shared memory (called each tick by Bun) */
  writeInventory(json: string): void {
    const seq = this.u32[INVENTORY_SEQ_OFFSET / 4] ?? 0;
    this.u32[INVENTORY_SEQ_OFFSET / 4] = seq + 1; // begin write (odd)

    const jsonBytes = new TextEncoder().encode(json);
    const len = Math.min(jsonBytes.length, INVENTORY_DATA_SIZE - 1);
    this.bytes.set(jsonBytes.subarray(0, len), INVENTORY_DATA_OFFSET);
    this.bytes[INVENTORY_DATA_OFFSET + len] = 0; // null-terminate

    this.u32[INVENTORY_SEQ_OFFSET / 4] = seq + 2; // end write (even)
  }
}

/** Parse the SHM_PATH line from Rust renderer stdout */
export function parseShmPath(line: string): string | null {
  if (line.startsWith("SHM_PATH:")) {
    return line.slice("SHM_PATH:".length).trim();
  }
  return null;
}
