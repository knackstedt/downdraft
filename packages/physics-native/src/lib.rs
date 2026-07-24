use rapier3d::prelude::*;
use std::collections::HashMap;
use std::ffi::c_void;

#[repr(C)]
pub struct RealmConfig {
    pub id: i32,
    pub gravity: [f32; 3],
}

struct Realm {
    physics: PhysicsPipeline,
    broadphase: BroadPhase,
    narrowphase: NarrowPhase,
    bodies: RigidBodySet,
    colliders: ColliderSet,
    impulse_joints: ImpulseJointSet,
    multibody_joints: MultibodyJointSet,
    island_manager: IslandManager,
    gravity: Vector<f32>,
    body_map: HashMap<i32, RigidBodyHandle>,
}

struct PhysicsState {
    realms: HashMap<i32, Realm>,
}

static mut STATE: Option<PhysicsState> = None;

fn get_state() -> &'static mut PhysicsState {
    unsafe {
        if STATE.is_none() {
            STATE = Some(PhysicsState { realms: HashMap::new() });
        }
        STATE.as_mut().unwrap()
    }
}

#[no_mangle]
pub extern "C" fn dd_create_realm(id: i32, gx: f32, gy: f32, gz: f32) -> i32 {
    let state = get_state();
    let realm = Realm {
        physics: PhysicsPipeline::new(),
        broadphase: BroadPhase::new(),
        narrowphase: NarrowPhase::new(),
        bodies: RigidBodySet::new(),
        colliders: ColliderSet::new(),
        impulse_joints: ImpulseJointSet::new(),
        multibody_joints: MultibodyJointSet::new(),
        island_manager: IslandManager::new(),
        gravity: Vector::new(gx, gy, gz),
        body_map: HashMap::new(),
    };
    state.realms.insert(id, realm);
    0
}

#[no_mangle]
pub extern "C" fn dd_destroy_realm(id: i32) -> i32 {
    let state = get_state();
    state.realms.remove(&id);
    0
}

#[no_mangle]
pub extern "C" fn dd_create_body(
    realm_id: i32,
    body_id: i32,
    body_type: i32,
    transform_ptr: *const f32,
    mass: f32,
) -> i32 {
    let state = get_state();
    let realm = match state.realms.get_mut(&realm_id) {
        Some(r) => r,
        None => return -1,
    };

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

#[no_mangle]
pub extern "C" fn dd_destroy_body(realm_id: i32, body_id: i32) -> i32 {
    let state = get_state();
    if let Some(realm) = state.realms.get_mut(&realm_id) {
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
    }
    0
}

#[no_mangle]
pub extern "C" fn dd_step(realm_id: i32, dt: f32) -> i32 {
    let state = get_state();
    let realm = match state.realms.get_mut(&realm_id) {
        Some(r) => r,
        None => return -1,
    };

    realm.physics.step(
        &realm.gravity,
        &IntegrationParameters::default().with_dt(dt),
        &mut realm.island_manager,
        &mut realm.broadphase,
        &mut realm.narrowphase,
        &mut realm.bodies,
        &mut realm.colliders,
        &mut realm.impulse_joints,
        &mut realm.multibody_joints,
        &mut CcdSolver::new(),
        &PhysicsHooks::default(),
    );

    0
}

#[no_mangle]
pub extern "C" fn dd_destroy() -> i32 {
    unsafe {
        STATE = None;
    }
    0
}
