use rapier3d::na::{Quaternion, UnitQuaternion};
use rapier3d::parry::query::ShapeCastOptions;
use rapier3d::prelude::*;
use std::collections::HashSet;
use crate::world::PhysicsWorld;

fn ray_filter(realm: &PhysicsWorld, groups: u32, exclude_body: i32) -> QueryFilter<'static> {
    let mut filter = QueryFilter::default();
    if groups != 0 {
        filter.groups = Some(InteractionGroups::new(
            Group::from_bits_truncate(groups >> 16),
            Group::from_bits_truncate(groups & 0xffff),
        ));
    }
    if exclude_body >= 0 {
        filter.exclude_rigid_body = realm.body_map.get(&exclude_body).copied();
    }
    filter
}

fn body_id_for_collider(realm: &PhysicsWorld, handle: ColliderHandle) -> i32 {
    realm
        .colliders
        .get(handle)
        .and_then(|c| c.parent())
        .and_then(|h| realm.body_id_by_handle.get(&h).copied())
        .unwrap_or(-1)
}

/// First-hit raycast. On hit writes out[0..3]=point, out[3..6]=normal,
/// out[6]=distance, out[7]=body_id (as f32). Returns 1 hit / 0 miss.
///
/// # Safety
/// `out` must point to at least 8 f32s.
pub unsafe fn raycast(
    realm: &mut PhysicsWorld,
    origin: [f32; 3],
    direction: [f32; 3],
    max_distance: f32,
    groups: u32,
    exclude_body: i32,
    out: *mut f32,
) -> i32 {
    // The WASM World refreshes the query pipeline on collider insertion;
    // here queries must work without a preceding step, so update lazily.
    realm.query_pipeline.update(&realm.bodies, &realm.colliders);
    let ray = Ray::new(
        Point::new(origin[0], origin[1], origin[2]),
        Vector::new(direction[0], direction[1], direction[2]),
    );
    let filter = ray_filter(realm, groups, exclude_body);
    let Some((handle, hit)) = realm.query_pipeline.cast_ray_and_get_normal(
        &realm.bodies,
        &realm.colliders,
        &ray,
        max_distance,
        true,
        filter,
    ) else {
        return 0;
    };
    let o = std::slice::from_raw_parts_mut(out, 8);
    let point = ray.point_at(hit.time_of_impact);
    o[0] = point.x;
    o[1] = point.y;
    o[2] = point.z;
    o[3] = hit.normal.x;
    o[4] = hit.normal.y;
    o[5] = hit.normal.z;
    o[6] = hit.time_of_impact;
    o[7] = body_id_for_collider(realm, handle) as f32;
    1
}

/// Shape cast — sphere(0)/cuboid(1)/capsule(2). Same output layout as raycast.
/// `shape_f`: [p0,p1,p2] shape params, then origin3, quat4, dir3.
///
/// # Safety
/// `shape_f` must point to ≥12 f32s, `out` to ≥8.
pub unsafe fn shape_cast(
    realm: &mut PhysicsWorld,
    shape_type: i32,
    f: *const f32,
    max_distance: f32,
    groups: u32,
    exclude_body: i32,
    out: *mut f32,
) -> i32 {
    let f = std::slice::from_raw_parts(f, 13);
    let shape: SharedShape = match shape_type {
        0 => SharedShape::ball(f[0]),
        1 => SharedShape::cuboid(f[0], f[1], f[2]),
        2 => SharedShape::capsule_y(f[0], f[1]),
        _ => SharedShape::ball(0.5),
    };
    let pos = Isometry::from_parts(
        Translation::new(f[3], f[4], f[5]),
        UnitQuaternion::from_quaternion(Quaternion::new(f[9], f[6], f[7], f[8])),
    );
    let vel = Vector::new(f[10], f[11], f[12]);
    let filter = ray_filter(realm, groups, exclude_body);
    realm.query_pipeline.update(&realm.bodies, &realm.colliders);
    let options = ShapeCastOptions {
        target_distance: max_distance,
        max_time_of_impact: max_distance,
        stop_at_penetration: true,
        compute_impact_geometry_on_penetration: false,
    };
    let Some((handle, hit)) = realm.query_pipeline.cast_shape(
        &realm.bodies,
        &realm.colliders,
        &pos,
        &vel,
        &*shape,
        options,
        filter,
    ) else {
        return 0;
    };
    let o = std::slice::from_raw_parts_mut(out, 8);
    // Match the WASM path: reported point = pos + dir * toi.
    o[0] = f[3] + vel.x * hit.time_of_impact;
    o[1] = f[4] + vel.y * hit.time_of_impact;
    o[2] = f[5] + vel.z * hit.time_of_impact;
    o[3] = hit.normal1.x;
    o[4] = hit.normal1.y;
    o[5] = hit.normal1.z;
    o[6] = hit.time_of_impact;
    o[7] = body_id_for_collider(realm, handle) as f32;
    1
}

/// Contact manifold extraction over active bodies only (WASM parity —
/// contacts between sleeping bodies are static and uninteresting).
/// Per pair writes: out_i[3k]=[bodyA, bodyB, n_points], out_f[4k]=[nx,ny,nz,penetration],
/// out_pts[12k]=up to 4 world-space contact points.
///
/// # Safety
/// `out_i` ≥ max*3 i32, `out_f` ≥ max*4 f32, `out_pts` ≥ max*12 f32.
pub unsafe fn get_contacts(
    realm: &PhysicsWorld,
    out_i: *mut i32,
    out_f: *mut f32,
    out_pts: *mut f32,
    max_pairs: usize,
) -> i32 {
    let ii = std::slice::from_raw_parts_mut(out_i, max_pairs * 3);
    let ff = std::slice::from_raw_parts_mut(out_f, max_pairs * 4);
    let pp = std::slice::from_raw_parts_mut(out_pts, max_pairs * 12);

    let mut seen: HashSet<(u32, u32)> = HashSet::new();
    let mut written = 0usize;

    for &body_handle in realm.island_manager.active_dynamic_bodies() {
        let Some(body) = realm.bodies.get(body_handle) else {
            continue;
        };
        for &c1 in body.colliders() {
            let Some(col1) = realm.colliders.get(c1) else {
                continue;
            };
            if col1.is_sensor() {
                continue;
            }
            for pair in realm.narrowphase.contact_pairs_with(c1) {
                if !pair.has_any_active_contact {
                    continue;
                }
                let (a, b) = pair.collider1.into_raw_parts();
                let (c, d) = pair.collider2.into_raw_parts();
                let (ka, kb) = if (a, b) <= (c, d) { ((a, b), (c, d)) } else { ((c, d), (a, b)) };
                if !seen.insert((ka.0 as u32 | ((ka.1 as u32) << 16), kb.0 as u32 | ((kb.1 as u32) << 16))) {
                    continue;
                }
                let Some(col2) = realm.colliders.get(pair.collider2) else {
                    continue;
                };
                if col2.is_sensor() {
                    continue;
                }
                if written >= max_pairs {
                    return written as i32;
                }
                let body_a = body_id_for_collider(realm, pair.collider1);
                let body_b = body_id_for_collider(realm, pair.collider2);
                if body_a < 0 || body_b < 0 {
                    continue;
                }
                let manifold = pair.manifolds.first();
                let (nx, ny, nz) = manifold
                    .map(|m| (m.data.normal.x, m.data.normal.y, m.data.normal.z))
                    .unwrap_or((0.0, 1.0, 0.0));
                let mut n_pts = 0i32;
                let mut penetration = 0.0f32;
                if let Some(m) = manifold {
                    for sc in m.data.solver_contacts.iter().take(4) {
                        let base = written * 12 + n_pts as usize * 3;
                        pp[base] = sc.point.x;
                        pp[base + 1] = sc.point.y;
                        pp[base + 2] = sc.point.z;
                        penetration = penetration.max(-sc.dist);
                        n_pts += 1;
                    }
                }
                ii[written * 3] = body_a;
                ii[written * 3 + 1] = body_b;
                ii[written * 3 + 2] = n_pts;
                ff[written * 4] = nx;
                ff[written * 4 + 1] = ny;
                ff[written * 4 + 2] = nz;
                ff[written * 4 + 3] = penetration;
                written += 1;
            }
        }
    }
    written as i32
}

/// Intersection (sensor) pairs over active bodies. out_i[2k]=[bodyA, bodyB].
///
/// # Safety
/// `out_i` ≥ max*2 i32.
pub unsafe fn get_intersections(
    realm: &PhysicsWorld,
    out_i: *mut i32,
    max_pairs: usize,
) -> i32 {
    let ii = std::slice::from_raw_parts_mut(out_i, max_pairs * 2);
    let mut seen: HashSet<(u32, u32)> = HashSet::new();
    let mut written = 0usize;
    for &body_handle in realm.island_manager.active_dynamic_bodies() {
        let Some(body) = realm.bodies.get(body_handle) else {
            continue;
        };
        for &c1 in body.colliders() {
            for (ca, cb, intersecting) in realm.narrowphase.intersection_pairs_with(c1) {
                if !intersecting {
                    continue;
                }
                let (a, _) = ca.into_raw_parts();
                let (b, _) = cb.into_raw_parts();
                let key = if a <= b { (a as u32, b as u32) } else { (b as u32, a as u32) };
                if !seen.insert(key) {
                    continue;
                }
                let body_a = body_id_for_collider(realm, ca);
                let body_b = body_id_for_collider(realm, cb);
                if body_a < 0 || body_b < 0 {
                    continue;
                }
                if written >= max_pairs {
                    return written as i32;
                }
                ii[written * 2] = body_a;
                ii[written * 2 + 1] = body_b;
                written += 1;
            }
        }
    }
    written as i32
}
