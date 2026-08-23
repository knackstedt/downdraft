// ============================================================================
// Overburden — chunk persistence via OPFS (Origin Private File System)
//
// Saves modified (dirty) chunks to OPFS so they survive page reloads.
// Format: a single binary file with a header + one section per dirty chunk.
//
// File layout:
//   [u32 magic] [u32 version] [u32 chunkCount]
//   For each chunk:
//     [i32 cx] [i32 cy]
//     [foreground: CHUNK_CELLS * 2 bytes]
//     [background: CHUNK_CELLS * 2 bytes]
//     [mask:      CHUNK_CELLS * 1 byte]
//     [vfx:       CHUNK_CELLS * 4 bytes]
//     [light:     CHUNK_CELLS * 4 bytes]  (RGBA8 per cell)
//     [explored:  CHUNK_CELLS * 1 byte]
//
// The worker calls loadAll() on init to restore saved chunks, and saveDirty()
// periodically + on shutdown to persist changes.
// ============================================================================

import { CHUNK_CELLS } from "../shared/constants";
import type { Chunk } from "../shared/types";
import { createChunk } from "./chunk";

const SAVE_MAGIC = 0x4f424353; // "OBCS" = OverBurden Chunk Save
const SAVE_VERSION = 2; // v2: light plane is RGBA8 (4 bytes/cell), not 1 byte/cell
const HEADER_BYTES = 12; // magic(4) + version(4) + count(4)
const CHUNK_HEADER_BYTES = 8; // cx(4) + cy(4)
// Per-chunk payload: fg(2*CELLS) + bg(2*CELLS) + mask(1*CELLS) + vfx(4*CELLS) + light(4*CELLS) + explored(1*CELLS)
const CHUNK_PAYLOAD_BYTES = (2 + 2 + 1 + 4 + 4 + 1) * CHUNK_CELLS;
const CHUNK_RECORD_BYTES = CHUNK_HEADER_BYTES + CHUNK_PAYLOAD_BYTES;

const SAVE_FILE_NAME = "overburden-chunks.bin";

function getOpfsRoot(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}

/**
 * Load all saved chunks from OPFS.
 * Returns a Map keyed by "cx,cy" with chunk data (without generated/dirty flags).
 * Returns an empty map if no save file exists or if the format is invalid.
 */
export async function loadAllChunks(): Promise<Map<string, Chunk>> {
  const result = new Map<string, Chunk>();
  try {
    const root = await getOpfsRoot();
    const fileHandle = await root.getFileHandle(SAVE_FILE_NAME).catch(() => null);
    if (!fileHandle) return result;

    const file = await fileHandle.getFile();
    const buf = await file.arrayBuffer();
    if (buf.byteLength < HEADER_BYTES) return result;

    const dv = new DataView(buf);
    const magic = dv.getUint32(0, true);
    if (magic !== SAVE_MAGIC) return result;
    const version = dv.getUint32(4, true);
    if (version !== SAVE_VERSION) return result;
    const count = dv.getUint32(8, true);

    for (let i = 0; i < count; i++) {
      const offset = HEADER_BYTES + i * CHUNK_RECORD_BYTES;
      if (offset + CHUNK_RECORD_BYTES > buf.byteLength) break;
      const cx = dv.getInt32(offset, true);
      const cy = dv.getInt32(offset + 4, true);
      const payloadOffset = offset + CHUNK_HEADER_BYTES;

      const chunk = createChunk(cx, cy);
      // Copy plane data from the buffer
      const view = new Uint8Array(buf, payloadOffset, CHUNK_PAYLOAD_BYTES);
      let off = 0;
      new Uint8Array(chunk.foreground.buffer).set(view.subarray(off, off + CHUNK_CELLS * 2), 0);
      off += CHUNK_CELLS * 2;
      new Uint8Array(chunk.background.buffer).set(view.subarray(off, off + CHUNK_CELLS * 2), 0);
      off += CHUNK_CELLS * 2;
      chunk.mask.set(view.subarray(off, off + CHUNK_CELLS), 0);
      off += CHUNK_CELLS;
      new Uint8Array(chunk.vfx.buffer).set(view.subarray(off, off + CHUNK_CELLS * 4), 0);
      off += CHUNK_CELLS * 4;
      chunk.light.set(view.subarray(off, off + CHUNK_CELLS * 4), 0);
      off += CHUNK_CELLS * 4;
      chunk.explored.set(view.subarray(off, off + CHUNK_CELLS), 0);

      chunk.generated = true;
      chunk.dirty = false;
      result.set(`${cx},${cy}`, chunk);
    }
  } catch (e) {
    console.warn("[chunk-storage] loadAllChunks failed:", e);
  }
  return result;
}

/**
 * Save all dirty chunks to OPFS. Replaces the entire save file.
 * Only chunks with dirty=true are written; their dirty flag is cleared after saving.
 */
export async function saveDirtyChunks(chunks: Iterable<Chunk>): Promise<number> {
  // Collect dirty chunks
  const dirty: Chunk[] = [];
  for (const chunk of chunks) {
    if (chunk.dirty) {
      dirty.push(chunk);
      chunk.dirty = false;
    }
  }
  if (dirty.length === 0) return 0;

  try {
    const totalBytes = HEADER_BYTES + dirty.length * CHUNK_RECORD_BYTES;
    const buf = new ArrayBuffer(totalBytes);
    const dv = new DataView(buf);
    dv.setUint32(0, SAVE_MAGIC, true);
    dv.setUint32(4, SAVE_VERSION, true);
    dv.setUint32(8, dirty.length, true);

    for (let i = 0; i < dirty.length; i++) {
      const chunk = dirty[i];
      const offset = HEADER_BYTES + i * CHUNK_RECORD_BYTES;
      dv.setInt32(offset, chunk.cx, true);
      dv.setInt32(offset + 4, chunk.cy, true);

      const payloadOffset = offset + CHUNK_HEADER_BYTES;
      const view = new Uint8Array(buf, payloadOffset, CHUNK_PAYLOAD_BYTES);
      let off = 0;
      view.set(new Uint8Array(chunk.foreground.buffer), off);
      off += CHUNK_CELLS * 2;
      view.set(new Uint8Array(chunk.background.buffer), off);
      off += CHUNK_CELLS * 2;
      view.set(chunk.mask, off);
      off += CHUNK_CELLS;
      view.set(new Uint8Array(chunk.vfx.buffer), off);
      off += CHUNK_CELLS * 4;
      view.set(chunk.light, off);
      off += CHUNK_CELLS * 4;
      view.set(chunk.explored, off);
    }

    const root = await getOpfsRoot();
    const fileHandle = await root.getFileHandle(SAVE_FILE_NAME, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(buf);
    await writable.close();

    return dirty.length;
  } catch (e) {
    console.warn("[chunk-storage] saveDirtyChunks failed:", e);
    // Restore dirty flags since the save failed
    for (const chunk of dirty) chunk.dirty = true;
    return 0;
  }
}

/**
 * Delete the save file (for reset/new game).
 */
export async function deleteSave(): Promise<void> {
  try {
    const root = await getOpfsRoot();
    await root.removeEntry(SAVE_FILE_NAME).catch(() => {});
  } catch (e) {
    console.warn("[chunk-storage] deleteSave failed:", e);
  }
}
