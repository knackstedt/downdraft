// Boat buffer (SharedArrayBuffer protocol for sim → renderer)
export { allocateBoatBuffer, BOAT_BUFFER_SIZE, BOAT_CELL_SIZE, BOAT_HDR, BOAT_HEADER_SIZE, BOAT_MAGIC, BOAT_SECTION_HEADER_SIZE, BOAT_SECTION_SIZE, BOAT_VERSION, BoatBufferReader, BoatBufferWriter, MAX_BOATS, MAX_CELLS_PER_BOAT, packCell, packCellSizes, packCellY, unpackCellGridX, unpackCellGridZ, unpackCellRotation, unpackCellSizeX, unpackCellSizeY, unpackCellSizeZ, unpackCellType, unpackCellY, unpackCellYSizes } from "./boat-buffer";

// Boat SAB Channel (defineChannel-based modern SAB framework)
export {
    BoatChannel, BOAT_BUFFER_SIZE as SAB_BOAT_BUFFER_SIZE, BOAT_CELL_SIZE as SAB_BOAT_CELL_SIZE, BOAT_HDR as SAB_BOAT_HDR, BOAT_HEADER_SIZE as SAB_BOAT_HEADER_SIZE,
    // Re-export all the same constants/types from the SAB version
    BOAT_MAGIC as SAB_BOAT_MAGIC, BOAT_SECTION_HEADER_SIZE as SAB_BOAT_SECTION_HEADER_SIZE, BOAT_SECTION_SIZE as SAB_BOAT_SECTION_SIZE, BOAT_VERSION as SAB_BOAT_VERSION, MAX_BOATS as SAB_MAX_BOATS,
    MAX_CELLS_PER_BOAT as SAB_MAX_CELLS_PER_BOAT, allocateBoatBuffer as sabAllocateBoatBuffer, BoatBufferReader as SabBoatBufferReader, BoatBufferWriter as SabBoatBufferWriter, packCell as sabPackCell, packCellSizes as sabPackCellSizes, packCellY as sabPackCellY, unpackCellGridX as sabUnpackCellGridX,
    unpackCellGridZ as sabUnpackCellGridZ, unpackCellRotation as sabUnpackCellRotation, unpackCellSizeX as sabUnpackCellSizeX,
    unpackCellSizeY as sabUnpackCellSizeY, unpackCellSizeZ as sabUnpackCellSizeZ, unpackCellType as sabUnpackCellType, unpackCellY as sabUnpackCellY, unpackCellYSizes as sabUnpackCellYSizes
} from "./boat-sab";

// Boat design types and schema
export { cloneDesign, deserializeDesign, fingerprintDesign, serializeDesign } from "./design/schema";
export type { DesignMigration } from "./design/schema";
export { BOAT_DESIGN_SCHEMA_VERSION, BoatClass } from "./design/types";
export type { BoatDesign, BoatDesignId, DesignFingerprint, Quat, Vec2, Vec3 } from "./design/types";

