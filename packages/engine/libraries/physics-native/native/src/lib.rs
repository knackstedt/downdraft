mod body;
mod character;
mod collider;
mod joint;
mod query;
mod realm;
mod step;
mod world;

use realm::RealmManager;
use std::os::raw::{c_int, c_uint};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Mutex;

// The manager is shared by every thread that dlopens this library. The Mutex
// makes that safe; per-call contention is negligible next to a physics step.
// Poisoned locks are recovered (into_inner) so a single panicked call does not
// wedge every subsequent FFI call.
static MANAGER: Mutex<Option<RealmManager>> = Mutex::new(None);

fn with_manager<R, F>(f: F) -> R
where
    F: FnOnce(&mut RealmManager) -> R,
{
    let mut guard = MANAGER.lock().unwrap_or_else(|e| e.into_inner());
    let manager = guard.get_or_insert_with(RealmManager::new);
    f(manager)
}

/// Run an FFI body with panic isolation — a Rust panic must never unwind
/// across the FFI boundary. Returns `default` on panic.
fn ffi<R, F>(default: R, f: F) -> R
where
    F: FnOnce() -> R,
{
    catch_unwind(AssertUnwindSafe(f)).unwrap_or(default)
}

// ── Realm ────────────────────────────────────────────────────────────────

#[no_mangle]
pub extern "C" fn dd_create_realm(id: c_int, gx: f32, gy: f32, gz: f32) -> c_int {
    ffi(-1, || with_manager(|m| m.create_realm(id, [gx, gy, gz])))
}

#[no_mangle]
pub extern "C" fn dd_destroy_realm(id: c_int) -> c_int {
    ffi(-1, || with_manager(|m| m.destroy_realm(id)))
}

// ── Body ─────────────────────────────────────────────────────────────────

/// Extended body create. `f`/`i` use the layout documented in body.rs.
///
/// # Safety
/// `f`/`i` must point to body::BODY_F32_LEN / BODY_I32_LEN elements.
#[no_mangle]
pub unsafe extern "C" fn dd_create_body(
    realm_id: c_int,
    body_id: c_int,
    f_ptr: *const f32,
    i_ptr: *const c_int,
) -> c_int {
    ffi(-1, || {
        let f = std::slice::from_raw_parts(f_ptr, body::BODY_F32_LEN);
        let i = std::slice::from_raw_parts(i_ptr, body::BODY_I32_LEN);
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => body::create_body(realm, body_id, f, i),
            None => -1,
        })
    })
}

#[no_mangle]
pub extern "C" fn dd_destroy_body(realm_id: c_int, body_id: c_int) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => body::destroy_body(realm, body_id),
            None => -1,
        })
    })
}

#[no_mangle]
pub extern "C" fn dd_set_body_type(realm_id: c_int, body_id: c_int, body_type: c_int) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => body::set_body_type(realm, body_id, body_type),
            None => -1,
        })
    })
}

#[no_mangle]
pub extern "C" fn dd_set_translation(
    realm_id: c_int,
    body_id: c_int,
    x: f32,
    y: f32,
    z: f32,
    wake: c_int,
) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => body::set_translation(realm, body_id, x, y, z, wake != 0),
            None => -1,
        })
    })
}

#[no_mangle]
pub extern "C" fn dd_set_rotation(
    realm_id: c_int,
    body_id: c_int,
    x: f32,
    y: f32,
    z: f32,
    w: f32,
    wake: c_int,
) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => body::set_rotation(realm, body_id, x, y, z, w, wake != 0),
            None => -1,
        })
    })
}

/// # Safety
/// `out` must point to ≥3 f32s.
#[no_mangle]
pub unsafe extern "C" fn dd_get_translation(
    realm_id: c_int,
    body_id: c_int,
    out: *mut f32,
) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => body::get_translation(realm, body_id, out),
            None => -1,
        })
    })
}

/// # Safety
/// `out` must point to ≥4 f32s.
#[no_mangle]
pub unsafe extern "C" fn dd_get_rotation(
    realm_id: c_int,
    body_id: c_int,
    out: *mut f32,
) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => body::get_rotation(realm, body_id, out),
            None => -1,
        })
    })
}

#[no_mangle]
pub extern "C" fn dd_set_linvel(
    realm_id: c_int,
    body_id: c_int,
    x: f32,
    y: f32,
    z: f32,
    wake: c_int,
) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => body::set_linvel(realm, body_id, x, y, z, wake != 0),
            None => -1,
        })
    })
}

#[no_mangle]
pub extern "C" fn dd_set_angvel(
    realm_id: c_int,
    body_id: c_int,
    x: f32,
    y: f32,
    z: f32,
    wake: c_int,
) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => body::set_angvel(realm, body_id, x, y, z, wake != 0),
            None => -1,
        })
    })
}

/// # Safety
/// `out` must point to ≥3 f32s.
#[no_mangle]
pub unsafe extern "C" fn dd_get_linvel(
    realm_id: c_int,
    body_id: c_int,
    out: *mut f32,
) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => body::get_linvel(realm, body_id, out),
            None => -1,
        })
    })
}

/// # Safety
/// `out` must point to ≥3 f32s.
#[no_mangle]
pub unsafe extern "C" fn dd_get_angvel(
    realm_id: c_int,
    body_id: c_int,
    out: *mut f32,
) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => body::get_angvel(realm, body_id, out),
            None => -1,
        })
    })
}

/// # Safety
/// `out` must point to ≥7 f32s (pos3 + quat4).
#[no_mangle]
pub unsafe extern "C" fn dd_get_body_transform(
    realm_id: c_int,
    body_id: c_int,
    out: *mut f32,
) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => body::get_body_transform(realm, body_id, out),
            None => -1,
        })
    })
}

#[no_mangle]
pub extern "C" fn dd_is_sleeping(realm_id: c_int, body_id: c_int) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => body::is_sleeping(realm, body_id),
            None => -1,
        })
    })
}

#[no_mangle]
pub extern "C" fn dd_wake_up(realm_id: c_int, body_id: c_int) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => body::wake_up(realm, body_id),
            None => -1,
        })
    })
}

#[no_mangle]
pub extern "C" fn dd_set_ccd(realm_id: c_int, body_id: c_int, enabled: c_int) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => body::set_ccd(realm, body_id, enabled != 0),
            None => -1,
        })
    })
}

// ── Forces / impulses ────────────────────────────────────────────────────

#[no_mangle]
pub extern "C" fn dd_apply_force(realm_id: c_int, body_id: c_int, x: f32, y: f32, z: f32) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => body::apply_force(realm, body_id, [x, y, z]),
            None => -1,
        })
    })
}

#[no_mangle]
pub extern "C" fn dd_apply_torque(realm_id: c_int, body_id: c_int, x: f32, y: f32, z: f32) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => body::apply_torque(realm, body_id, [x, y, z]),
            None => -1,
        })
    })
}

#[no_mangle]
pub extern "C" fn dd_apply_impulse(realm_id: c_int, body_id: c_int, x: f32, y: f32, z: f32) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => body::apply_impulse(realm, body_id, [x, y, z]),
            None => -1,
        })
    })
}

#[no_mangle]
pub extern "C" fn dd_apply_torque_impulse(
    realm_id: c_int,
    body_id: c_int,
    x: f32,
    y: f32,
    z: f32,
) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => body::apply_torque_impulse(realm, body_id, [x, y, z]),
            None => -1,
        })
    })
}

#[no_mangle]
pub extern "C" fn dd_apply_impulse_at_point(
    realm_id: c_int,
    body_id: c_int,
    ix: f32,
    iy: f32,
    iz: f32,
    px: f32,
    py: f32,
    pz: f32,
) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => body::apply_impulse_at_point(realm, body_id, [ix, iy, iz], [px, py, pz]),
            None => -1,
        })
    })
}

/// Batched state write — 13 floats per body [pos3, quat4, linvel3, angvel3].
///
/// # Safety
/// `ids` ≥ count i32s, `states` ≥ count*13 f32s.
#[no_mangle]
pub unsafe extern "C" fn dd_apply_body_writes(
    realm_id: c_int,
    ids: *const c_int,
    states: *const f32,
    count: usize,
    wake: c_int,
) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => body::apply_body_writes(realm, ids, states, count, wake != 0),
            None => -1,
        })
    })
}

/// Batched impulse apply — 6 floats per body [lin3, ang3].
///
/// # Safety
/// `ids` ≥ count i32s, `impulses` ≥ count*6 f32s.
#[no_mangle]
pub unsafe extern "C" fn dd_apply_impulses(
    realm_id: c_int,
    ids: *const c_int,
    impulses: *const f32,
    count: usize,
) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => body::apply_impulses(realm, ids, impulses, count),
            None => -1,
        })
    })
}

// ── Colliders ────────────────────────────────────────────────────────────

/// Generic collider add — meta/f/verts/indices layouts in collider.rs.
///
/// # Safety
/// Pointers must describe the documented layouts.
#[no_mangle]
pub unsafe extern "C" fn dd_add_collider(
    realm_id: c_int,
    body_id: c_int,
    collider_id: c_int,
    meta: *const c_int,
    f: *const f32,
    verts: *const f32,
    indices: *const c_uint,
) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => collider::add_collider(realm, body_id, collider_id, meta, f, verts, indices),
            None => -1,
        })
    })
}

#[no_mangle]
pub extern "C" fn dd_remove_collider(realm_id: c_int, collider_id: c_int) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => collider::remove_collider(realm, collider_id),
            None => -1,
        })
    })
}

/// # Safety
/// `verts`/`indices` describe a trimesh.
#[no_mangle]
pub unsafe extern "C" fn dd_swap_collider_shape(
    realm_id: c_int,
    collider_id: c_int,
    verts: *const f32,
    n_verts: usize,
    indices: *const c_uint,
    n_indices: usize,
) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => collider::swap_collider_shape(realm, collider_id, verts, n_verts, indices, n_indices),
            None => -1,
        })
    })
}

#[no_mangle]
pub extern "C" fn dd_set_collider_position(
    realm_id: c_int,
    collider_id: c_int,
    x: f32,
    y: f32,
    z: f32,
) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => collider::set_collider_position(realm, collider_id, x, y, z),
            None => -1,
        })
    })
}

/// # Safety
/// `out` ≥ 3 f32s.
#[no_mangle]
pub unsafe extern "C" fn dd_get_collider_position(
    realm_id: c_int,
    collider_id: c_int,
    out: *mut f32,
) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => collider::get_collider_position(realm, collider_id, out),
            None => -1,
        })
    })
}

#[no_mangle]
pub extern "C" fn dd_collider_shape_type(realm_id: c_int, collider_id: c_int) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => collider::collider_shape_type(realm, collider_id),
            None => -1,
        })
    })
}

#[no_mangle]
pub extern "C" fn dd_collider_count(realm_id: c_int, body_id: c_int) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => collider::collider_count(realm, body_id),
            None => -1,
        })
    })
}

/// # Safety
/// `verts` ≥ n_verts*3 f32s.
#[no_mangle]
pub unsafe extern "C" fn dd_test_convex_hull(verts: *const f32, n_verts: usize) -> c_int {
    ffi(-1, || collider::test_convex_hull(verts, n_verts))
}

// ── Stepping / bulk readback ─────────────────────────────────────────────

#[no_mangle]
pub extern "C" fn dd_step(realm_id: c_int, dt: f32) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => step::step_realm(realm, dt),
            None => -1,
        })
    })
}

#[no_mangle]
pub extern "C" fn dd_set_integration_dt(realm_id: c_int, dt: f32) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => step::set_integration_dt(realm, dt),
            None => -1,
        })
    })
}

#[no_mangle]
pub extern "C" fn dd_set_solver_iterations(realm_id: c_int, iterations: c_int) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => step::set_solver_iterations(realm, iterations),
            None => -1,
        })
    })
}

#[no_mangle]
pub extern "C" fn dd_set_min_island_size(realm_id: c_int, size: c_int) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => step::set_min_island_size(realm, size),
            None => -1,
        })
    })
}

/// Fused step + awake readback. Writes per awake body: ids_out[i]=body_id,
/// out[i*10..+9]=[pos3, quat4, linvel3]. Returns count.
///
/// # Safety
/// `ids_out` ≥ max_count i32s, `out` ≥ max_count*10 f32s.
#[no_mangle]
pub unsafe extern "C" fn dd_step_and_read_awake(
    realm_id: c_int,
    dt: f32,
    ids_out: *mut c_int,
    out: *mut f32,
    max_count: usize,
) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => {
                if dt > 0.0 {
                    realm.integration_params.dt = dt;
                }
                step::step_and_read_awake(realm, ids_out, out, max_count)
            }
            None => -1,
        })
    })
}

/// Standalone awake-state readback (no step).
///
/// # Safety
/// Same contract as dd_step_and_read_awake.
#[no_mangle]
pub unsafe extern "C" fn dd_read_awake(
    realm_id: c_int,
    ids_out: *mut c_int,
    out: *mut f32,
    max_count: usize,
) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => step::read_awake(realm, ids_out, out, max_count),
            None => -1,
        })
    })
}

// ── Queries ──────────────────────────────────────────────────────────────

/// # Safety
/// `out` ≥ 8 f32s.
#[no_mangle]
pub unsafe extern "C" fn dd_raycast(
    realm_id: c_int,
    ox: f32,
    oy: f32,
    oz: f32,
    dx: f32,
    dy: f32,
    dz: f32,
    max_dist: f32,
    groups: c_uint,
    exclude_body: c_int,
    out: *mut f32,
) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => query::raycast(realm, [ox, oy, oz], [dx, dy, dz], max_dist, groups, exclude_body, out),
            None => -1,
        })
    })
}

/// # Safety
/// `shape_f` ≥ 13 f32s, `out` ≥ 8 f32s.
#[no_mangle]
pub unsafe extern "C" fn dd_shape_cast(
    realm_id: c_int,
    shape_type: c_int,
    shape_f: *const f32,
    max_dist: f32,
    groups: c_uint,
    exclude_body: c_int,
    out: *mut f32,
) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => query::shape_cast(realm, shape_type, shape_f, max_dist, groups, exclude_body, out),
            None => -1,
        })
    })
}

/// Contact extraction. out_i[3k]=[bodyA, bodyB, nPoints],
/// out_f[4k]=[nx,ny,nz,penetration], out_pts[12k]=up to 4 world points.
///
/// # Safety
/// `out_i` ≥ max*3, `out_f` ≥ max*4, `out_pts` ≥ max*12.
#[no_mangle]
pub unsafe extern "C" fn dd_get_contacts(
    realm_id: c_int,
    out_i: *mut c_int,
    out_f: *mut f32,
    out_pts: *mut f32,
    max_pairs: usize,
) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => query::get_contacts(realm, out_i, out_f, out_pts, max_pairs),
            None => -1,
        })
    })
}

/// Intersection (sensor) pairs. out_i[2k]=[bodyA, bodyB].
///
/// # Safety
/// `out_i` ≥ max*2.
#[no_mangle]
pub unsafe extern "C" fn dd_get_intersections(
    realm_id: c_int,
    out_i: *mut c_int,
    max_pairs: usize,
) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => query::get_intersections(realm, out_i, max_pairs),
            None => -1,
        })
    })
}

// ── Character controller ─────────────────────────────────────────────────

/// # Safety
/// `f`/`i` use the layouts documented in character.rs.
#[no_mangle]
pub unsafe extern "C" fn dd_char_create(
    realm_id: c_int,
    ctrl_id: c_int,
    f: *const f32,
    i: *const c_int,
) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => character::create(realm, ctrl_id, f, i),
            None => -1,
        })
    })
}

#[no_mangle]
pub extern "C" fn dd_char_destroy(realm_id: c_int, ctrl_id: c_int) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => character::destroy(realm, ctrl_id),
            None => -1,
        })
    })
}

#[no_mangle]
pub extern "C" fn dd_char_set_collider_pos(
    realm_id: c_int,
    ctrl_id: c_int,
    x: f32,
    y: f32,
    z: f32,
) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => character::set_collider_position(realm, ctrl_id, x, y, z),
            None => -1,
        })
    })
}

/// # Safety
/// `out_f` ≥ 5 f32s, `out_i` ≥ 1+max_coll i32s.
#[no_mangle]
pub unsafe extern "C" fn dd_char_move(
    realm_id: c_int,
    ctrl_id: c_int,
    dx: f32,
    dy: f32,
    dz: f32,
    dt: f32,
    out_f: *mut f32,
    out_i: *mut c_int,
    max_coll: usize,
) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => character::char_move(realm, ctrl_id, dx, dy, dz, dt, out_f, out_i, max_coll),
            None => -1,
        })
    })
}

// ── Joints ───────────────────────────────────────────────────────────────

/// # Safety
/// `f` ≥ joint::JOINT_F32_LEN f32s.
#[no_mangle]
pub unsafe extern "C" fn dd_create_joint(
    realm_id: c_int,
    joint_id: c_int,
    parent_body_id: c_int,
    child_body_id: c_int,
    jtype: c_int,
    f: *const f32,
) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => joint::create_joint(realm, joint_id, parent_body_id, child_body_id, jtype, f),
            None => -1,
        })
    })
}

#[no_mangle]
pub extern "C" fn dd_destroy_joint(realm_id: c_int, joint_id: c_int) -> c_int {
    ffi(-1, || {
        with_manager(|m| match m.get_realm(realm_id) {
            Some(realm) => joint::destroy_joint(realm, joint_id),
            None => -1,
        })
    })
}

// ── Lifecycle ────────────────────────────────────────────────────────────

#[no_mangle]
pub extern "C" fn dd_destroy() -> c_int {
    ffi(-1, || {
        with_manager(|m| {
            m.destroy_all();
            0
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gravity_integrates() {
        let mut w = world::PhysicsWorld::new([0.0, -9.81, 0.0]);
        let f = [0f32, 10.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0];
        let i = [2i32, (1 << 1) | (1 << 9)];
        assert_eq!(body::create_body(&mut w, 7, &f, &i), 0);
        w.step(1.0 / 60.0);
        w.step(1.0 / 60.0);
        let out = [0f32; 3];
        let o = out.as_ptr() as *mut f32;
        unsafe {
            body::get_linvel(&w, 7, o);
            let v = std::slice::from_raw_parts(o, 3);
            println!("linvel {:?}", v);
            assert!(v[1] < -0.3, "expected vy < -0.3, got {}", v[1]);
        }
    }
}

#[cfg(test)]
mod raw_tests {
    use rapier3d::prelude::*;

    #[test]
    fn raw_rapier_gravity() {
        let mut pipeline = PhysicsPipeline::new();
        let mut islands = IslandManager::new();
        let mut broad = DefaultBroadPhase::new();
        let mut narrow = NarrowPhase::new();
        let mut bodies = RigidBodySet::new();
        let mut colliders = ColliderSet::new();
        let mut joints = ImpulseJointSet::new();
        let mut mb = MultibodyJointSet::new();
        let mut ccd = CCDSolver::new();
        let mut qp = QueryPipeline::new();
        let gravity = vector![0.0, -9.81, 0.0];
        let params = IntegrationParameters::default();

        let rb = RigidBodyBuilder::dynamic()
            .translation(vector![0.0, 10.0, 0.0])
            .additional_mass(1.0)
            .build();
        let h = bodies.insert(rb);

        pipeline.step(&gravity, &params, &mut islands, &mut broad, &mut narrow,
            &mut bodies, &mut colliders, &mut joints, &mut mb, &mut ccd,
            Some(&mut qp), &(), &());
        pipeline.step(&gravity, &params, &mut islands, &mut broad, &mut narrow,
            &mut bodies, &mut colliders, &mut joints, &mut mb, &mut ccd,
            Some(&mut qp), &(), &());
        println!("linvel {:?}", bodies.get(h).unwrap().linvel());
        assert!(bodies.get(h).unwrap().linvel().y < -0.3);
    }
}
