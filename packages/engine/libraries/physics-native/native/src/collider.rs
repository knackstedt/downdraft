use rapier3d::na::{DMatrix, Quaternion, UnitQuaternion, Vector3};
use rapier3d::prelude::*;
use crate::world::PhysicsWorld;

// ── dd_add_collider descriptor layout ────────────────────────────────────
// meta (i32):
//   [0] shape: 0=ball, 1=cuboid, 2=capsule, 3=convex, 4=trimesh, 5=heightfield
//   [1] sensor (0/1)
//   [2] collision_groups (packed u32: memberships<<16 | filter)
//   [3] solver_groups   (packed u32)
//   [4] n_verts   (convex/trimesh: vertex count; heightfield: nrows*ncols)
//   [5] n_indices (trimesh: index count)
//   [6] flags: bit0 hasFriction, bit1 hasRestitution, bit2 hasDensity,
//        bit3 hasTranslation, bit4 hasRotation,
//        bit5 hasCollisionGroups, bit6 hasSolverGroups
//   [7] heightfield nrows   [8] heightfield ncols
// f (f32):
//   [0..4]  shape params — ball: r | cuboid: hx,hy,hz | capsule: hh,r |
//           heightfield: scale xyz | convex/trimesh: unused
//   [4] friction   [5] restitution   [6] density
//   [7..10]  translation (wrt parent)
//   [10..14] rotation quat (x,y,z,w)
pub const COLLIDER_I32_LEN: usize = 9;
pub const COLLIDER_F32_LEN: usize = 14;

fn interaction_groups(packed: u32) -> InteractionGroups {
    InteractionGroups::new(
        Group::from_bits_truncate(packed >> 16),
        Group::from_bits_truncate(packed & 0xffff),
    )
}

fn build_collider(
    meta: &[i32],
    f: &[f32],
    verts: &[f32],
    indices: &[u32],
) -> Option<Collider> {
    let shape = meta[0];
    let mut builder = match shape {
        0 => ColliderBuilder::ball(f[0]),
        1 => ColliderBuilder::cuboid(f[0], f[1], f[2]),
        2 => ColliderBuilder::capsule_y(f[0], f[1]),
        3 => {
            let n = meta[4].max(0) as usize;
            if n == 0 || verts.len() < n * 3 {
                return None;
            }
            let points: Vec<Point<f32>> = (0..n)
                .map(|i| Point::new(verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]))
                .collect();
            match ColliderBuilder::convex_hull(&points) {
                Some(b) => b,
                None => ColliderBuilder::ball(0.5), // degenerate hull fallback (WASM parity)
            }
        }
        4 => {
            let nv = meta[4].max(0) as usize;
            let ni = meta[5].max(0) as usize;
            if nv == 0 || ni == 0 || verts.len() < nv * 3 || indices.len() < ni {
                return None;
            }
            let points: Vec<Point<f32>> = (0..nv)
                .map(|i| Point::new(verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]))
                .collect();
            let tris: Vec<[u32; 3]> = (0..ni / 3)
                .map(|i| [indices[i * 3], indices[i * 3 + 1], indices[i * 3 + 2]])
                .collect();
            ColliderBuilder::trimesh(points, tris)
        }
        5 => {
            let nrows = meta[7].max(0) as usize;
            let ncols = meta[8].max(0) as usize;
            if nrows == 0 || ncols == 0 || verts.len() < nrows * ncols {
                return None;
            }
            let heights = DMatrix::from_row_slice(nrows, ncols, &verts[..nrows * ncols]);
            ColliderBuilder::heightfield(heights, Vector3::new(f[0], f[1], f[2]))
        }
        _ => return None,
    };

    let flags = meta[6];
    if flags & (1 << 0) != 0 {
        builder = builder.friction(f[4]);
    }
    if flags & (1 << 1) != 0 {
        builder = builder.restitution(f[5]);
    }
    if flags & (1 << 2) != 0 {
        builder = builder.density(f[6]);
    }
    if meta[1] != 0 {
        builder = builder.sensor(true);
    }
    if flags & (1 << 5) != 0 {
        builder = builder.collision_groups(interaction_groups(meta[2] as u32));
    }
    if flags & (1 << 6) != 0 {
        builder = builder.solver_groups(interaction_groups(meta[3] as u32));
    }

    let mut collider = builder.build();
    if flags & ((1 << 3) | (1 << 4)) != 0 {
        let t = if flags & (1 << 3) != 0 {
            Translation::new(f[7], f[8], f[9])
        } else {
            Translation::identity()
        };
        let r = if flags & (1 << 4) != 0 {
            UnitQuaternion::from_quaternion(Quaternion::new(f[13], f[10], f[11], f[12]))
        } else {
            UnitQuaternion::identity()
        };
        collider.set_position_wrt_parent(Isometry::from_parts(t, r));
    }
    Some(collider)
}

/// # Safety
/// `meta`/`f`/`verts`/`indices` must describe the layouts documented above.
pub unsafe fn add_collider(
    realm: &mut PhysicsWorld,
    body_id: i32,
    collider_id: i32,
    meta: *const i32,
    f: *const f32,
    verts: *const f32,
    indices: *const u32,
) -> i32 {
    let meta = std::slice::from_raw_parts(meta, COLLIDER_I32_LEN);
    let f = std::slice::from_raw_parts(f, COLLIDER_F32_LEN);
    // Heightfield heights are a scalar grid (nrows*ncols floats); every other
    // vertex-taking shape uses xyz triples.
    let n_verts = if meta[0] == 5 {
        meta[4].max(0) as usize
    } else {
        (meta[4].max(0) as usize) * 3
    };
    let n_indices = meta[5].max(0) as usize;
    let verts = if verts.is_null() {
        &[]
    } else {
        std::slice::from_raw_parts(verts, n_verts)
    };
    let indices = if indices.is_null() {
        &[]
    } else {
        std::slice::from_raw_parts(indices, n_indices)
    };

    let Some(&body_handle) = realm.body_map.get(&body_id) else {
        return -1;
    };
    let Some(collider) = build_collider(meta, f, verts, indices) else {
        return -1;
    };
    let handle = realm
        .colliders
        .insert_with_parent(collider, body_handle, &mut realm.bodies);
    realm.collider_map.insert(collider_id, handle);
    0
}

/// # Safety
/// `verts`/`indices` describe a trimesh (matches the WASM swapColliderShapeRaw).
pub unsafe fn swap_collider_shape(
    realm: &mut PhysicsWorld,
    collider_id: i32,
    verts: *const f32,
    n_verts: usize,
    indices: *const u32,
    n_indices: usize,
) -> i32 {
    let Some(&handle) = realm.collider_map.get(&collider_id) else {
        return 0;
    };
    let Some(collider) = realm.colliders.get_mut(handle) else {
        return 0;
    };
    let vs = std::slice::from_raw_parts(verts, n_verts * 3);
    let is = std::slice::from_raw_parts(indices, n_indices);
    let points: Vec<Point<f32>> = (0..n_verts)
        .map(|i| Point::new(vs[i * 3], vs[i * 3 + 1], vs[i * 3 + 2]))
        .collect();
    let tris: Vec<[u32; 3]> = (0..n_indices / 3)
        .map(|i| [is[i * 3], is[i * 3 + 1], is[i * 3 + 2]])
        .collect();
    collider.set_shape(SharedShape::trimesh(points, tris));
    1
}

pub fn remove_collider(realm: &mut PhysicsWorld, collider_id: i32) -> i32 {
    if let Some(handle) = realm.collider_map.remove(&collider_id) {
        realm.colliders.remove(
            handle,
            &mut realm.island_manager,
            &mut realm.bodies,
            true,
        );
    }
    0
}

pub fn set_collider_position(realm: &mut PhysicsWorld, collider_id: i32, x: f32, y: f32, z: f32) -> i32 {
    if let Some(&handle) = realm.collider_map.get(&collider_id) {
        if let Some(c) = realm.colliders.get_mut(handle) {
            c.set_translation(Vector::new(x, y, z));
        }
    }
    0
}

/// # Safety
/// `out` must point to at least 3 f32s.
pub unsafe fn get_collider_position(realm: &PhysicsWorld, collider_id: i32, out: *mut f32) -> i32 {
    let o = std::slice::from_raw_parts_mut(out, 3);
    match realm
        .collider_map
        .get(&collider_id)
        .and_then(|&h| realm.colliders.get(h))
    {
        Some(c) => {
            let t = c.translation();
            o[0] = t.x;
            o[1] = t.y;
            o[2] = t.z;
            1
        }
        None => {
            o[0] = 0.0;
            o[1] = 0.0;
            o[2] = 0.0;
            0
        }
    }
}

/// Rapier `ShapeType` discriminant for the live collider (-1 if absent).
///
/// The value is translated to the @dimforge/rapier3d-compat JS enum so
/// callers see identical numbers across WASM and native backends. The two
/// differ: native parry3d orders Segment, Triangle, TriMesh, Polyline,
/// HalfSpace mid-enum (HalfSpace=7, ConvexPolyhedron=10), while the WASM
/// bindings move HalfSpace to 17 and order the mid-enum Segment, Polyline,
/// Triangle, TriMesh (ConvexPolyhedron=9).
pub fn collider_shape_type(realm: &PhysicsWorld, collider_id: i32) -> i32 {
    use rapier3d::parry::shape::ShapeType as T;
    realm
        .collider_map
        .get(&collider_id)
        .and_then(|&h| realm.colliders.get(h))
        .map(|c| match c.shape().shape_type() {
            T::Segment => 3,
            T::Polyline => 4,
            T::Triangle => 5,
            T::TriMesh => 6,
            T::HeightField => 7,
            T::Compound => 8,
            T::ConvexPolyhedron => 9,
            T::Cylinder => 10,
            T::Cone => 11,
            T::RoundCuboid => 12,
            T::RoundTriangle => 13,
            T::RoundCylinder => 14,
            T::RoundCone => 15,
            T::RoundConvexPolyhedron => 16,
            T::HalfSpace => 17,
            // Ball=0, Cuboid=1, Capsule=2 line up; Custom has no JS analog.
            T::Ball | T::Cuboid | T::Capsule => c.shape().shape_type() as i32,
            _ => -1,
        })
        .unwrap_or(-1)
}

/// Number of live colliders attached to the body (-1 if body absent).
pub fn collider_count(realm: &PhysicsWorld, body_id: i32) -> i32 {
    realm
        .body_map
        .get(&body_id)
        .and_then(|&h| realm.bodies.get(h))
        .map(|b| b.colliders().len() as i32)
        .unwrap_or(-1)
}

/// Whether a convex hull can be built from `verts` (n*3 floats).
///
/// # Safety
/// `verts` must point to `n_verts * 3` f32s.
pub unsafe fn test_convex_hull(verts: *const f32, n_verts: usize) -> i32 {
    if verts.is_null() || n_verts == 0 {
        return 0;
    }
    let vs = std::slice::from_raw_parts(verts, n_verts * 3);
    let points: Vec<Point<f32>> = (0..n_verts)
        .map(|i| Point::new(vs[i * 3], vs[i * 3 + 1], vs[i * 3 + 2]))
        .collect();
    SharedShape::convex_hull(&points).is_some() as i32
}
