use crate::world::PhysicsWorld;

pub fn step_realm(realm: &mut PhysicsWorld, dt: f32) -> i32 {
    realm.step(dt);
    0
}

pub fn step_realm_batched(
    realm: &mut PhysicsWorld,
    dt: f32,
    transform_buffer: *const f32,
    velocity_buffer: *mut f32,
    entity_count: usize,
) -> i32 {
    realm.step_batched(dt, transform_buffer, velocity_buffer, entity_count)
}
