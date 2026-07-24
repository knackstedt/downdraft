use crate::world::PhysicsWorld;
use std::collections::HashMap;

pub struct RealmManager {
    realms: HashMap<i32, PhysicsWorld>,
}

impl RealmManager {
    pub fn new() -> Self {
        RealmManager {
            realms: HashMap::new(),
        }
    }

    pub fn create_realm(&mut self, id: i32, gravity: [f32; 3]) -> i32 {
        let world = PhysicsWorld::new(gravity);
        self.realms.insert(id, world);
        0
    }

    pub fn destroy_realm(&mut self, id: i32) -> i32 {
        self.realms.remove(&id);
        0
    }

    pub fn get_realm(&mut self, id: i32) -> Option<&mut PhysicsWorld> {
        self.realms.get_mut(&id)
    }

    pub fn destroy_all(&mut self) {
        self.realms.clear();
    }
}
