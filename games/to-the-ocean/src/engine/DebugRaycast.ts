// ============================================================================
// DebugRaycast — 3D aim ray visualization with entity highlighting
// Renders a depth-tested line from the player's eye in their look direction
// and highlights the hit entity's wireframe. Visible in 3rd-person & freecam.
// ============================================================================

import { BoatBufferReader } from "@shared/boat-buffer";
import {
    BOAT_CELL_WORLD_SIZE,
    BOAT_LAYER_HEIGHT,
    getCellGeometry,
    hasSolidCollision,
    isWalkableSurface,
    PLAYER_EYE_HEIGHT,
} from "@shared/constants";
import { ENT, PLR, SimBufferReader } from "@shared/sim-buffer";
import { CameraMode, EntityType } from "@shared/types";
import type { CameraState } from "./CameraSystem";
import { DEPTH_FORMAT, MSAA_SAMPLE_COUNT } from "./graphicsConfig";
import { calculateViewProj } from "./mathUtils";

const RAY_MAX_DIST = 60; // matches GUN_RANGE
const RAY_THICKNESS = 0.06; // world-space half-extent of the ray box cross-section

// WGSL shader for the debug ray + highlight wireframe
const DEBUG_RAY_WGSL = /* wgsl */ `
struct DebugRayUniforms {
  viewProj: mat4x4<f32>,
  color: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: DebugRayUniforms;

struct VSIn {
  @location(0) position: vec3<f32>,
};

struct VSOut {
  @builtin(position) clipPos: vec4<f32>,
};

@vertex
fn vs_main(input: VSIn) -> VSOut {
  var out: VSOut;
  out.clipPos = uniforms.viewProj * vec4<f32>(input.position, 1.0);
  return out;
}

@fragment
fn fs_main(input: VSOut) -> @location(0) vec4<f32> {
  return uniforms.color;
}
`;

interface RayHit {
  entityIndex: number;
  entityId: number;
  entityType: EntityType;
  worldX: number;
  worldY: number;
  worldZ: number;
  distance: number;
  // Entity transform at hit time (for highlight rendering)
  posX: number;
  posY: number;
  posZ: number;
  scale: number;
}

// Cube edge vertices (12 edges, 24 vertices) for wireframe highlight
// Cube spans [-1, +1] in all axes; scaled by entity scale at render time
const CUBE_EDGE_VERTS = new Float32Array([
  // Bottom face (y = -1)
  -1, -1, -1,  1, -1, -1,
   1, -1, -1,  1, -1,  1,
   1, -1,  1, -1, -1,  1,
  -1, -1,  1, -1, -1, -1,
  // Top face (y = +1)
  -1,  1, -1,  1,  1, -1,
   1,  1, -1,  1,  1,  1,
   1,  1,  1, -1,  1,  1,
  -1,  1,  1, -1,  1, -1,
  // Vertical edges
  -1, -1, -1, -1,  1, -1,
   1, -1, -1,  1,  1, -1,
   1, -1,  1,  1,  1,  1,
  -1, -1,  1, -1,  1,  1,
]);

// Reusable arrays to avoid per-frame allocation
const rayBoxVerts = new Float32Array(36 * 3); // 12 triangles * 3 verts * 3 floats
const cubeVerts = new Float32Array(CUBE_EDGE_VERTS.length);
const rayUniformData = new Float32Array(20); // 80 bytes
const highlightUniformData = new Float32Array(20); // 80 bytes

export class DebugRaycast {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private show = false;

  // Two pipelines: triangle-list for the ray box, line-list for the highlight wireframe
  private triPipeline: GPURenderPipeline | null = null;
  private linePipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;

  // Separate uniform buffers for ray vs highlight (avoids writeBuffer race)
  private rayUniformBuffer: GPUBuffer | null = null;
  private rayBindGroup: GPUBindGroup | null = null;
  private highlightUniformBuffer: GPUBuffer | null = null;
  private highlightBindGroup: GPUBindGroup | null = null;

  // Ray box vertex buffer (36 verts * 3 floats = 108 floats = 432 bytes)
  private rayVertBuffer: GPUBuffer | null = null;
  // Highlight cube vertex buffer (24 verts * 3 floats = 72 floats = 288 bytes)
  private cubeVertBuffer: GPUBuffer | null = null;

  // Cached viewProj (updated each frame in update())
  private viewProj: Float32Array = new Float32Array(16);

  // Current ray state
  private rayOrigin: [number, number, number] = [0, 0, 0];
  private rayEnd: [number, number, number] = [0, 0, 0];
  private hit: RayHit | null = null;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
  }

  init(): void {
    // Two uniform buffers: one for ray color, one for highlight color
    // (avoids writeBuffer race where second write overwrites first before GPU executes)
    this.rayUniformBuffer = this.device.createBuffer({
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.highlightUniformBuffer = this.device.createBuffer({
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });

    this.rayBindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.rayUniformBuffer } }],
    });
    this.highlightBindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.highlightUniformBuffer } }],
    });

    const shaderModule = this.device.createShaderModule({ code: DEBUG_RAY_WGSL });

    const blendState: GPUBlendState = {
      alpha: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
      color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
    };
    const depthState: GPUDepthStencilState = {
      format: DEPTH_FORMAT,
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    };
    const vertexState = {
      module: shaderModule,
      entryPoint: "vs_main",
      buffers: [
        {
          arrayStride: 12,
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" as GPUVertexFormat }],
        },
      ],
    };
    const fragmentState = {
      module: shaderModule,
      entryPoint: "fs_main",
      targets: [{ format: this.format, blend: blendState }],
    };

    // Triangle-list pipeline for the ray box (solid, visible at any resolution)
    this.triPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: vertexState,
      fragment: fragmentState,
      primitive: { topology: "triangle-list" },
      multisample: { count: MSAA_SAMPLE_COUNT },
      depthStencil: depthState,
    });

    // Line-list pipeline for the highlight wireframe cube
    this.linePipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: vertexState,
      fragment: fragmentState,
      primitive: { topology: "line-list" },
      multisample: { count: MSAA_SAMPLE_COUNT },
      depthStencil: depthState,
    });

    // Ray box buffer: 36 vertices * 3 floats = 432 bytes
    this.rayVertBuffer = this.device.createBuffer({
      size: 432,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    // Cube wireframe buffer: 24 vertices * 3 floats = 288 bytes
    this.cubeVertBuffer = this.device.createBuffer({
      size: CUBE_EDGE_VERTS.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
  }

  setShow(show: boolean): void {
    this.show = show;
  }

  isShown(): boolean {
    return this.show;
  }

  /**
   * Compute the raycast and cache results.
   * Called once per viewport render (only when cameraMode !== FirstPerson).
   */
  update(
    simReader: SimBufferReader,
    boatReader: BoatBufferReader | null,
    camera: CameraState,
    lookHeading: number,
    lookPitch: number,
    cameraMode: CameraMode,
  ): void {
    if (!this.show) return;
    if (cameraMode === CameraMode.FirstPerson) return;
    if (!simReader.isValid()) return;

    // Get player position from SAB
    const playerSlot = simReader.getPlayerSlot(0);
    if (!playerSlot) return;

    const px = playerSlot.f32[PLR.POS_X];
    const py = playerSlot.f32[PLR.POS_Y];
    const pz = playerSlot.f32[PLR.POS_Z];

    // Ray origin = player eye position
    const ox = px;
    const oy = py + PLAYER_EYE_HEIGHT;
    const oz = pz;

    // Ray direction from renderer-side look heading/pitch
    const cp = Math.cos(lookPitch);
    const sp = Math.sin(lookPitch);
    const dx = Math.sin(lookHeading) * cp;
    const dy = sp;
    const dz = -Math.cos(lookHeading) * cp;

    // Cache viewProj for rendering
    this.viewProj = calculateViewProj(camera);

    // Perform raycast against all entities
    const hit = this.raycastEntities(simReader, boatReader, ox, oy, oz, dx, dy, dz);

    if (hit) {
      this.rayOrigin = [ox, oy, oz];
      this.rayEnd = [hit.worldX, hit.worldY, hit.worldZ];
      this.hit = hit;
    } else {
      this.rayOrigin = [ox, oy, oz];
      this.rayEnd = [ox + dx * RAY_MAX_DIST, oy + dy * RAY_MAX_DIST, oz + dz * RAY_MAX_DIST];
      this.hit = null;
    }
  }

  /**
   * Ray-AABB slab method intersection.
   * Returns t (distance along ray) if hit, or -1 if no hit.
   */
  private rayAABB(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    minX: number, minY: number, minZ: number,
    maxX: number, maxY: number, maxZ: number,
  ): number {
    let tmin = -Infinity;
    let tmax = Infinity;

    // X axis
    if (Math.abs(dx) < 1e-10) {
      if (ox < minX || ox > maxX) return -1;
    } else {
      let t1 = (minX - ox) / dx;
      let t2 = (maxX - ox) / dx;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return -1;
    }

    // Y axis
    if (Math.abs(dy) < 1e-10) {
      if (oy < minY || oy > maxY) return -1;
    } else {
      let t1 = (minY - oy) / dy;
      let t2 = (maxY - oy) / dy;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return -1;
    }

    // Z axis
    if (Math.abs(dz) < 1e-10) {
      if (oz < minZ || oz > maxZ) return -1;
    } else {
      let t1 = (minZ - oz) / dz;
      let t2 = (maxZ - oz) / dz;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return -1;
    }

    // Must be in front of origin and within max distance
    if (tmax < 0) return -1;
    return tmin >= 0 ? tmin : tmax;
  }

  private raycastEntities(
    simReader: SimBufferReader,
    boatReader: BoatBufferReader | null,
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
  ): RayHit | null {
    const entityCount = simReader.getEntityCount();
    let bestT = RAY_MAX_DIST;
    let bestEntityIdx = -1;
    let bestEntityId = 0;
    let bestEntityType = EntityType.Player;
    let bestHitX = 0, bestHitY = 0, bestHitZ = 0;
    let bestScale = 1;

    for (let i = 0; i < entityCount; i++) {
      const slot = simReader.getEntitySlot(i);
      if (!slot) continue;

      const entId = slot.u32[ENT.ID];
      if (entId === 0) continue;

      const type = slot.u32[ENT.TYPE] as EntityType;
      const ex = slot.f32[ENT.POS_X];
      const ey = slot.f32[ENT.POS_Y];
      const ez = slot.f32[ENT.POS_Z];
      const scale = slot.f32[ENT.SCALE];
      const rx = slot.f32[ENT.ROT_X];
      const ry = slot.f32[ENT.ROT_Y];
      const rz = slot.f32[ENT.ROT_Z];
      const rw = slot.f32[ENT.ROT_W];

      if (type === EntityType.Ship || type === EntityType.SmallCraft) {
        // Per-cell raycast for boats — find matching boat slot
        if (!boatReader || !boatReader.isValid()) continue;
        const boatCount = boatReader.getBoatCount();
        let boatSlot = -1;
        for (let bs = 0; bs < boatCount; bs++) {
          if (boatReader.getBoatEntityId(bs) === entId) {
            boatSlot = bs;
            break;
          }
        }
        if (boatSlot < 0) continue;

        const cells = boatReader.getBoatCells(boatSlot);
        for (let ci = 0; ci < cells.length; ci++) {
          const cell = cells[ci];
          // Skip non-solid, non-walkable cells (RAIL, LANTERN, SAIL)
          if (!hasSolidCollision(cell.type) && !isWalkableSurface(cell.type)) continue;

          const geo = getCellGeometry(cell.type);
          // Cell local position in boat space
          const lx = cell.gridX * BOAT_CELL_WORLD_SIZE;
          const ly = cell.gridY * BOAT_LAYER_HEIGHT + geo.y0;
          const lz = cell.gridZ * BOAT_CELL_WORLD_SIZE;
          // Cell half-extents
          const hx = (geo.sizeX * BOAT_CELL_WORLD_SIZE) * 0.5;
          const hz = (geo.sizeZ * BOAT_CELL_WORLD_SIZE) * 0.5;
          const hy = (geo.y1 - geo.y0) * 0.5;
          // Cell center in local space
          const cx = lx + hx;
          const cy = ly + hy;
          const cz = lz + hz;

          // Transform center to world space via entity quaternion
          const tx = (1 - 2 * (ry * ry + rz * rz)) * cx + 2 * (rx * ry - rw * rz) * cz + 2 * (rx * rz + rw * ry) * cy;
          const ty = 2 * (rx * ry + rw * rz) * cx + (1 - 2 * (rx * rx + rz * rz)) * cy + 2 * (ry * rz - rw * rx) * cz;
          const tz = 2 * (rx * rz - rw * ry) * cx + 2 * (ry * rz + rw * rx) * cy + (1 - 2 * (rx * rx + ry * ry)) * cz;

          const worldCx = ex + tx;
          const worldCy = ey + ty;
          const worldCz = ez + tz;

          const t = this.rayAABB(
            ox, oy, oz, dx, dy, dz,
            worldCx - hx, worldCy - hy, worldCz - hz,
            worldCx + hx, worldCy + hy, worldCz + hz,
          );

          if (t > 0 && t < bestT) {
            bestT = t;
            bestEntityIdx = i;
            bestEntityId = entId;
            bestEntityType = type;
            bestHitX = ox + dx * t;
            bestHitY = oy + dy * t;
            bestHitZ = oz + dz * t;
            bestScale = scale;
          }
        }
      } else {
        // Simple bounding-box raycast for all other entity types
        // Use scale as the half-extent (islands/ports use scale as radius;
        // creatures/players use scale as approximate size)
        const halfExtent = scale > 0 ? scale : 1;
        const t = this.rayAABB(
          ox, oy, oz, dx, dy, dz,
          ex - halfExtent, ey - halfExtent, ez - halfExtent,
          ex + halfExtent, ey + halfExtent, ez + halfExtent,
        );

        if (t > 0 && t < bestT) {
          bestT = t;
          bestEntityIdx = i;
          bestEntityId = entId;
          bestEntityType = type;
          bestHitX = ox + dx * t;
          bestHitY = oy + dy * t;
          bestHitZ = oz + dz * t;
          bestScale = scale;
        }
      }
    }

    if (bestEntityIdx < 0) return null;

    // Get entity position for highlight rendering
    const slot = simReader.getEntitySlot(bestEntityIdx);
    if (!slot) return null;

    return {
      entityIndex: bestEntityIdx,
      entityId: bestEntityId,
      entityType: bestEntityType,
      worldX: bestHitX,
      worldY: bestHitY,
      worldZ: bestHitZ,
      distance: bestT,
      posX: slot.f32[ENT.POS_X],
      posY: slot.f32[ENT.POS_Y],
      posZ: slot.f32[ENT.POS_Z],
      scale: bestScale,
    };
  }

  /**
   * Build a thin box (12 triangles, 36 vertices) from origin to end.
   * The box has a small cross-section so it's visible at any resolution.
   */
  private buildRayBoxVerts(
    ox: number, oy: number, oz: number,
    ex: number, ey: number, ez: number,
    out: Float32Array,
  ): void {
    // Direction along the ray
    let dx = ex - ox;
    let dy = ey - oy;
    let dz = ez - oz;
    const dlen = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dlen < 1e-6) { dx = 0; dy = 1; dz = 0; } else { dx /= dlen; dy /= dlen; dz /= dlen; }

    // Find two perpendicular vectors U and V to the ray direction
    let ux: number, uy: number, uz: number;
    if (Math.abs(dy) < 0.99) {
      // Cross with (0,1,0)
      ux = dz; uy = 0; uz = -dx;
    } else {
      // Cross with (1,0,0)
      ux = 0; uy = -dz; uz = dy;
    }
    const ulen = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
    ux /= ulen; uy /= ulen; uz /= ulen;
    // V = cross(D, U)
    const vx = dy * uz - dz * uy;
    const vy = dz * ux - dx * uz;
    const vz = dx * uy - dy * ux;

    const r = RAY_THICKNESS;
    // 8 corners: origin ± r*U ± r*V, end ± r*U ± r*V
    // o0 = O - r*U - r*V, o1 = O + r*U - r*V, o2 = O + r*U + r*V, o3 = O - r*U + r*V
    // e0 = E - r*U - r*V, e1 = E + r*U - r*V, e2 = E + r*U + r*V, e3 = E - r*U + r*V
    const o0x = ox - r * ux - r * vx, o0y = oy - r * uy - r * vy, o0z = oz - r * uz - r * vz;
    const o1x = ox + r * ux - r * vx, o1y = oy + r * uy - r * vy, o1z = oz + r * uz - r * vz;
    const o2x = ox + r * ux + r * vx, o2y = oy + r * uy + r * vy, o2z = oz + r * uz + r * vz;
    const o3x = ox - r * ux + r * vx, o3y = oy - r * uy + r * vy, o3z = oz - r * uz + r * vz;
    const e0x = ex - r * ux - r * vx, e0y = ey - r * uy - r * vy, e0z = ez - r * uz - r * vz;
    const e1x = ex + r * ux - r * vx, e1y = ey + r * uy - r * vy, e1z = ez + r * uz - r * vz;
    const e2x = ex + r * ux + r * vx, e2y = ey + r * uy + r * vy, e2z = ez + r * uz + r * vz;
    const e3x = ex - r * ux + r * vx, e3y = ey - r * uy + r * vy, e3z = ez - r * uz + r * vz;

    // 12 triangles (2 per face, 6 faces)
    const tris = [
      // Start cap (facing -D): o0, o1, o2, o0, o2, o3
      o0x, o0y, o0z, o1x, o1y, o1z, o2x, o2y, o2z,
      o0x, o0y, o0z, o2x, o2y, o2z, o3x, o3y, o3z,
      // End cap (facing +D): e0, e2, e1, e0, e3, e2
      e0x, e0y, e0z, e2x, e2y, e2z, e1x, e1y, e1z,
      e0x, e0y, e0z, e3x, e3y, e3z, e2x, e2y, e2z,
      // Side 0: o0, e0, e1, o0, e1, o1
      o0x, o0y, o0z, e0x, e0y, e0z, e1x, e1y, e1z,
      o0x, o0y, o0z, e1x, e1y, e1z, o1x, o1y, o1z,
      // Side 1: o1, e1, e2, o1, e2, o2
      o1x, o1y, o1z, e1x, e1y, e1z, e2x, e2y, e2z,
      o1x, o1y, o1z, e2x, e2y, e2z, o2x, o2y, o2z,
      // Side 2: o2, e2, e3, o2, e3, o3
      o2x, o2y, o2z, e2x, e2y, e2z, e3x, e3y, e3z,
      o2x, o2y, o2z, e3x, e3y, e3z, o3x, o3y, o3z,
      // Side 3: o3, e3, e0, o3, e0, o0
      o3x, o3y, o3z, e3x, e3y, e3z, e0x, e0y, e0z,
      o3x, o3y, o3z, e0x, e0y, e0z, o0x, o0y, o0z,
    ];
    out.set(tris, 0);
  }

  /**
   * Render the debug ray and target highlight.
   * Called within the render pass (after renderHitboxes).
   */
  render(passEncoder: GPURenderPassEncoder): void {
    if (!this.show || !this.triPipeline || !this.linePipeline) return;
    if (!this.rayBindGroup || !this.highlightBindGroup) return;
    if (!this.rayUniformBuffer || !this.highlightUniformBuffer) return;
    if (!this.rayVertBuffer || !this.cubeVertBuffer) return;

    // --- Write all buffer data FIRST (before any draw calls) ---
    // queue.writeBuffer operations are processed before the command buffer,
    // so all writes must happen before draws are recorded.

    // Ray uniform: viewProj + cyan color
    rayUniformData.set(this.viewProj, 0);
    rayUniformData[16] = 0.0;  // r
    rayUniformData[17] = 1.0;  // g
    rayUniformData[18] = 1.0;  // b
    rayUniformData[19] = 0.7;  // a
    this.device.queue.writeBuffer(this.rayUniformBuffer, 0, rayUniformData);

    // Ray box vertices
    this.buildRayBoxVerts(
      this.rayOrigin[0], this.rayOrigin[1], this.rayOrigin[2],
      this.rayEnd[0], this.rayEnd[1], this.rayEnd[2],
      rayBoxVerts,
    );
    this.device.queue.writeBuffer(this.rayVertBuffer, 0, rayBoxVerts);

    // Highlight uniform: viewProj + yellow color
    highlightUniformData.set(this.viewProj, 0);
    highlightUniformData[16] = 1.0;  // r
    highlightUniformData[17] = 0.93; // g
    highlightUniformData[18] = 0.0;  // b
    highlightUniformData[19] = 0.9;  // a
    this.device.queue.writeBuffer(this.highlightUniformBuffer, 0, highlightUniformData);

    // Highlight cube vertices (if hit)
    if (this.hit) {
      const h = this.hit;
      const halfExtent = h.scale > 0 ? h.scale : 1;
      for (let v = 0; v < CUBE_EDGE_VERTS.length; v += 3) {
        cubeVerts[v]     = h.posX + CUBE_EDGE_VERTS[v]     * halfExtent;
        cubeVerts[v + 1] = h.posY + CUBE_EDGE_VERTS[v + 1] * halfExtent;
        cubeVerts[v + 2] = h.posZ + CUBE_EDGE_VERTS[v + 2] * halfExtent;
      }
      this.device.queue.writeBuffer(this.cubeVertBuffer, 0, cubeVerts);
    }

    // --- Now record draw commands ---

    // Draw ray box (solid, cyan)
    passEncoder.setPipeline(this.triPipeline);
    passEncoder.setBindGroup(0, this.rayBindGroup);
    passEncoder.setVertexBuffer(0, this.rayVertBuffer);
    passEncoder.draw(36); // 12 triangles * 3 verts

    // Draw highlight wireframe cube (yellow, if hit)
    if (this.hit) {
      passEncoder.setPipeline(this.linePipeline);
      passEncoder.setBindGroup(0, this.highlightBindGroup);
      passEncoder.setVertexBuffer(0, this.cubeVertBuffer);
      passEncoder.draw(24); // 12 lines * 2 verts
    }
  }

  destroy(): void {
    this.triPipeline = null;
    this.linePipeline = null;
    this.bindGroupLayout = null;
    this.rayBindGroup = null;
    this.highlightBindGroup = null;
    this.rayUniformBuffer?.destroy();
    this.highlightUniformBuffer?.destroy();
    this.rayVertBuffer?.destroy();
    this.cubeVertBuffer?.destroy();
    this.rayUniformBuffer = null;
    this.highlightUniformBuffer = null;
    this.rayVertBuffer = null;
    this.cubeVertBuffer = null;
  }
}
