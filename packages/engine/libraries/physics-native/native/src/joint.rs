use rapier3d::na::{Quaternion, Unit, UnitQuaternion};
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

    let anchor_a = Point::new(f[0], f[1], f[2]);
    let anchor_b = Point::new(f[3], f[4], f[5]);
    let axis_v = vector![f[6], f[7], f[8]];
    let frame_a = UnitQuaternion::from_quaternion(Quaternion::new(f[14], f[11], f[12], f[13]));
    let frame_b = UnitQuaternion::from_quaternion(Quaternion::new(f[18], f[15], f[16], f[17]));

    let data: GenericJoint = match jtype {
        0 => {
            let mut j = FixedJoint::new();
            j.set_local_frame1(Isometry::from_parts(Translation::from(anchor_a.coords), frame_a));
            j.set_local_frame2(Isometry::from_parts(Translation::from(anchor_b.coords), frame_b));
            j.into()
        }
        1 => {
            let mut j = SphericalJoint::new();
            j.set_local_anchor1(anchor_a);
            j.set_local_anchor2(anchor_b);
            j.into()
        }
        2 => {
            let axis = Unit::try_new(axis_v, 1.0e-6)
                .unwrap_or_else(|| Unit::new_unchecked(vector![0.0, 1.0, 0.0]));
            let mut j = RevoluteJoint::new(axis);
            j.set_local_anchor1(anchor_a);
            j.set_local_anchor2(anchor_b);
            if f[9] != 0.0 || f[10] != 0.0 {
                j.set_limits([f[9], f[10]]);
            }
            j.into()
        }
        _ => {
            let axis = Unit::try_new(axis_v, 1.0e-6)
                .unwrap_or_else(|| Unit::new_unchecked(vector![0.0, 1.0, 0.0]));
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
