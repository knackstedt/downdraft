// ============================================================================
// Pose Sampler — sample a model's animation clips into skin matrices on CPU.
//
// Shared by the model viewer's runtime animator and the asset-browser
// thumbnail pipeline (worker-side software rasterizer). buildClip() converts
// a parsed AnimationData into a core AnimationClip for a given skeleton,
// baking FBX PreRotation into rotation keyframes; PoseSampler owns the
// Skeleton, per-clip sampling, and the normalization-matrix conjugation
// (T * skinMatrix * T^-1) that maps normalized vertices to posed positions.
// ============================================================================

import {
    AnimationClip,
    invertMat4,
    multiplyMat4Into,
    quatMul,
    Skeleton,
    skinDataToSkeletonData,
    type KeyframeTrack,
    type Quat,
} from "@downdraft/engine";
import type { AnimationData, SkinData } from "./types";

/**
 * Build an AnimationClip from a parsed AnimationData, mapping channels to bone
 * indices via the skin's boneNameToIndex and baking PreRotation into rotation
 * keyframes. Returns null if no channels map to bones in this skeleton.
 */
export function buildClip(
    anim: AnimationData,
    boneNameToIndex: Map<string, number>,
): AnimationClip | null {
    const preRotations = anim.sourcePreRotations;
    const tracks: KeyframeTrack[] = [];

    for (let c = 0; c < anim.channels.length; c++) {
        const ch = anim.channels[c];
        // Resolve bone index: try the channel's target name directly.
        const boneIdx = boneNameToIndex.get(ch.targetNode);
        if (boneIdx === undefined) continue;

        const path =
            ch.path === "translation" ? "position" :
            ch.path === "rotation" ? "rotation" : "scale";
        const interpolation =
            ch.interpolation === "LINEAR" ? "linear" :
            ch.interpolation === "STEP" ? "step" : "cubicspline";

        let values = ch.keyframeValues;

        // Bake PreRotation into rotation keyframes: finalRot = preRot * lclRot.
        if (path === "rotation" && preRotations) {
            const preRot = preRotations.get(ch.targetNode);
            if (preRot) {
                const baked = new Float32Array(ch.keyframeValues.length);
                const preRotQuat: Quat = { x: preRot[0], y: preRot[1], z: preRot[2], w: preRot[3] };
                for (let k = 0; k < ch.keyframeTimes.length; k++) {
                    const v0 = k * 4;
                    const lcl: Quat = {
                        x: ch.keyframeValues[v0],
                        y: ch.keyframeValues[v0 + 1],
                        z: ch.keyframeValues[v0 + 2],
                        w: ch.keyframeValues[v0 + 3],
                    };
                    const full = quatMul(preRotQuat, lcl);
                    baked[v0] = full.x;
                    baked[v0 + 1] = full.y;
                    baked[v0 + 2] = full.z;
                    baked[v0 + 3] = full.w;
                }
                values = baked;
            }
        }

        tracks.push({
            boneName: ch.targetNode,
            boneIndex: boneIdx,
            path,
            times: ch.keyframeTimes,
            values,
            interpolation,
        });
    }

    if (tracks.length === 0) return null;
    return new AnimationClip({ name: anim.name, duration: anim.duration, tracks });
}

interface BoneTransform {
    position: [number, number, number];
    rotation: [number, number, number, number];
    scale: [number, number, number];
}

/**
 * Samples embedded animation clips for a skinned model and produces skin
 * matrices (conjugated by the skin's normalizationMatrix when present, so the
 * result applies directly to normalized mesh vertices). Also exposes the
 * animated bone world matrices for skeleton-only visualization.
 */
export class PoseSampler {
    readonly skeleton: Skeleton;
    readonly boneCount: number;
    /** Playable clips, parallel to the animations array passed in (null = no
     *  channels mapped onto this skeleton). */
    readonly clips: (AnimationClip | null)[];
    /** Flat skin matrices (boneCount * 16), updated by sample(). */
    readonly skinMatrices: Float32Array;
    /** The normalization matrix applied to mesh vertices, or null. */
    readonly normalizationMatrix: Float32Array | null;

    private bindPose: BoneTransform[];
    private positions: [number, number, number][];
    private rotations: [number, number, number, number][];
    private scales: [number, number, number][];
    private transforms: BoneTransform[];
    private normMatrixInv: Float32Array | null;
    private scratchTmp: Float32Array;
    private scratchResult: Float32Array;

    constructor(skin: SkinData, animations: AnimationData[]) {
        this.skeleton = new Skeleton(skinDataToSkeletonData(skin));
        this.boneCount = skin.bones.length;
        this.normalizationMatrix = skin.normalizationMatrix ?? null;
        this.normMatrixInv = this.normalizationMatrix ? invertMat4(this.normalizationMatrix) : null;

        this.clips = [];
        for (let i = 0; i < animations.length; i++) {
            this.clips.push(buildClip(animations[i], skin.boneNameToIndex));
        }

        const bind = this.skeleton.getBindPose();
        this.bindPose = bind.map((b) => ({
            position: [...b.position] as [number, number, number],
            rotation: [...b.rotation] as [number, number, number, number],
            scale: [...b.scale] as [number, number, number],
        }));
        this.positions = this.bindPose.map((b) => [...b.position] as [number, number, number]);
        this.rotations = this.bindPose.map((b) => [...b.rotation] as [number, number, number, number]);
        this.scales = this.bindPose.map((b) => [...b.scale] as [number, number, number]);
        this.transforms = this.bindPose.map(() => ({
            position: [0, 0, 0],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
        }));

        this.skinMatrices = new Float32Array(this.boneCount * 16);
        this.scratchTmp = new Float32Array(16);
        this.scratchResult = new Float32Array(16);
        this.sample(null);
    }

    /** Index of the first playable clip, or -1 when none mapped. */
    firstClipIndex(): number {
        for (let i = 0; i < this.clips.length; i++) {
            if (this.clips[i]) return i;
        }
        return -1;
    }

    /**
     * Sample the clip at `time` (seconds) and recompute skin matrices.
     * Pass a nullish clipIndex to use the bind pose.
     */
    sample(clipIndex: number | null, time = 0): Float32Array {
        for (let i = 0; i < this.boneCount; i++) {
            const b = this.bindPose[i];
            this.positions[i][0] = b.position[0];
            this.positions[i][1] = b.position[1];
            this.positions[i][2] = b.position[2];
            this.rotations[i][0] = b.rotation[0];
            this.rotations[i][1] = b.rotation[1];
            this.rotations[i][2] = b.rotation[2];
            this.rotations[i][3] = b.rotation[3];
            this.scales[i][0] = b.scale[0];
            this.scales[i][1] = b.scale[1];
            this.scales[i][2] = b.scale[2];
        }

        if (clipIndex !== null && clipIndex >= 0 && clipIndex < this.clips.length) {
            const clip = this.clips[clipIndex];
            if (clip) clip.sample(time, this.positions, this.rotations, this.scales);
        }

        for (let i = 0; i < this.boneCount; i++) {
            const t = this.transforms[i];
            t.position = this.positions[i];
            t.rotation = this.rotations[i];
            t.scale = this.scales[i];
        }
        const matrices = this.skeleton.computeSkinMatrices(this.transforms);

        const T = this.normalizationMatrix;
        const Tinv = this.normMatrixInv;
        if (T && Tinv) {
            const tmp = this.scratchTmp;
            const result = this.scratchResult;
            for (let i = 0; i < this.boneCount; i++) {
                const off = i * 16;
                const sm = matrices.subarray(off, off + 16);
                multiplyMat4Into(T, sm, tmp);
                multiplyMat4Into(tmp, Tinv, result);
                this.skinMatrices.set(result, off);
            }
        } else {
            this.skinMatrices.set(matrices);
        }
        return this.skinMatrices;
    }

    /**
     * Animated bone world matrices from the last sample() call, in the bone's
     * original (pre-normalization) coordinate space. Apply
     * `normalizationMatrix` to map into normalized vertex space.
     */
    getBoneWorldMatrices(): Float32Array[] {
        return this.skeleton.getWorldMatrices();
    }
}
