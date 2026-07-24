use rapier3d::prelude::*;
use crate::world::PhysicsWorld;

pub fn create_body(
    realm: &mut PhysicsWorld,
    body_id: i32,
    body_type: i32,
    transform_ptr: *const f32,
    mass: f32,
) -> i32 {
    let transform = unsafe {
        let slice = std::slice::from_raw_parts(transform_ptr, 8);
        Translation::new([slice[0], slice[1], slice[2]])
            * UnitQuaternion::from_quaternion(Quaternion::new(slice[6], slice[3], slice[4], slice[5]))
    };

    let rb_type = match body_type {
        0 => RigidBodyType::Fixed,
        1 => RigidBodyType::KinematicPositionBased,
        _ => RigidBodyType::Dynamic,
    };

    let body = RigidBodyBuilder::new(rb_type)
        .position(transform)
        .linvelocity(Vector::zeros())
        .additional_mass(mass);

    let handle = realm.bodies.insert(body);
    realm.body_map.insert(body_id, handle);
    0
}

pub fn destroy_body(realm: &mut PhysicsWorld, body_id: i32) -> i32 {
    if let Some(handle) = realm.body_map.remove(&body_id) {
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
    if let Some(handle) = realm.body_map.get(&body_id) {
        if let Some(body) = realm.bodies.get_mut(*handle) {
            let rb_type = match body_type {
                0 => RigidBodyType::Fixed,
                1 => RigidBodyType::KinematicPositionBased,
                _ => RigidBodyType::Dynamic,
            };
            body.set_body_type(rb_type);
        }
    }
    0
}
