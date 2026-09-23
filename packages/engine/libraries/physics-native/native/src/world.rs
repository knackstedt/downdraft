use rapier3d::control::KinematicCharacterController;
use rapier3d::prelude::*;
use std::collections::HashMap;

/// A kinematic character controller plus the collider it drives.
/// `body` is set when the controller is attached to an existing rigid body;
/// `collider` is set for the parentless variant (capsule with no rigid body).
pub struct CharController {
    pub controller: KinematicCharacterController,
    pub body: Option<RigidBodyHandle>,
    pub collider: Option<ColliderHandle>,
}

pub struct PhysicsWorld {
    pub physics: PhysicsPipeline,
    pub broadphase: DefaultBroadPhase,
    pub narrowphase: NarrowPhase,
    pub bodies: RigidBodySet,
    pub colliders: ColliderSet,
    pub impulse_joints: ImpulseJointSet,
    pub multibody_joints: MultibodyJointSet,
    pub island_manager: IslandManager,
    pub query_pipeline: QueryPipeline,
    pub gravity: Vector<f32>,
    /// Game body id → Rapier handle.
    pub body_map: HashMap<i32, RigidBodyHandle>,
    /// Rapier handle → game body id (awake-state readback, contact reporting).
    pub body_id_by_handle: HashMap<RigidBodyHandle, i32>,
    /// Game collider id → Rapier handle.
    pub collider_map: HashMap<i32, ColliderHandle>,
    /// Game controller id → controller state.
    pub controller_map: HashMap<i32, CharController>,
    /// Controllers with applyImpulsesToDynamicBodies enabled.
    pub impulse_controllers: std::collections::HashSet<i32>,
    /// Game joint id → Rapier impulse joint handle.
    pub joint_map: HashMap<i32, ImpulseJointHandle>,
    pub ccd_solver: CCDSolver,
    /// Persistent integration params — dt is stored here so `setIntegrationDt`
    /// matches the WASM backend's semantics (step() reads the stored dt).
    pub integration_params: IntegrationParameters,
}

impl PhysicsWorld {
    pub fn new(gravity: [f32; 3]) -> Self {
        PhysicsWorld {
            physics: PhysicsPipeline::new(),
            broadphase: DefaultBroadPhase::new(),
            narrowphase: NarrowPhase::new(),
            bodies: RigidBodySet::new(),
            colliders: ColliderSet::new(),
            impulse_joints: ImpulseJointSet::new(),
            multibody_joints: MultibodyJointSet::new(),
            island_manager: IslandManager::new(),
            query_pipeline: QueryPipeline::new(),
            gravity: Vector::new(gravity[0], gravity[1], gravity[2]),
            body_map: HashMap::new(),
            body_id_by_handle: HashMap::new(),
            collider_map: HashMap::new(),
            controller_map: HashMap::new(),
            impulse_controllers: std::collections::HashSet::new(),
            joint_map: HashMap::new(),
            ccd_solver: CCDSolver::new(),
            integration_params: IntegrationParameters::default(),
        }
    }

    /// Step with the stored integration parameters. `dt > 0` overrides the
    /// stored dt for this step (and becomes the new stored value — matching
    /// the WASM backend where step uses integrationParameters.dt).
    pub fn step(&mut self, dt: f32) {
        if dt > 0.0 {
            self.integration_params.dt = dt;
        }
        self.physics.step(
            &self.gravity,
            &self.integration_params,
            &mut self.island_manager,
            &mut self.broadphase,
            &mut self.narrowphase,
            &mut self.bodies,
            &mut self.colliders,
            &mut self.impulse_joints,
            &mut self.multibody_joints,
            &mut self.ccd_solver,
            Some(&mut self.query_pipeline),
            &(),
            &(),
        );
    }

    /// Enumerate awake dynamic bodies via the island manager's active set —
    /// the native equivalent of `forEachActiveRigidBodyHandle`.
    /// Writes ids_out[i] = body_id and out[i*10..+9] =
    /// [pos.x, pos.y, pos.z, rot.x, rot.y, rot.z, rot.w, linvel.x, linvel.y, linvel.z].
    /// Returns the number of bodies written (≤ max_count).
    ///
    /// # Safety
    /// `ids_out` must point to at least `max_count` i32s and `out` to at
    /// least `max_count * 10` f32s.
    pub unsafe fn read_awake_states(
        &self,
        ids_out: *mut i32,
        out: *mut f32,
        max_count: usize,
    ) -> usize {
        let ids = std::slice::from_raw_parts_mut(ids_out, max_count);
        let states = std::slice::from_raw_parts_mut(out, max_count * 10);
        let mut written = 0usize;
        // Active set = awake dynamic + kinematic bodies (matching the WASM
        // backend's forEachActiveRigidBodyHandle). Sleeping bodies are
        // excluded — they cannot move, so callers keep last-synced values.
        let active = self
            .island_manager
            .active_dynamic_bodies()
            .iter()
            .chain(self.island_manager.active_kinematic_bodies().iter());
        for &handle in active {
            if written >= max_count {
                break;
            }
            let Some(body_id) = self.body_id_by_handle.get(&handle) else {
                continue;
            };
            let Some(body) = self.bodies.get(handle) else {
                continue;
            };
            let t = body.translation();
            let r = body.rotation().quaternion();
            let v = body.linvel();
            let o = written * 10;
            states[o] = t.x;
            states[o + 1] = t.y;
            states[o + 2] = t.z;
            states[o + 3] = r.i;
            states[o + 4] = r.j;
            states[o + 5] = r.k;
            states[o + 6] = r.w;
            states[o + 7] = v.x;
            states[o + 8] = v.y;
            states[o + 9] = v.z;
            ids[written] = *body_id;
            written += 1;
        }
        written
    }
}
