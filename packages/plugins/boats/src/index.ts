// Boat buffer (SharedArrayBuffer protocol for sim → renderer)
export {
  BOAT_MAGIC, BOAT_VERSION, BOAT_HDR, BOAT_SECTION_HEADER_SIZE, BOAT_CELL_SIZE,
  MAX_BOATS, MAX_CELLS_PER_BOAT, BOAT_HEADER_SIZE, BOAT_SECTION_SIZE, BOAT_BUFFER_SIZE,
  packCell, unpackCellType, unpackCellRotation, unpackCellGridX, unpackCellGridZ,
  packCellY, packCellSizes, unpackCellSizeX, unpackCellSizeY, unpackCellSizeZ,
  unpackCellY, unpackCellYSizes, allocateBoatBuffer,
  BoatBufferWriter, BoatBufferReader,
} from "./boat-buffer.ts";

// Boat design types and schema
export type { BoatDesign, BoatDesignId, DesignFingerprint, Vec2, Vec3, Quat } from "./design/types.ts";
export { BOAT_DESIGN_SCHEMA_VERSION, BoatClass } from "./design/types.ts";
export { serializeDesign, deserializeDesign, cloneDesign, fingerprintDesign } from "./design/schema.ts";
export type { DesignMigration } from "./design/schema.ts";
