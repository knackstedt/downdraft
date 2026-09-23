export { UniversalPhysicsAPI } from "./api";
export { RapierPhysicsBackend } from "./backend";
export { bulkReadMultiRealm, bulkReadTransforms, bulkWriteTransforms } from "./bulk-ops";
// Native FFI backend intentionally not re-exported here — ffi-lib.ts pulls
// @downdraft/platform-native, which must stay out of Electron/web bundles.
// Native code imports "@downdraft/engine/libraries/physics-rapier/ffi-backend".

// Declarative library descriptor
export { PhysicsAPITok, PhysicsRapierLib } from "./library";
export type { PhysicsRapierLibConfig } from "./library";

