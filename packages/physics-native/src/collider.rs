use rapier3d::prelude::*;
use crate::world::PhysicsWorld;

pub fn add_box_collider(
    realm: &mut PhysicsWorld,
    body_handle: RigidBodyHandle,
    half_extents: [f32; 3],
    friction: f32,
    restitution: f32,
) -> u32 {
    let collider = ColliderBuilder::cuboid(half_extents[0], half_extents[1], half_extents[2])
        .friction(friction)
        .restitution(restitution)
        .build();
    let handle = realm.colliders.insert_with_parent(collider, body_handle, &mut realm.bodies);
    handle.0 as u32
}

pub fn add_sphere_collider(
    realm: &mut PhysicsWorld,
    body_handle: RigidBodyHandle,
    radius: f32,
    friction: f32,
    restitution: f32,
) -> u32 {
    let collider = ColliderBuilder::ball(radius)
        .friction(friction)
        .restitution(restitution)
        .build();
    let handle = realm.colliders.insert_with_parent(collider, body_handle, &mut realm.bodies);
    handle.0 as u32
}

pub fn add_capsule_collider(
    realm: &mut PhysicsWorld,
    body_handle: RigidBodyHandle,
    half_height: f32,
    radius: f32,
    friction: f32,
    restitution: f32,
) -> u32 {
    let collider = ColliderBuilder::capsule_y(half_height, radius)
        .friction(friction)
        .restitution(restitution)
        .build();
    let handle = realm.colliders.insert_with_parent(collider, body_handle, &mut realm.bodies);
    handle.0 as u32
}

pub fn remove_collider(realm: &mut PhysicsWorld, collider_id: u32) -> i32 {
    let handle = ColliderHandle(collider_id);
    realm.colliders.remove(
        handle,
        &mut realm.island_manager,
        &mut realm.bodies,
        true,
    );
    0
}
