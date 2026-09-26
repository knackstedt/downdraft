// ============================================================================
// Skeleton Synthesis — build SkinData from the node hierarchy when a file has
// no skin deformers but does carry joints + animations (e.g. Mixamo clip
// exports that contain only a bone tree and an AnimationStack).
//
// The synthesized skeleton uses each node's local rest TRS (PreRotation is
// already baked into node.rotation by the FBX node interpreter) and an
// inverse bind matrix of inverse(restWorld), so bind-pose skin matrices are
// identity. Bones are emitted parents-first (DFS) as computeSkinMatrices
// requires.
// ============================================================================

import { composeMat4Into, invertMat4, multiplyMat4Into } from "@downdraft/engine";
import type { AnimationData, BoneData, ModelNode, SkinData } from "./types";

/**
 * Synthesize a SkinData skeleton from the model's node hierarchy.
 *
 * Bones = every node in the tree component(s) containing an animation target
 * (so end-bones like `HeadTop_End` are included even though they aren't
 * animated directly). If no channel target resolves to a node name, the whole
 * node tree is used — still better than nothing for skeleton visualization.
 *
 * Returns undefined when there are no nodes to build from.
 */
export function synthesizeSkeletonSkin(
  nodes: ModelNode[],
  animations: AnimationData[],
  upAxis?: "y" | "z",
): SkinData | undefined {
  if (!nodes || nodes.length === 0) return undefined;

  // node index → parent index
  const parentOf = new Int32Array(nodes.length).fill(-1);
  for (let i = 0; i < nodes.length; i++) {
    for (const c of nodes[i].children ?? []) {
      if (c >= 0 && c < nodes.length) parentOf[c] = i;
    }
  }

  // Node indices targeted by at least one animation channel.
  const nameToNode = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) {
    if (!nameToNode.has(nodes[i].name)) nameToNode.set(nodes[i].name, i);
  }
  const animated = new Set<number>();
  for (const anim of animations) {
    for (const ch of anim.channels) {
      const idx = nameToNode.get(ch.targetNode);
      if (idx !== undefined) animated.add(idx);
    }
  }

  // Bone set = all descendants of the root-most ancestors of animated nodes.
  // This captures the full skeleton subtree (including unanimated leaf bones).
  const boneSet = new Set<number>();
  if (animated.size > 0) {
    const roots = new Set<number>();
    for (const idx of animated) {
      let r = idx;
      while (parentOf[r] >= 0) r = parentOf[r];
      roots.add(r);
    }
    const stack = [...roots];
    while (stack.length > 0) {
      const i = stack.pop()!;
      if (boneSet.has(i)) continue;
      boneSet.add(i);
      for (const c of nodes[i].children ?? []) stack.push(c);
    }
  } else {
    for (let i = 0; i < nodes.length; i++) boneSet.add(i);
  }
  if (boneSet.size === 0) return undefined;

  // DFS from each bone root so parents precede children in the output array
  // (computeSkinMatrices iterates linearly and reads parent world matrices).
  const bones: BoneData[] = [];
  const boneNameToIndex = new Map<string, number>();
  const local = new Float32Array(16);
  const world = new Float32Array(16);

  const componentRoots: number[] = [];
  for (const i of boneSet) {
    if (!boneSet.has(parentOf[i])) componentRoots.push(i);
  }
  componentRoots.sort((a, b) => a - b);

  for (const root of componentRoots) {
    const stack: { node: number; parentBone: number; parentWorld: Float32Array | null }[] = [
      { node: root, parentBone: -1, parentWorld: null },
    ];
    while (stack.length > 0) {
      const { node, parentBone, parentWorld } = stack.pop()!;
      const n = nodes[node];
      const boneIdx = bones.length;

      composeMat4Into(
        n.translation ?? [0, 0, 0],
        n.rotation ?? [0, 0, 0, 1],
        n.scale ?? [1, 1, 1],
        local,
      );
      if (parentWorld) multiplyMat4Into(parentWorld, local, world);
      else world.set(local);
      // The synthesized skin's rest world matrix doubles as its bind matrix.
      const ibm = invertMat4(world);

      bones.push({
        name: n.name || `bone_${boneIdx}`,
        nodeIndex: node,
        parentIndex: parentBone,
        inverseBindMatrix: ibm,
        restTranslation: n.translation ?? [0, 0, 0],
        restRotation: n.rotation ?? [0, 0, 0, 1],
        restScale: n.scale ?? [1, 1, 1],
      });
      boneNameToIndex.set(n.name, boneIdx);

      // Push children reversed so DFS emits them in hierarchy order.
      const kids = n.children ?? [];
      const worldCopy = new Float32Array(world);
      for (let k = kids.length - 1; k >= 0; k--) {
        if (boneSet.has(kids[k])) {
          stack.push({ node: kids[k], parentBone: boneIdx, parentWorld: worldCopy });
        }
      }
    }
  }

  return { bones, boneNameToIndex, skeletonUpAxis: upAxis };
}
