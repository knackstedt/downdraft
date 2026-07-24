use rapier3d::prelude::*;
use crate::world::PhysicsWorld;

#[repr(C)]
pub struct RayHitResult {
    pub hit: i32,
    pub entity_id: i32,
    pub point: [f32; 3],
    pub normal: [f32; 3],
    pub distance: f32,
}

pub fn raycast(
    realm: &PhysicsWorld,
    origin: [f32; 3],
    direction: [f32; 3],
    max_distance: f32,
) -> Option<RayHitResult> {
    let ray = Ray::new(
        Point::new(origin[0], origin[1], origin[2]),
        Vector::new(direction[0], direction[1], direction[2]),
    );

    let mut visitor = RaycastVisitor::new();
    realm.query_pipeline.intersections_with_ray(
        &realm.colliders,
        &ray,
        max_distance,
        true,
        QueryFilter::default(),
        &mut visitor,
    );

    if let Some((handle, intersection)) = visitor.hits.first() {
        let collider = realm.colliders.get(*handle)?;
        let body_handle = collider.parent()?;
        let body = realm.bodies.get(*body_handle)?;
        let entity_id = realm.body_map.iter()
            .find(|(_, h)| h == body_handle)
            .map(|(id, _)| *id)
            .unwrap_or(-1);

        Some(RayHitResult {
            hit: 1,
            entity_id,
            point: [intersection.point.x, intersection.point.y, intersection.point.z],
            normal: [intersection.normal.x, intersection.normal.y, intersection.normal.z],
            distance: intersection.time_of_impact,
        })
    } else {
        None
    }
}

struct RaycastVisitor {
    hits: Vec<(ColliderHandle, RayIntersection)>,
}

impl RaycastVisitor {
    fn new() -> Self {
        RaycastVisitor { hits: Vec::new() }
    }
}

impl RaycastQueryVisitor for RaycastVisitor {
    fn visit(&mut self, handle: ColliderHandle, intersection: RayIntersection) -> bool {
        self.hits.push((handle, intersection));
        true
    }
}
