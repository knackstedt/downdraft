use rapier3d::control::{
    CharacterAutostep, CharacterCollision, CharacterLength, KinematicCharacterController,
};
use rapier3d::na::{Quaternion, UnitQuaternion};
use rapier3d::prelude::*;
use crate::world::{CharController, PhysicsWorld};

// ── dd_char_create descriptor layout ─────────────────────────────────────
// f: [offset, radius, halfHeight, maxSlope, minSlopeSlide, snapToGround,
//     autostepMinW, autostepMaxH, posX, posY, posZ]
// i: [slide, autostepEnabled, applyImpulses, parentless, collGroups, bodyId]
pub const CHAR_F32_LEN: usize = 11;
pub const CHAR_I32_LEN: usize = 6;

/// # Safety
/// `f`/`i` must point to CHAR_F32_LEN / CHAR_I32_LEN elements.
pub unsafe fn create(
    realm: &mut PhysicsWorld,
    ctrl_id: i32,
    f: *const f32,
    i: *const i32,
) -> i32 {
    let f = std::slice::from_raw_parts(f, CHAR_F32_LEN);
    let i = std::slice::from_raw_parts(i, CHAR_I32_LEN);

    let controller = KinematicCharacterController {
        // WASM parity: world.createCharacterController(desc.offset[1]) uses an
        // absolute gap offset (padding), not capsule half-height.
        offset: CharacterLength::Absolute(f[0]),
        slide: i[0] != 0,
        autostep: if i[1] != 0 {
            Some(CharacterAutostep {
                min_width: CharacterLength::Relative(f[6]),
                max_height: CharacterLength::Absolute(f[7]),
                include_dynamic_bodies: false,
            })
        } else {
            None
        },
        max_slope_climb_angle: f[3],
        min_slope_slide_angle: f[4],
        snap_to_ground: if f[5] > 0.0 {
            Some(CharacterLength::Absolute(f[5]))
        } else {
            None
        },
        ..Default::default()
    };
    // Not part of move_shape in 0.22 — applied via solve_character_collision_impulses.
    let apply_impulses = i[2] != 0;

    let entry = if i[3] != 0 {
        // Parentless capsule collider (no rigid body).
        let mut builder = ColliderBuilder::capsule_y(f[2], f[1]);
        if i[4] != 0 {
            builder = builder.collision_groups(InteractionGroups::new(
                Group::from_bits_truncate((i[4] as u32) >> 16),
                Group::from_bits_truncate((i[4] as u32) & 0xffff),
            ));
        }
        let mut collider = builder.build();
        collider.set_position(Isometry::from_parts(
            Translation::new(f[8], f[9], f[10]),
            UnitQuaternion::from_quaternion(Quaternion::identity()),
        ));
        let handle = realm.colliders.insert(collider);
        CharController {
            controller,
            body: None,
            collider: Some(handle),
        }
    } else {
        let body_id = i[5];
        let Some(&body_handle) = realm.body_map.get(&body_id) else {
            return -1;
        };
        CharController {
            controller,
            body: Some(body_handle),
            collider: None,
        }
    };
    realm.controller_map.insert(ctrl_id, entry);
    if apply_impulses {
        realm.impulse_controllers.insert(ctrl_id);
    }
    0
}

pub fn destroy(realm: &mut PhysicsWorld, ctrl_id: i32) -> i32 {
    if let Some(entry) = realm.controller_map.remove(&ctrl_id) {
        if let Some(ch) = entry.collider {
            realm.colliders.remove(
                ch,
                &mut realm.island_manager,
                &mut realm.bodies,
                true,
            );
        }
    }
    realm.impulse_controllers.remove(&ctrl_id);
    0
}

pub fn set_collider_position(
    realm: &mut PhysicsWorld,
    ctrl_id: i32,
    x: f32,
    y: f32,
    z: f32,
) -> i32 {
    if let Some(entry) = realm.controller_map.get(&ctrl_id) {
        if let Some(ch) = entry.collider {
            if let Some(c) = realm.colliders.get_mut(ch) {
                c.set_translation(Vector::new(x, y, z));
            }
        }
    }
    0
}

/// Compute the character's movement against the world.
/// out_f: [grounded, ex, ey, ez, sliding]
/// out_i: [groundBodyId, collBody0, collBody1, ...] (up to max_coll hits)
/// Returns the number of colliding-body ids written to out_i[1..], or
/// -1 when the controller/collider is missing.
///
/// # Safety
/// `out_f` ≥ 5 f32s, `out_i` ≥ (1 + max_coll) i32s.
pub unsafe fn char_move(
    realm: &mut PhysicsWorld,
    ctrl_id: i32,
    dx: f32,
    dy: f32,
    dz: f32,
    _dt: f32,
    out_f: *mut f32,
    out_i: *mut i32,
    max_coll: usize,
) -> i32 {
    let ff = std::slice::from_raw_parts_mut(out_f, 5);
    let ii = std::slice::from_raw_parts_mut(out_i, 1 + max_coll);
    ii[0] = -1;

    let Some(entry) = realm.controller_map.get(&ctrl_id) else {
        return -1;
    };
    let collider_handle = match entry.collider {
        Some(h) => h,
        None => match entry.body.and_then(|bh| realm.bodies.get(bh)) {
            Some(b) => match b.colliders().first() {
                Some(&h) => h,
                None => return -1,
            },
            None => return -1,
        },
    };
    let Some(collider) = realm.colliders.get(collider_handle) else {
        return -1;
    };
    let shape = collider.shape();
    let pos = *collider.position();

    // Queries must work without a preceding step — refresh the pipeline.
    realm.query_pipeline.update(&realm.bodies, &realm.colliders);
    let mut collisions: Vec<CharacterCollision> = Vec::new();
    let controller = &entry.controller;
    // WASM parity: computeColliderMovement uses the world's integration dt.
    let effective = controller.move_shape(
        realm.integration_params.dt,
        &realm.bodies,
        &realm.colliders,
        &realm.query_pipeline,
        &*shape,
        &pos,
        Vector::new(dx, dy, dz),
        QueryFilter::default().exclude_collider(collider_handle),
        |c| collisions.push(c),
    );

    ff[0] = effective.grounded as i32 as f32;
    ff[1] = effective.translation.x;
    ff[2] = effective.translation.y;
    ff[3] = effective.translation.z;
    ff[4] = effective.is_sliding_down_slope as i32 as f32;

    let mut n = 0usize;
    for c in &collisions {
        if n >= max_coll {
            break;
        }
        let body_id = realm
            .colliders
            .get(c.handle)
            .and_then(|col| col.parent())
            .and_then(|h| realm.body_id_by_handle.get(&h).copied())
            .unwrap_or(-1);
        ii[1 + n] = body_id;
        if effective.grounded && ii[0] < 0 && body_id >= 0 {
            ii[0] = body_id;
        }
        n += 1;
    }

    if realm.impulse_controllers.contains(&ctrl_id) {
        let mass = entry
            .body
            .and_then(|bh| realm.bodies.get(bh))
            .map(|b| b.mass())
            .unwrap_or(1.0);
        for collision in &collisions {
            controller.solve_character_collision_impulses(
                realm.integration_params.dt,
                &mut realm.bodies,
                &realm.colliders,
                &realm.query_pipeline,
                &*shape,
                mass,
                collision,
                QueryFilter::default().exclude_collider(collider_handle),
            );
        }
    }

    n as i32
}
