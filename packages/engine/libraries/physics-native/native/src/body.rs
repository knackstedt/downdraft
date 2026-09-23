use rapier3d::na::{Quaternion, UnitQuaternion};
use rapier3d::prelude::*;
use crate::world::PhysicsWorld;

// ── dd_create_body descriptor layout ─────────────────────────────────────
// f[0..3]  position xyz        f[3..7]  rotation quat (x,y,z,w)
// f[7..10] linear velocity     f[10..13] angular velocity
// f[13]    mass (additional)   f[14]    linear damping
// f[15]    angular damping     f[16]    gravity scale
// i[0]     body type: 0=fixed, 1=kinematic(position), 2=dynamic
// i[1]     flags:
//   bit0  ccdEnabled
//   bit1  canSleep (1 = can sleep; mirrors WASM `canSleep === false` opt-out)
//   bit2  sleeping (start asleep)
//   bit3..5  locked translations x,y,z
//   bit6..8  locked rotations x,y,z
//   bit9   has mass        bit10 has linearDamping
//   bit11  has angularDamping  bit12 has gravityScale
pub const BODY_F32_LEN: usize = 17;
pub const BODY_I32_LEN: usize = 2;

pub fn create_body(
    realm: &mut PhysicsWorld,
    body_id: i32,
    f: &[f32],
    i: &[i32],
) -> i32 {
    let transform = Isometry::from_parts(
        Translation::new(f[0], f[1], f[2]),
        UnitQuaternion::from_quaternion(Quaternion::new(f[6], f[3], f[4], f[5])),
    );

    let body_type = i[0];
    let flags = i[1];
    let rb_type = match body_type {
        0 => RigidBodyType::Fixed,
        1 => RigidBodyType::KinematicPositionBased,
        _ => RigidBodyType::Dynamic,
    };

    let mut builder = RigidBodyBuilder::new(rb_type)
        .position(transform)
        .linvel(Vector::new(f[7], f[8], f[9]))
        .angvel(Vector::new(f[10], f[11], f[12]));

    if flags & (1 << 9) != 0 {
        builder = builder.additional_mass(f[13]);
    }
    if flags & (1 << 10) != 0 {
        builder = builder.linear_damping(f[14]);
    }
    if flags & (1 << 11) != 0 {
        builder = builder.angular_damping(f[15]);
    }
    if flags & (1 << 12) != 0 {
        builder = builder.gravity_scale(f[16]);
    }
    if flags & 1 != 0 {
        builder = builder.ccd_enabled(true);
    }
    if flags & (1 << 1) == 0 {
        builder = builder.can_sleep(false);
    }
    if flags & (1 << 2) != 0 {
        builder = builder.sleeping(true);
    }
    let lock_t = [
        flags & (1 << 3) != 0,
        flags & (1 << 4) != 0,
        flags & (1 << 5) != 0,
    ];
    if lock_t.iter().any(|b| *b) {
        builder = builder.enabled_translations(!lock_t[0], !lock_t[1], !lock_t[2]);
    }
    let lock_r = [
        flags & (1 << 6) != 0,
        flags & (1 << 7) != 0,
        flags & (1 << 8) != 0,
    ];
    if lock_r.iter().all(|b| *b) {
        builder = builder.lock_rotations();
    } else if lock_r.iter().any(|b| *b) {
        builder = builder.enabled_rotations(!lock_r[0], !lock_r[1], !lock_r[2]);
    }

    let handle = realm.bodies.insert(builder);
    realm.body_map.insert(body_id, handle);
    realm.body_id_by_handle.insert(handle, body_id);
    0
}

pub fn destroy_body(realm: &mut PhysicsWorld, body_id: i32) -> i32 {
    if let Some(handle) = realm.body_map.remove(&body_id) {
        realm.body_id_by_handle.remove(&handle);
        // Drop controllers bound to this body so they can't dangle.
        realm
            .controller_map
            .retain(|_, c| c.body != Some(handle));
        realm.bodies.remove(
            handle,
            &mut realm.island_manager,
            &mut realm.colliders,
            &mut realm.impulse_joints,
            &mut realm.multibody_joints,
            true,
        );
    }
    0
}

pub fn set_body_type(realm: &mut PhysicsWorld, body_id: i32, body_type: i32) -> i32 {
    if let Some(&handle) = realm.body_map.get(&body_id) {
        if let Some(body) = realm.bodies.get_mut(handle) {
            let rb_type = match body_type {
                0 => RigidBodyType::Fixed,
                1 => RigidBodyType::KinematicPositionBased,
                _ => RigidBodyType::Dynamic,
            };
            body.set_body_type(rb_type, true);
        }
    }
    0
}

fn body<'a>(realm: &'a mut PhysicsWorld, body_id: i32) -> Option<&'a mut RigidBody> {
    let &handle = realm.body_map.get(&body_id)?;
    realm.bodies.get_mut(handle)
}

fn body_ref<'a>(realm: &'a PhysicsWorld, body_id: i32) -> Option<&'a RigidBody> {
    let &handle = realm.body_map.get(&body_id)?;
    realm.bodies.get(handle)
}

pub fn set_translation(realm: &mut PhysicsWorld, body_id: i32, x: f32, y: f32, z: f32, wake: bool) -> i32 {
    if let Some(b) = body(realm, body_id) {
        b.set_translation(Vector::new(x, y, z), wake);
    }
    0
}

pub fn set_rotation(realm: &mut PhysicsWorld, body_id: i32, x: f32, y: f32, z: f32, w: f32, wake: bool) -> i32 {
    if let Some(b) = body(realm, body_id) {
        b.set_rotation(UnitQuaternion::from_quaternion(Quaternion::new(w, x, y, z)), wake);
    }
    0
}

/// # Safety
/// `out` must point to at least 3 f32s.
pub unsafe fn get_translation(realm: &PhysicsWorld, body_id: i32, out: *mut f32) -> i32 {
    let o = std::slice::from_raw_parts_mut(out, 3);
    match body_ref(realm, body_id) {
        Some(b) => {
            let t = b.translation();
            o[0] = t.x;
            o[1] = t.y;
            o[2] = t.z;
        }
        None => {
            o[0] = 0.0;
            o[1] = 0.0;
            o[2] = 0.0;
        }
    }
    0
}

/// # Safety
/// `out` must point to at least 4 f32s.
pub unsafe fn get_rotation(realm: &PhysicsWorld, body_id: i32, out: *mut f32) -> i32 {
    let o = std::slice::from_raw_parts_mut(out, 4);
    match body_ref(realm, body_id) {
        Some(b) => {
            let r = b.rotation().quaternion();
            o[0] = r.i;
            o[1] = r.j;
            o[2] = r.k;
            o[3] = r.w;
        }
        None => {
            o[0] = 0.0;
            o[1] = 0.0;
            o[2] = 0.0;
            o[3] = 1.0;
        }
    }
    0
}

pub fn set_linvel(realm: &mut PhysicsWorld, body_id: i32, x: f32, y: f32, z: f32, wake: bool) -> i32 {
    if let Some(b) = body(realm, body_id) {
        b.set_linvel(Vector::new(x, y, z), wake);
    }
    0
}

pub fn set_angvel(realm: &mut PhysicsWorld, body_id: i32, x: f32, y: f32, z: f32, wake: bool) -> i32 {
    if let Some(b) = body(realm, body_id) {
        b.set_angvel(Vector::new(x, y, z), wake);
    }
    0
}

/// # Safety
/// `out` must point to at least 3 f32s.
pub unsafe fn get_linvel(realm: &PhysicsWorld, body_id: i32, out: *mut f32) -> i32 {
    let o = std::slice::from_raw_parts_mut(out, 3);
    match body_ref(realm, body_id) {
        Some(b) => {
            let v = b.linvel();
            o[0] = v.x;
            o[1] = v.y;
            o[2] = v.z;
        }
        None => {
            o[0] = 0.0;
            o[1] = 0.0;
            o[2] = 0.0;
        }
    }
    0
}

/// # Safety
/// `out` must point to at least 3 f32s.
pub unsafe fn get_angvel(realm: &PhysicsWorld, body_id: i32, out: *mut f32) -> i32 {
    let o = std::slice::from_raw_parts_mut(out, 3);
    match body_ref(realm, body_id) {
        Some(b) => {
            let v = b.angvel();
            o[0] = v.x;
            o[1] = v.y;
            o[2] = v.z;
        }
        None => {
            o[0] = 0.0;
            o[1] = 0.0;
            o[2] = 0.0;
        }
    }
    0
}

/// # Safety
/// `out` must point to at least 7 f32s (pos3 + quat4).
pub unsafe fn get_body_transform(realm: &PhysicsWorld, body_id: i32, out: *mut f32) -> i32 {
    let o = std::slice::from_raw_parts_mut(out, 7);
    match body_ref(realm, body_id) {
        Some(b) => {
            let t = b.translation();
            let r = b.rotation().quaternion();
            o[0] = t.x;
            o[1] = t.y;
            o[2] = t.z;
            o[3] = r.i;
            o[4] = r.j;
            o[5] = r.k;
            o[6] = r.w;
            1
        }
        None => 0,
    }
}

pub fn is_sleeping(realm: &PhysicsWorld, body_id: i32) -> i32 {
    match body_ref(realm, body_id) {
        Some(b) => b.is_sleeping() as i32,
        None => 0,
    }
}

pub fn wake_up(realm: &mut PhysicsWorld, body_id: i32) -> i32 {
    if let Some(&handle) = realm.body_map.get(&body_id) {
        realm.island_manager.wake_up(&mut realm.bodies, handle, true);
    }
    0
}

pub fn set_ccd(realm: &mut PhysicsWorld, body_id: i32, enabled: bool) -> i32 {
    if let Some(b) = body(realm, body_id) {
        b.enable_ccd(enabled);
    }
    0
}

// ── Forces / impulses ────────────────────────────────────────────────────

pub fn apply_force(realm: &mut PhysicsWorld, body_id: i32, f: [f32; 3]) -> i32 {
    if let Some(b) = body(realm, body_id) {
        b.add_force(Vector::new(f[0], f[1], f[2]), true);
    }
    0
}

pub fn apply_torque(realm: &mut PhysicsWorld, body_id: i32, f: [f32; 3]) -> i32 {
    if let Some(b) = body(realm, body_id) {
        b.add_torque(Vector::new(f[0], f[1], f[2]), true);
    }
    0
}

pub fn apply_impulse(realm: &mut PhysicsWorld, body_id: i32, f: [f32; 3]) -> i32 {
    if let Some(b) = body(realm, body_id) {
        b.apply_impulse(Vector::new(f[0], f[1], f[2]), true);
    }
    0
}

pub fn apply_torque_impulse(realm: &mut PhysicsWorld, body_id: i32, f: [f32; 3]) -> i32 {
    if let Some(b) = body(realm, body_id) {
        b.apply_torque_impulse(Vector::new(f[0], f[1], f[2]), true);
    }
    0
}

pub fn apply_impulse_at_point(
    realm: &mut PhysicsWorld,
    body_id: i32,
    impulse: [f32; 3],
    point: [f32; 3],
) -> i32 {
    if let Some(b) = body(realm, body_id) {
        b.apply_impulse_at_point(
            Vector::new(impulse[0], impulse[1], impulse[2]),
            Point::new(point[0], point[1], point[2]),
            true,
        );
    }
    0
}

/// Batched state write — the plan's `applyBodyWrites`.
/// `states` holds 13 floats per body: [pos3, quat4, linvel3, angvel3].
///
/// # Safety
/// `ids` must point to `count` i32s, `states` to `count * 13` f32s.
pub unsafe fn apply_body_writes(
    realm: &mut PhysicsWorld,
    ids: *const i32,
    states: *const f32,
    count: usize,
    wake: bool,
) -> i32 {
    let id_slice = std::slice::from_raw_parts(ids, count);
    let state_slice = std::slice::from_raw_parts(states, count * 13);
    for (i, &body_id) in id_slice.iter().enumerate() {
        let o = i * 13;
        if let Some(b) = body(realm, body_id) {
            b.set_translation(
                Vector::new(state_slice[o], state_slice[o + 1], state_slice[o + 2]),
                wake,
            );
            b.set_rotation(
                UnitQuaternion::from_quaternion(Quaternion::new(
                    state_slice[o + 6],
                    state_slice[o + 3],
                    state_slice[o + 4],
                    state_slice[o + 5],
                )),
                wake,
            );
            b.set_linvel(
                Vector::new(state_slice[o + 7], state_slice[o + 8], state_slice[o + 9]),
                wake,
            );
            b.set_angvel(
                Vector::new(state_slice[o + 10], state_slice[o + 11], state_slice[o + 12]),
                wake,
            );
        }
    }
    0
}

/// Batched impulse application — the plan's `applyImpulses`.
/// `impulses` holds 6 floats per body: [lin3, ang3].
///
/// # Safety
/// `ids` must point to `count` i32s, `impulses` to `count * 6` f32s.
pub unsafe fn apply_impulses(
    realm: &mut PhysicsWorld,
    ids: *const i32,
    impulses: *const f32,
    count: usize,
) -> i32 {
    let id_slice = std::slice::from_raw_parts(ids, count);
    let imp_slice = std::slice::from_raw_parts(impulses, count * 6);
    for (i, &body_id) in id_slice.iter().enumerate() {
        let o = i * 6;
        if let Some(b) = body(realm, body_id) {
            let lin = Vector::new(imp_slice[o], imp_slice[o + 1], imp_slice[o + 2]);
            let ang = Vector::new(imp_slice[o + 3], imp_slice[o + 4], imp_slice[o + 5]);
            if lin.norm_squared() > 0.0 {
                b.apply_impulse(lin, true);
            }
            if ang.norm_squared() > 0.0 {
                b.apply_torque_impulse(ang, true);
            }
        }
    }
    0
}
