// ============================================================================
// CharacterPass — renders the player as a Stylized Lowpoly Character (FBX)
//
// Wraps the engine's ModelRenderer (bindless + skinned mesh) to render the
// rigged LP_male_mesh / LP_fe_mesh FBX models in a static bind pose at the
// player's interpolated world position. Both models are loaded at init; a
// runtime gender toggle switches between them.
//
// The engine ModelRenderer uses Y-up coordinates, but overburden's world is
// Y-down. A 180° X-rotation flips the model to match. The facing direction
// (left/right) is controlled by a Y-axis yaw rotation composed from the
// blockhead's `facing` sign (-1 or 1).
// ============================================================================

import {
    BindlessFrameBindings,
    BindlessMaterialManager,
    BindlessTextureRegistry,
    eulerXYZToQuat,
    quatMul,
    Skeleton,
    skinDataToSkeletonData,
    type CameraState,
    type Quat,
} from "@downdraft/core";
import { ModelRenderer } from "@downdraft/library-entities";
import { loadModel, type MaterialData, type MeshData, type ModelData } from "@downdraft/plugin-models";

import femaleFbxUrl from "../assets/Stylized Lowpoly Characters/mesh/LP_fe_mesh.fbx?url";
import maleFbxUrl from "../assets/Stylized Lowpoly Characters/mesh/LP_male_mesh.fbx?url";
import paletteUrl from "../assets/Stylized Lowpoly Characters/textue/palette_1759686518.png?url";
import type { Mat4 } from "./matrix";

export type CharacterGender = "male" | "female";

// Player collision box dimensions (must match StickmanPass / sim constants).
const PLAYER_W = 0.7;
const PLAYER_H = 1.95;

// Z depth slab: the stickman box sat at Z=-1..0; place the character at the
// midpoint so it sits between the foreground layers.
const PLAYER_Z = -0.5;

// 180° rotation around X axis: maps (x, y, z) → (x, -y, -z).
// Flips the Y-up model into overburden's Y-down world without mirroring X.
const X_FLIP_QUAT: Quat = eulerXYZToQuat(Math.PI, 0, 0);

// Base yaw offset (radians) applied on top of the facing direction.
// The model's bind pose faces +Z (towards camera). After the 180° X-flip,
// it faces -Z (away from camera). We want facing=1 (right) → +X, so we
// rotate -90° around Y: -Z → +X.
const BASE_YAW_OFFSET = -Math.PI / 2;

// Identity matrix (column-major) for the viewMatrix slot of CameraState.
const IDENTITY_MAT4 = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
]);

interface LoadedCharacter {
    nodeId: string;
    bindPoseSkinMatrices: Float32Array;
    uniformScale: number;
    // Position offsets computed from model bounds (in overburden world units
    // after scale + flip). Added to the player's active-grid position.
    offsetX: number;
    offsetY: number;
    offsetZ: number;
}

export class CharacterPass {
    private device: GPUDevice | null = null;
    private format: GPUTextureFormat = "bgra8unorm";
    private modelRenderer: ModelRenderer | null = null;
    private registry: BindlessTextureRegistry | null = null;
    private materialManager: BindlessMaterialManager | null = null;
    private frameBindings: BindlessFrameBindings | null = null;

    private characters: Partial<Record<CharacterGender, LoadedCharacter>> = {};
    private activeGender: CharacterGender = "male";
    private ready = false;

    get isReady(): boolean { return this.ready; }
    get gender(): CharacterGender { return this.activeGender; }

    async init(device: GPUDevice, format: GPUTextureFormat): Promise<void> {
        this.device = device;
        this.format = format;

        this.registry = new BindlessTextureRegistry(device);
        this.materialManager = new BindlessMaterialManager(device);
        this.frameBindings = new BindlessFrameBindings(
            device,
            this.registry,
            this.materialManager,
        );

        this.modelRenderer = new ModelRenderer(device, format);
        this.modelRenderer.setBindlessDeps({
            registry: this.registry,
            materialManager: this.materialManager,
            bindGroupLayout: this.frameBindings.getBindGroupLayout(),
        });
        await this.modelRenderer.init();
    }

    async loadGender(gender: CharacterGender): Promise<void> {
        if (!this.modelRenderer || !this.device) return;

        const fbxUrl = gender === "male" ? maleFbxUrl : femaleFbxUrl;
        const nodeId = `player:${gender}`;

        // Fetch and parse the FBX.
        const resp = await fetch(fbxUrl);
        if (!resp.ok) throw new Error(`Failed to fetch ${gender} FBX: ${resp.status}`);
        const buffer = await resp.arrayBuffer();
        const modelData = await loadModel(buffer, `${gender}.fbx`) as ModelData;

        if (!modelData.meshes || modelData.meshes.length === 0) {
            throw new Error(`${gender} model has no meshes`);
        }

        // Inject the palette texture into the palette material (index 0).
        // The FBX references palette_1759686518.png but doesn't embed it.
        if (modelData.materials && modelData.materials.length > 0) {
            const paletteMat = modelData.materials.find(
                (m) => m.textureUri && m.textureUri.includes("palette"),
            );
            if (paletteMat && !paletteMat.textureData) {
                try {
                    const texResp = await fetch(paletteUrl);
                    if (texResp.ok) {
                        paletteMat.textureData = await texResp.arrayBuffer();
                    }
                } catch {
                    // Non-fatal: character renders with solid baseColor fallback.
                }
            }
        }

        // Filter meshes to only the base variant of each clothing/body part.
        // The FBX packs ALL variants (m_torso, m_torso.001, ..., m_torso.013)
        // into a single file. Without filtering, all 418 meshes render at once.
        // We use the node hierarchy to find mesh names and keep only the base
        // variant (no `.NNN` suffix) of each category.
        const filteredMeshes = this.filterBaseVariantMeshes(modelData);

        // Upload filtered meshes + materials to the ModelRenderer.
        this.modelRenderer.uploadModel(nodeId, filteredMeshes, modelData.materials as MaterialData[]);

        // Compute bind-pose skin matrices (static — no animation).
        let bindPose: Float32Array;
        if (modelData.skin) {
            const skeleton = new Skeleton(skinDataToSkeletonData(modelData.skin));
            bindPose = skeleton.computeSkinMatrices(skeleton.getBindPose());
        } else {
            // No skin — shouldn't happen for these models, but handle gracefully.
            bindPose = new Float32Array(0);
        }

        // Compute scale + position offsets from the model's bounds.
        // The model is Y-up with origin at the feet; overburden is Y-down.
        const bounds = modelData.bounds;
        if (!bounds) {
            throw new Error(`${gender} model has no bounds`);
        }

        const modelHeight = bounds.max[1] - bounds.min[1];
        const uniformScale = PLAYER_H / modelHeight;

        // After the 180° X-flip: (x, y, z) → (x, -y, -z)
        // Model X center: (min[0] + max[0]) / 2 — stays the same after flip.
        // Model Y: feet at min[1], head at max[1]. After flip: feet at -min[1],
        //   head at -max[1]. We want feet at posY + PLAYER_H (bottom of
        //   collision box in Y-down world).
        // Model Z center: (min[2] + max[2]) / 2. After flip: negated.
        const modelCenterX = (bounds.min[0] + bounds.max[0]) / 2;
        const modelCenterZ = (bounds.min[2] + bounds.max[2]) / 2;

        // After flip + scale, the model's feet are at Y = -bounds.min[1] * scale.
        // We want feet at (localY + PLAYER_H), so:
        //   posY + (-bounds.min[1] * scale) = localY + PLAYER_H
        //   posY = localY + PLAYER_H + bounds.min[1] * scale
        // We store the offset to add to localY: offsetY = PLAYER_H + bounds.min[1] * scale
        const offsetY = PLAYER_H + bounds.min[1] * uniformScale;

        // Horizontal centering: model center X is at 0 in model space, so
        // posX = localX + PLAYER_W/2 - modelCenterX * scale (but modelCenterX
        // may not be 0 if the model isn't perfectly centered).
        const offsetX = PLAYER_W / 2 - modelCenterX * uniformScale;

        // Z centering: after flip, Z center is -modelCenterZ. We want the
        // model centered at PLAYER_Z.
        const offsetZ = PLAYER_Z - (-modelCenterZ) * uniformScale;

        this.characters[gender] = {
            nodeId,
            bindPoseSkinMatrices: bindPose,
            uniformScale,
            offsetX,
            offsetY,
            offsetZ,
        };
    }

    /**
     * Filter the ModelData's mesh array to only include the base variant of
     * each clothing/body part. The FBX files pack all variants (e.g.
     * `m_torso`, `m_torso.001`, ..., `m_torso.013`) into one file. Without
     * filtering, all variants render simultaneously.
     *
     * Uses the node hierarchy to map mesh indices → node names, then keeps
     * only meshes whose node name has no `.NNN` variant suffix.
     */
    private filterBaseVariantMeshes(modelData: ModelData): MeshData[] {
        if (!modelData.nodes || modelData.nodes.length === 0) {
            // No node hierarchy — can't filter, return all meshes.
            return modelData.meshes;
        }

        // Build a set of mesh indices that belong to base-variant nodes.
        // A node name is a base variant if it doesn't end with `.NNN` (3+ digits).
        const baseMeshIndices = new Set<number>();
        for (const node of modelData.nodes) {
            if (node.meshes && node.meshes.length > 0) {
                if (!/\.\d{3,}$/.test(node.name)) {
                    for (const mi of node.meshes) {
                        baseMeshIndices.add(mi);
                    }
                }
            }
        }

        // Filter the meshes array to only include base-variant meshes.
        const filtered = modelData.meshes.filter((_, i) => baseMeshIndices.has(i));
        console.log(`[CharacterPass] Mesh filtering: ${modelData.meshes.length} → ${filtered.length} meshes (base variants only)`);
        return filtered;
    }

    setGender(gender: CharacterGender): void {
        if (this.characters[gender]) {
            this.activeGender = gender;
        }
    }

    /**
     * Per-frame setup: update the bindless bind group and camera state.
     * Call before `render()`.
     *
     * @param viewProj The block grid's view-projection matrix (overburden's
     *   combined viewProj, passed as the projection matrix with identity view
     *   so `calculateViewProj` returns it unchanged).
     * @param cameraPos Camera world position (for the shader's lighting).
     * @param daylightNorm Daylight level (0=night, 1=full day). Controls light
     *   direction + intensity for the character shader.
     */
    beginFrame(viewProj: Mat4, cameraPos: [number, number, number], daylightNorm: number): void {
        if (!this.modelRenderer || !this.frameBindings) return;

        const bg = this.frameBindings.prepareFrame();
        this.modelRenderer.setBindlessBindGroup(bg);

        // Compute sun direction from daylight level.
        // Overburden is Y-down, so sunlight comes from -Y (above).
        // At full day (1.0): sun is high → lightDir = (0.3, -0.9, 0.3)
        // At dawn/dusk (0.5): sun is low → lightDir = (0.6, -0.3, 0.4)
        // At night (0.0): minimal directional light, mostly ambient
        const sunAngle = daylightNorm * Math.PI * 0.5; // 0..π/2
        const sunY = -Math.sin(sunAngle) * 0.9 - 0.1;
        const sunX = Math.cos(sunAngle) * 0.4;
        const lightDir: [number, number, number] = [sunX, sunY, 0.3];
        const ambient = 0.15 + daylightNorm * 0.35; // 0.15 at night, 0.5 at day
        const intensity = daylightNorm * 0.6; // 0 at night, 0.6 at day
        this.modelRenderer.setLightState(lightDir, ambient, intensity);

        const cameraState: CameraState = {
            position: cameraPos,
            target: [0, 0, 0],
            up: [0, -1, 0], // overburden world Y is down
            fov: 60,
            near: 0.1,
            far: 1000,
            aspect: 1,
            projectionMatrix: viewProj as Float32Array,
            viewMatrix: IDENTITY_MAT4,
        };
        this.modelRenderer.beginFrame(cameraState);
    }

    /**
     * Render the active character at the player's position.
     * Must be called after `beginFrame()` and within the render pass.
     *
     * Facing logic:
     * - Moving horizontally (|vx| > threshold): face left/right based on vx sign.
     * - At rest or wall-climbing: face the camera (towards +Z).
     *
     * @param pass The active render pass encoder.
     * @param localX Player X in active-grid coords (left edge of collision box).
     * @param localY Player Y in active-grid coords (top of collision box, Y-down).
     * @param vx Player horizontal velocity (positive = moving right).
     * @param wallClimbing True when the blockhead is actively climbing a wall.
     */
    render(
        pass: GPURenderPassEncoder,
        localX: number,
        localY: number,
        vx: number,
        wallClimbing: boolean,
    ): void {
        if (!this.modelRenderer) return;

        const char = this.characters[this.activeGender];
        if (!char) return;

        // Upload bind-pose skin matrices (static, but must be set each frame
        // before render — especially after switching gender).
        if (char.bindPoseSkinMatrices.length > 0) {
            this.modelRenderer.updateSkinMatrices(char.bindPoseSkinMatrices);
        }

        // Determine yaw based on movement state.
        // After X-flip, model faces -Z. BASE_YAW_OFFSET (-π/2) maps -Z → +X (right).
        // - Moving right (vx > 0): yaw = BASE_YAW_OFFSET → faces +X (right)
        // - Moving left  (vx < 0): yaw = BASE_YAW_OFFSET + π → faces -X (left)
        // - At rest / wall-climbing: yaw = BASE_YAW_OFFSET + π/2 → faces +Z (camera)
        //   (BASE_YAW_OFFSET + π/2 = 0, which maps -Z → -Z... no.
        //   Let's compute: after X-flip faces -Z. Y rotation by θ:
        //   -Z → (sin θ, 0, -cos θ). For +Z (camera): sin θ=0, -cos θ=1 → θ=π.
        //   So facing camera = yaw = π. But BASE_YAW_OFFSET = -π/2.
        //   yaw = BASE_YAW_OFFSET + offset, so offset = π - (-π/2) = 3π/2.
        //   Simpler: just use raw yaw values without BASE_YAW_OFFSET for camera.)
        const MOVE_THRESHOLD = 0.05;
        let yaw: number;
        if (wallClimbing) {
            // Wall climbing: face away from camera (-Z).
            // After X-flip model already faces -Z, so no additional yaw needed.
            yaw = 0;
        } else if (Math.abs(vx) > MOVE_THRESHOLD) {
            // Moving horizontally: face direction of movement
            yaw = BASE_YAW_OFFSET + (vx < 0 ? Math.PI : 0);
        } else {
            // At rest: face the camera (+Z)
            // After X-flip model faces -Z; 180° Y rotation flips to +Z.
            yaw = Math.PI;
        }
        const qYaw = eulerXYZToQuat(0, yaw, 0);
        const q = quatMul(qYaw, X_FLIP_QUAT);

        const position: [number, number, number] = [
            localX + char.offsetX,
            localY + char.offsetY,
            char.offsetZ,
        ];
        const rotation: [number, number, number, number] = [q.x, q.y, q.z, q.w];
        const scale: [number, number, number] = [
            char.uniformScale,
            char.uniformScale,
            char.uniformScale,
        ];

        this.modelRenderer.render(pass, char.nodeId, position, rotation, scale);
    }

    destroy(): void {
        this.modelRenderer?.destroy();
        this.frameBindings?.destroy();
        this.materialManager?.destroy();
        this.registry?.destroy();
        this.modelRenderer = null;
        this.frameBindings = null;
        this.materialManager = null;
        this.registry = null;
        this.characters = {};
        this.ready = false;
    }
}
