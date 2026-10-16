use crate::world::PhysicsWorld;

pub fn step_realm(realm: &mut PhysicsWorld, dt: f32) -> i32 {
    realm.step(dt);
    0
}

pub fn set_integration_dt(realm: &mut PhysicsWorld, dt: f32) -> i32 {
    if dt.is_finite() && dt > 0.0 {
        realm.integration_params.dt = dt;
    }
    0
}

pub fn set_solver_iterations(realm: &mut PhysicsWorld, iterations: i32) -> i32 {
    realm.integration_params.num_solver_iterations = iterations.max(1) as usize;
    0
}

pub fn set_min_island_size(_realm: &mut PhysicsWorld, _size: i32) -> i32 {
    // rapier 0.22+ removed IntegrationParameters::min_island_size (islands
    // are single-rooted now); the FFI stays for ABI parity with the WASM
    // backend, where the setter still exists but is equally inert.
    0
}

/// Fused step + awake-state readback — one FFI call per tick replaces the
/// WASM path's step() + per-body scalar reads.
///
/// # Safety
/// `ids_out` must point to `max_count` i32s, `out` to `max_count * 10` f32s.
pub unsafe fn step_and_read_awake(
    realm: &mut PhysicsWorld,
    ids_out: *mut i32,
    out: *mut f32,
    max_count: usize,
) -> i32 {
    realm.step(0.0);
    realm.read_awake_states(ids_out, out, max_count) as i32
}

/// Standalone awake-state readback (no step).
///
/// # Safety
/// Same contract as `step_and_read_awake`.
pub unsafe fn read_awake(
    realm: &PhysicsWorld,
    ids_out: *mut i32,
    out: *mut f32,
    max_count: usize,
) -> i32 {
    realm.read_awake_states(ids_out, out, max_count) as i32
}
