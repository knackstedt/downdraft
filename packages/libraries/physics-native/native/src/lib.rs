mod world;
mod realm;
mod body;
mod collider;
mod step;
mod raycast;

use realm::RealmManager;

static mut MANAGER: Option<RealmManager> = None;

fn get_manager() -> &'static mut RealmManager {
    unsafe {
        if MANAGER.is_none() {
            MANAGER = Some(RealmManager::new());
        }
        MANAGER.as_mut().unwrap()
    }
}

#[no_mangle]
pub extern "C" fn dd_create_realm(id: i32, gx: f32, gy: f32, gz: f32) -> i32 {
    let manager = get_manager();
    manager.create_realm(id, [gx, gy, gz])
}

#[no_mangle]
pub extern "C" fn dd_destroy_realm(id: i32) -> i32 {
    let manager = get_manager();
    manager.destroy_realm(id)
}

#[no_mangle]
pub extern "C" fn dd_create_body(
    realm_id: i32,
    body_id: i32,
    body_type: i32,
    transform_ptr: *const f32,
    mass: f32,
) -> i32 {
    let manager = get_manager();
    match manager.get_realm(realm_id) {
        Some(realm) => body::create_body(realm, body_id, body_type, transform_ptr, mass),
        None => -1,
    }
}

#[no_mangle]
pub extern "C" fn dd_destroy_body(realm_id: i32, body_id: i32) -> i32 {
    let manager = get_manager();
    match manager.get_realm(realm_id) {
        Some(realm) => body::destroy_body(realm, body_id),
        None => -1,
    }
}

#[no_mangle]
pub extern "C" fn dd_set_body_type(realm_id: i32, body_id: i32, body_type: i32) -> i32 {
    let manager = get_manager();
    match manager.get_realm(realm_id) {
        Some(realm) => body::set_body_type(realm, body_id, body_type),
        None => -1,
    }
}

#[no_mangle]
pub extern "C" fn dd_add_box_collider(
    realm_id: i32,
    body_id: i32,
    half_extents_ptr: *const f32,
    friction: f32,
    restitution: f32,
) -> i32 {
    let manager = get_manager();
    let realm = match manager.get_realm(realm_id) {
        Some(r) => r,
        None => return -1,
    };
    let handle = match realm.body_map.get(&body_id) {
        Some(h) => *h,
        None => return -1,
    };
    let half_extents = unsafe { std::slice::from_raw_parts(half_extents_ptr, 3) };
    collider::add_box_collider(realm, handle, [half_extents[0], half_extents[1], half_extents[2]], friction, restitution) as i32
}

#[no_mangle]
pub extern "C" fn dd_add_sphere_collider(
    realm_id: i32,
    body_id: i32,
    radius: f32,
    friction: f32,
    restitution: f32,
) -> i32 {
    let manager = get_manager();
    let realm = match manager.get_realm(realm_id) {
        Some(r) => r,
        None => return -1,
    };
    let handle = match realm.body_map.get(&body_id) {
        Some(h) => *h,
        None => return -1,
    };
    collider::add_sphere_collider(realm, handle, radius, friction, restitution) as i32
}

#[no_mangle]
pub extern "C" fn dd_remove_collider(realm_id: i32, collider_id: i32) -> i32 {
    let manager = get_manager();
    match manager.get_realm(realm_id) {
        Some(realm) => collider::remove_collider(realm, collider_id as u32),
        None => -1,
    }
}

#[no_mangle]
pub extern "C" fn dd_step(realm_id: i32, dt: f32) -> i32 {
    let manager = get_manager();
    match manager.get_realm(realm_id) {
        Some(realm) => step::step_realm(realm, dt),
        None => -1,
    }
}

/// Batched step: reads transforms from SAB, steps physics, writes velocities back to SAB.
/// transform_buffer: [x,y,z, qx,qy,qz,qw] per entity (7 floats * entity_count)
/// velocity_buffer: [vx,vy,vz, wx,wy,wz] per entity (6 floats * entity_count)
#[no_mangle]
pub extern "C" fn dd_step_batched(
    realm_id: i32,
    dt: f32,
    transform_buffer: *const f32,
    velocity_buffer: *mut f32,
    entity_count: usize,
) -> i32 {
    let manager = get_manager();
    match manager.get_realm(realm_id) {
        Some(realm) => step::step_realm_batched(realm, dt, transform_buffer, velocity_buffer, entity_count),
        None => -1,
    }
}

#[no_mangle]
pub extern "C" fn dd_destroy() -> i32 {
    unsafe {
        if let Some(manager) = MANAGER.as_mut() {
            manager.destroy_all();
        }
        MANAGER = None;
    }
    0
}
