/// Cross-process shared memory IPC for Bun <-> Rust native-renderer.
/// Uses Bun.mmap to memory-map a file created by the Rust binary.

// Shared memory layout (must match native-renderer/src/ipc.rs)
export const SHM_SIZE = 4096;
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
export const RENDER_MAX_ENTITIES = 64;
export const RENDER_ENTITY_STRIDE = 28;  // type(4) + pos(12) + color(12) = 28 bytes

export enum RenderEntityType {
  Player = 0,
  Ship = 1,
  Shark = 2,
  Fish = 3,
  Debris = 4,
  Water = 5,
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

  /** Attach to an existing shared memory file created by the Rust renderer */
  attach(path: string): boolean {
    try {
      this.bytes = Bun.mmap(path);
      if (this.bytes.length < SHM_SIZE) {
        console.error(
          `[ipc] Mapped file too small: ${this.bytes.length} < ${SHM_SIZE}`,
        );
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
      return true;
    } catch (e) {
      console.error("[ipc] Failed to mmap shared memory file:", path, e);
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
}

/** Parse the SHM_PATH line from Rust renderer stdout */
export function parseShmPath(line: string): string | null {
  if (line.startsWith("SHM_PATH:")) {
    return line.slice("SHM_PATH:".length).trim();
  }
  return null;
}
