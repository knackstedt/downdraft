use rapier3d::prelude::*;
use crate::world::PhysicsWorld;

// ── dd_create_joint descriptor layout ────────────────────────────────────
// jtype: 0=fixed, 1=spherical ("cone-twist" in the JS API), 2=revolute,
//        3=prismatic
// f: [anchorA xyz, anchorB xyz, axis xyz, limit_min, limit_max,
//     frameA quat xyzw, frameB quat xyzw]
pub const JOINT_F32_LEN: usize = 19;

/// # Safety
/// `f` must point to JOINT_F32_LEN f32s.
pub unsafe fn create_joint(
    realm: &mut PhysicsWorld,
    joint_id: i32,
    parent_body_id: i32,
    child_body_id: i32,
    jtype: i32,
    f: *const f32,
) -> i32 {
    let f = std::slice::from_raw_parts(f, JOINT_F32_LEN);
    let Some(&parent) = realm.body_map.get(&parent_body_id) else {
        return -1;
    };
    let Some(&child) = realm.body_map.get(&child_body_id) else {
        return -1;
    };

    let anchor_a = Vector::new(f[0], f[1], f[2]);
    let anchor_b = Vector::new(f[3], f[4], f[5]);
    let axis_v = Vector::new(f[6], f[7], f[8]);
    let frame_a = Rotation::from_xyzw(f[11], f[12], f[13], f[14]).normalize();
    let frame_b = Rotation::from_xyzw(f[15], f[16], f[17], f[18]).normalize();

    // Joint axes are plain normalized vectors in rapier 0.30+ (no Unit wrapper).
    let axis = if axis_v.length_squared() > 1.0e-12 {
        axis_v.normalize()
    } else {
        Vector::Y
    };

    let data: GenericJoint = match jtype {
        0 => {
            let mut j = FixedJoint::new();
            j.set_local_frame1(Pose::from_parts(anchor_a, frame_a));
            j.set_local_frame2(Pose::from_parts(anchor_b, frame_b));
            j.into()
        }
        1 => {
            let mut j = SphericalJoint::new();
            j.set_local_anchor1(anchor_a);
            j.set_local_anchor2(anchor_b);
            j.into()
        }
        2 => {
            let mut j = RevoluteJoint::new(axis);
            j.set_local_anchor1(anchor_a);
            j.set_local_anchor2(anchor_b);
            if f[9] != 0.0 || f[10] != 0.0 {
                j.set_limits([f[9], f[10]]);
            }
            j.into()
        }
        _ => {
            let mut j = PrismaticJoint::new(axis);
            j.set_local_anchor1(anchor_a);
            j.set_local_anchor2(anchor_b);
            j.set_limits([f[9], f[10]]);
            j.into()
        }
    };

    let handle = realm.impulse_joints.insert(parent, child, data, true);
    realm.joint_map.insert(joint_id, handle);
    0
}

pub fn destroy_joint(realm: &mut PhysicsWorld, joint_id: i32) -> i32 {
    if let Some(handle) = realm.joint_map.remove(&joint_id) {
        realm.impulse_joints.remove(handle, true);
    }
    0
}
