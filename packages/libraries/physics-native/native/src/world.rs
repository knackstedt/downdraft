use rapier3d::prelude::*;

pub struct PhysicsWorld {
    pub physics: PhysicsPipeline,
    pub broadphase: BroadPhase,
    pub narrowphase: NarrowPhase,
    pub bodies: RigidBodySet,
    pub colliders: ColliderSet,
    pub impulse_joints: ImpulseJointSet,
    pub multibody_joints: MultibodyJointSet,
    pub island_manager: IslandManager,
    pub gravity: Vector<f32>,
    pub body_map: std::collections::HashMap<i32, RigidBodyHandle>,
    pub ccd_solver: CcdSolver,
}

impl PhysicsWorld {
    pub fn new(gravity: [f32; 3]) -> Self {
        PhysicsWorld {
            physics: PhysicsPipeline::new(),
            broadphase: BroadPhase::new(),
            narrowphase: NarrowPhase::new(),
            bodies: RigidBodySet::new(),
            colliders: ColliderSet::new(),
            impulse_joints: ImpulseJointSet::new(),
            multibody_joints: MultibodyJointSet::new(),
            island_manager: IslandManager::new(),
            gravity: Vector::new(gravity[0], gravity[1], gravity[2]),
            body_map: std::collections::HashMap::new(),
            ccd_solver: CcdSolver::new(),
        }
    }

    pub fn step(&mut self, dt: f32) {
        let integration_params = IntegrationParameters::default().with_dt(dt);
        self.physics.step(
            &self.gravity,
            &integration_params,
            &mut self.island_manager,
            &mut self.broadphase,
            &mut self.narrowphase,
            &mut self.bodies,
            &mut self.colliders,
            &mut self.impulse_joints,
            &mut self.multibody_joints,
            &mut self.ccd_solver,
            &PhysicsHooks::default(),
        );
    }

    pub fn step_batched(
        &mut self,
        dt: f32,
        transform_buffer: *const f32,
        velocity_buffer: *mut f32,
        entity_count: usize,
    ) -> i32 {
        // Read transforms from SAB buffer (7 floats per entity: x,y,z, qx,qy,qz,qw)
        unsafe {
            let transforms = std::slice::from_raw_parts(transform_buffer, entity_count * 7);
            let velocities = std::slice::from_raw_parts_mut(velocity_buffer, entity_count * 6);

            let mut idx = 0;
            for (_, body) in self.bodies.iter_mut() {
                if idx >= entity_count {
                    break;
                }
                let offset = idx * 7;
                let pos = Translation::new([transforms[offset], transforms[offset + 1], transforms[offset + 2]]);
                let rot = UnitQuaternion::from_quaternion(Quaternion::new(
                    transforms[offset + 6],
                    transforms[offset + 3],
                    transforms[offset + 4],
                    transforms[offset + 5],
                ));
                body.set_position(pos * rot, true);
                idx += 1;
            }
        }

        self.step(dt);

        // Write results back to velocity buffer (6 floats per entity: vx,vy,vz, wx,wy,wz)
        unsafe {
            let velocities = std::slice::from_raw_parts_mut(velocity_buffer, entity_count * 6);
            let mut idx = 0;
            for (_, body) in self.bodies.iter() {
                if idx >= entity_count {
                    break;
                }
                let linvel = body.linvel();
                let angvel = body.angvel();
                let offset = idx * 6;
                velocities[offset] = linvel.x;
                velocities[offset + 1] = linvel.y;
                velocities[offset + 2] = linvel.z;
                velocities[offset + 3] = angvel.x;
                velocities[offset + 4] = angvel.y;
                velocities[offset + 5] = angvel.z;
                idx += 1;
            }
        }

        0
    }
}
