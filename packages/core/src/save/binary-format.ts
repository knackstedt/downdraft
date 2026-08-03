// ============================================================================
// Binary Save Format — uncompressed header + zstd-compressed body
// ============================================================================
//
// Header layout (46 bytes, little-endian):
//   Offset  Size  Field
//   0       4     Magic: 0xDD5A0001
//   4       2     Format version (header structure version)
//   6       4     Engine version hash (packed semver: major<<22 | minor<<12 | patch)
//   10      8     Timestamp (f64, Unix epoch seconds)
//   18      4     Entity count
//   22      4     Player count
//   26      16    XXH128 hash of uncompressed body
//   42      4     Uncompressed body length
//   46      ...   Zstd-compressed body (JSON)

export const SAVE_MAGIC = 0xdd5a0001;
export const SAVE_FORMAT_VERSION = 1;
export const HEADER_SIZE = 46;
export const XXH128_SIZE = 16;

// --- Engine version packing ---

export function packEngineVersion(major: number, minor: number, patch: number): number {
  return ((major & 0x3ff) << 22) | ((minor & 0x3ff) << 12) | (patch & 0xfff);
}

export function unpackEngineVersion(packed: number): { major: number; minor: number; patch: number } {
  return {
    major: (packed >>> 22) & 0x3ff,
    minor: (packed >>> 12) & 0x3ff,
    patch: packed & 0xfff,
  };
}

export function engineVersionString(packed: number): string {
  const v = unpackEngineVersion(packed);
  return `${v.major}.${v.minor}.${v.patch}`;
}

// --- Header encode/decode ---

export interface SaveHeader {
  magic: number;
  formatVersion: number;
  engineVersionPacked: number;
  timestamp: number;
  entityCount: number;
  playerCount: number;
  bodyHash: Uint8Array; // 16 bytes
  uncompressedBodyLength: number;
}

export function encodeHeader(header: SaveHeader): ArrayBuffer {
  const buf = new ArrayBuffer(HEADER_SIZE);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);

  view.setUint32(0, header.magic, true);
  view.setUint16(4, header.formatVersion, true);
  view.setUint32(6, header.engineVersionPacked, true);
  view.setFloat64(10, header.timestamp, true);
  view.setUint32(18, header.entityCount, true);
  view.setUint32(22, header.playerCount, true);

  // XXH128 hash (16 bytes at offset 26)
  u8.set(header.bodyHash.subarray(0, XXH128_SIZE), 26);

  view.setUint32(42, header.uncompressedBodyLength, true);

  return buf;
}

export function decodeHeader(buf: ArrayBuffer): SaveHeader | null {
  if (buf.byteLength < HEADER_SIZE) return null;

  const view = new DataView(buf);
  const magic = view.getUint32(0, true);
  if (magic !== SAVE_MAGIC) return null;

  const formatVersion = view.getUint16(4, true);
  if (formatVersion !== SAVE_FORMAT_VERSION) return null;

  const engineVersionPacked = view.getUint32(6, true);
  const timestamp = view.getFloat64(10, true);
  const entityCount = view.getUint32(18, true);
  const playerCount = view.getUint32(22, true);

  const u8 = new Uint8Array(buf);
  const bodyHash = u8.slice(26, 26 + XXH128_SIZE);

  const uncompressedBodyLength = view.getUint32(42, true);

  return {
    magic,
    formatVersion,
    engineVersionPacked,
    timestamp,
    entityCount,
    playerCount,
    bodyHash,
    uncompressedBodyLength,
  };
}

// --- Read header only from a file buffer (for listSaves without decompression) ---

export function readHeaderFromFile(fileBuffer: ArrayBuffer): SaveHeader | null {
  if (fileBuffer.byteLength < HEADER_SIZE) return null;
  return decodeHeader(fileBuffer.slice(0, HEADER_SIZE));
}
