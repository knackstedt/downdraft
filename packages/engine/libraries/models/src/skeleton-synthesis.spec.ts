// ============================================================================
// Skeleton synthesis tests — SkinData built from node hierarchies for
// mesh-less files (animation-only FBX exports like Mixamo clips).
//
// Run: bun test packages/engine/libraries/models/src/skeleton-synthesis.spec.ts
// ============================================================================

import { describe, expect, it } from "bun:test";
import { resolve } from "path";
import { composeMat4Into, multiplyMat4Into } from "@downdraft/engine";
import { loadModel } from "./loader";
import { synthesizeSkeletonSkin } from "./skeleton-synthesis";
import type { AnimationData, ModelNode } from "./types";

const SPEC_DIR = import.meta.dirname!;

function loadRealWorld(relativePath: string): Promise<ArrayBuffer> {
  // SPEC_DIR is packages/engine/libraries/models/src/
  const abs = resolve(SPEC_DIR, "..", "..", "..", "..", "..", relativePath);
  return Bun.file(abs).arrayBuffer();
}

function node(name: string, children: number[] = [], t?: [number, number, number]): ModelNode {
  return { name, children, translation: t };
}

function animFor(targets: string[]): AnimationData {
  return {
    name: "test",
    duration: 1,
    channels: targets.map((targetNode) => ({
      targetNode,
      path: "rotation" as const,
      keyframeTimes: new Float32Array([0, 1]),
      keyframeValues: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]),
      interpolation: "LINEAR" as const,
    })),
  };
}

/** world(rest) == inverse(ibm) — multiply world*ibm should give identity. */
function expectInverseOfRestWorld(skin: NonNullable<ReturnType<typeof synthesizeSkeletonSkin>>, nodes: ModelNode[]): void {
  const parentOf = new Map<number, number>();
  nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parentOf.set(c, i)));
  const nodeToBone = new Map(skin.bones.map((b, i) => [b.nodeIndex, i]));
  const nodeWorld = nodes.map(() => new Float32Array(16));
  const local = new Float32Array(16);
  const emit = (ni: number, parentWorld: Float32Array | null) => {
    const n = nodes[ni];
    composeMat4Into(n.translation ?? [0, 0, 0], n.rotation ?? [0, 0, 0, 1], n.scale ?? [1, 1, 1], local);
    const w = nodeWorld[ni];
    if (parentWorld) multiplyMat4Into(parentWorld, local, w);
    else w.set(local);
    for (const c of n.children ?? []) emit(c, w);
  };
  nodes.forEach((_, i) => { if (!parentOf.has(i)) emit(i, null); });

  const product = new Float32Array(16);
  for (const b of skin.bones) {
    const bi = nodeToBone.get(b.nodeIndex)!;
    expect(skin.bones[bi].name).toBe(nodes[b.nodeIndex].name);
    multiplyMat4Into(nodeWorld[b.nodeIndex], b.inverseBindMatrix, product);
    // identity check (column-major)
    for (let c = 0; c < 16; c++) {
      const expected = c % 5 === 0 ? 1 : 0;
      expect(Math.abs(product[c] - expected)).toBeLessThan(1e-4);
    }
  }
}

describe("synthesizeSkeletonSkin", () => {
  it("builds bones for the subtree containing animated nodes", () => {
    // root -> hips -> spine -> head(end bone, unanimated)
    const nodes = [
      node("root", [1]),
      node("hips", [2], [0, 1, 0]),
      node("spine", [3], [0, 0.5, 0]),
      node("head", [], [0, 0.5, 0]),
    ];
    const skin = synthesizeSkeletonSkin(nodes, [animFor(["hips", "spine"])], "y");
    expect(skin).toBeDefined();
    expect(skin!.bones.map((b) => b.name)).toEqual(["root", "hips", "spine", "head"]);
    // parents-first ordering
    expect(skin!.bones.map((b) => b.parentIndex)).toEqual([-1, 0, 1, 2]);
    expect(skin!.boneNameToIndex.get("spine")).toBe(2);
    expect(skin!.bones[1].restTranslation).toEqual([0, 1, 0]);
    expect(skin!.bones[1].nodeIndex).toBe(1);
    expectInverseOfRestWorld(skin!, nodes);
  });

  it("handles multiple disconnected animated roots", () => {
    const nodes = [
      node("a", [1]),
      node("aChild", []),
      node("b", [3]),
      node("bChild", []),
    ];
    const skin = synthesizeSkeletonSkin(nodes, [animFor(["aChild", "bChild"])], "y");
    expect(skin!.bones.map((b) => b.name)).toEqual(["a", "aChild", "b", "bChild"]);
    expect(skin!.bones.map((b) => b.parentIndex)).toEqual([-1, 0, -1, 2]);
    expectInverseOfRestWorld(skin!, nodes);
  });

  it("excludes nodes outside animated subtrees when channels resolve", () => {
    const nodes = [
      node("skeleton", [1]),
      node("hips", []),
      node("unrelatedProp", []),
    ];
    const skin = synthesizeSkeletonSkin(nodes, [animFor(["hips"])], "y");
    expect(skin!.bones.map((b) => b.name)).toEqual(["skeleton", "hips"]);
    expect(skin!.boneNameToIndex.has("unrelatedProp")).toBe(false);
  });

  it("falls back to the full node tree when no channel resolves", () => {
    const nodes = [node("a", [1]), node("b", [])];
    const skin = synthesizeSkeletonSkin(nodes, [animFor(["nonexistent"])], "y");
    expect(skin!.bones.map((b) => b.name)).toEqual(["a", "b"]);
    expect(skin!.bones[1].parentIndex).toBe(0);
  });

  it("returns undefined for empty node lists", () => {
    expect(synthesizeSkeletonSkin([], [], "y")).toBeUndefined();
  });
});

describe("loadModel skeleton synthesis (real fixture)", () => {
  it("X Bot@Idle.fbx (animation-only FBX) gets a synthesized skin", async () => {
    const data = await loadRealWorld("games/to-the-ocean/src/assets/animations/human/mixamo/X Bot@Idle.fbx");
    const model = await loadModel(data, "X Bot@Idle.fbx", null, null);
    expect(model.meshes.length).toBe(0);
    expect(model.skin).toBeDefined();
    expect(model.skin!.bones.length).toBeGreaterThan(0);
    // Every bone's parent precedes it (computeSkinMatrices linear pass).
    model.skin!.bones.forEach((b, i) => {
      expect(b.parentIndex).toBeLessThan(i);
    });
    // Animation channels resolve to bones by name.
    const anim = model.animations![0];
    let mapped = 0;
    for (const ch of anim.channels) {
      if (model.skin!.boneNameToIndex.has(ch.targetNode)) mapped++;
    }
    expect(mapped).toBe(anim.channels.length);
  });
});
