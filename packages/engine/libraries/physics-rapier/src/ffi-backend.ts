// ============================================================================
// ffi-backend.ts — RapierFfiBackend: RapierPhysicsBackend driven by the
// native Rapier cdylib (bun:ffi) instead of the WASM bundle.
//
// All JS-side bookkeeping (BodyState, contacts caching, PhysicsBody handles)
// is inherited unchanged — only the PhysicsLib transport differs.
// ============================================================================

import { RapierPhysicsBackend } from "./backend";
import { loadFfiPhysicsLib } from "./ffi-lib";

export { loadFfiPhysicsLib };

export class RapierFfiBackend extends RapierPhysicsBackend {
  override readonly name = "rapier-ffi";
  override readonly version = "0.1.0";

  constructor() {
    super(loadFfiPhysicsLib);
  }
}
