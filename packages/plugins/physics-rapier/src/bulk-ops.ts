import type { PhysicsBackend } from "@downdraft/core";

/**
 * Bulk transform reader/writer for efficient FFI/WASM boundary crossing.
 *
 * Reads/writes pos+rot for all bodies in a realm in a single pass over
 * the raw body set, avoiding per-entity object creation.
 *
 * The transform buffer layout is `entityCount × 8` floats:
 *   [pos.x, pos.y, pos.z, rot.x, rot.y, rot.z, rot.w, pad]
 */

/**
 * Read all body transforms from a realm into a Float32Array in one pass.
 * Delegates to `PhysicsBackend.readTransforms` (one FFI call per realm).
 */
export function bulkReadTransforms(
  backend: PhysicsBackend,
  realmId: number,
  buffer: Float32Array,
  entityCount: number,
): void {
  backend.readTransforms(realmId, buffer, entityCount);
}

/**
 * Write transforms from a Float32Array into all bodies in a realm in one pass.
 * Delegates to `PhysicsBackend.syncTransforms` (one FFI call per realm).
 */
export function bulkWriteTransforms(
  backend: PhysicsBackend,
  realmId: number,
  buffer: Float32Array,
  entityCount: number,
): void {
  backend.syncTransforms(realmId, buffer, entityCount);
}

/**
 * Bulk read transforms for multiple realms into a shared buffer.
 * Each realm gets a contiguous slice of the buffer.
 *
 * Returns an array of { realmId, offset, count } for each realm read.
 */
export function bulkReadMultiRealm(
  backend: PhysicsBackend,
  realmIds: number[],
  buffer: Float32Array,
  maxEntitiesPerRealm: number,
): Array<{ realmId: number; offset: number; count: number }> {
  const results: Array<{ realmId: number; offset: number; count: number }> = [];
  let offset = 0;

  for (const realmId of realmIds) {
    const slice = buffer.subarray(offset, offset + maxEntitiesPerRealm * 8);
    // readTransforms writes into the buffer at the slice's offset;
    // but since it writes by entity index, we need a separate buffer per realm
    // or the backend must support offset-based writes.
    // For now, use a per-realm temp buffer and copy.
    const tempBuf = new Float32Array(maxEntitiesPerRealm * 8);
    backend.readTransforms(realmId, tempBuf, maxEntitiesPerRealm);
    buffer.set(tempBuf, offset);
    results.push({ realmId, offset, count: maxEntitiesPerRealm });
    offset += maxEntitiesPerRealm * 8;
  }

  return results;
}
