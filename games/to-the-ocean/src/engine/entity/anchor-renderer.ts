import type { BackendBuffer, BackendRenderPassEncoder, BackendRenderPipeline } from "@downdraft/core/render/backend/types";
import { ANCHOR_BOW_OFFSET, ANCHOR_DEPTH } from "@shared/constants";
import { ENT, SimBufferReader } from "@shared/sim-buffer";
import { EntityType } from "@shared/types";
import { DEPTH_FORMAT, MSAA_SAMPLE_COUNT } from "../graphicsConfig";
import { BOAT_WGSL } from "../shaders/entity-shaders";
import type { EntityRenderContext } from "./render-context";

const ROPE_SEGMENTS = 16;
const MAX_DRAW_ENTITIES = 512;

interface DrawCmd {
  slot: number;
  pos: { x: number; y: number; z: number };
  scale: number;
  rot: { x: number; y: number; z: number; w: number };
  mesh: "anchor" | "chain";
}

export class AnchorRenderer {
  private ctx: EntityRenderContext;

  private anchorPipeline3D: GPURenderPipeline | BackendRenderPipeline | null = null;
  private anchorMeshVerts: GPUBuffer | BackendBuffer | null = null;
  private anchorMeshIdx: GPUBuffer | BackendBuffer | null = null;
  private anchorMeshIndexCount = 0;
  private chainLinkVerts: GPUBuffer | BackendBuffer | null = null;
  private chainLinkIdx: GPUBuffer | BackendBuffer | null = null;
  private chainLinkIndexCount = 0;

  constructor(ctx: EntityRenderContext) {
    this.ctx = ctx;
  }

  init(pbrLitPipelineLayout: GPUPipelineLayout | import("@downdraft/core/render/backend/types").BackendPipelineLayout): void {
    const device = this.ctx.device;
    const backend = this.ctx.backend;
    const format = this.ctx.format;

    // Build anchor mesh: cylindrical shank + stock, triangular flukes, crown
    const av: number[] = [];
    const ai: number[] = [];
    const darkIron = [0.22, 0.20, 0.19];
    const lightIron = [0.38, 0.35, 0.32];
    const rustColor = [0.40, 0.22, 0.12];

    const pushPrism = (cx: number, cy: number, cz: number, radius: number, length: number, sides: number, rotX: number, rotZ: number, color: number[]) => {
      const base = av.length / 9;
      const halfLen = length / 2;
      const cosX = Math.cos(rotX), sinX = Math.sin(rotX);
      const cosZ = Math.cos(rotZ), sinZ = Math.sin(rotZ);
      const rot = (x: number, y: number, z: number): [number, number, number] => {
        let ry = y * cosX - z * sinX;
        let rz = y * sinX + z * cosX;
        let rx = x * cosZ - ry * sinZ;
        ry = x * sinZ + ry * cosZ;
        return [rx, ry, rz];
      };
      for (let i = 0; i < sides; i++) {
        const a = (i / sides) * Math.PI * 2;
        const x = Math.cos(a) * radius, z = Math.sin(a) * radius;
        const [tx, ty, tz] = rot(x, halfLen, z);
        const [bx, by, bz] = rot(x, -halfLen, z);
        const [nx, ny, nz] = rot(x, 0, z);
        const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        av.push(cx + tx, cy + ty, cz + tz, nx / nl, ny / nl, nz / nl, color[0], color[1], color[2]);
        av.push(cx + bx, cy + by, cz + bz, nx / nl, ny / nl, nz / nl, color[0], color[1], color[2]);
      }
      for (let i = 0; i < sides; i++) {
        const ni = (i + 1) % sides;
        ai.push(base + i * 2, base + ni * 2, base + i * 2 + 1, base + ni * 2, base + ni * 2 + 1, base + i * 2 + 1);
      }
      const tc = av.length / 9;
      const [tcx, tcy, tcz] = rot(0, halfLen, 0);
      const [tnx, tny, tnz] = rot(0, 1, 0);
      av.push(cx + tcx, cy + tcy, cz + tcz, tnx, tny, tnz, color[0], color[1], color[2]);
      for (let i = 0; i < sides; i++) ai.push(tc, base + ((i + 1) % sides) * 2, base + i * 2);
      const bc = av.length / 9;
      const [bcx, bcy, bcz] = rot(0, -halfLen, 0);
      const [bnx, bny, bnz] = rot(0, -1, 0);
      av.push(cx + bcx, cy + bcy, cz + bcz, bnx, bny, bnz, color[0], color[1], color[2]);
      for (let i = 0; i < sides; i++) ai.push(bc, base + i * 2 + 1, base + ((i + 1) % sides) * 2 + 1);
    };

    const pushFluke = (cx: number, cy: number, cz: number, halfWidth: number, length: number, thickness: number, rotZ: number, color: number[]) => {
      const cosZ = Math.cos(rotZ), sinZ = Math.sin(rotZ);
      const rot = (x: number, y: number): [number, number] => [x * cosZ - y * sinZ, x * sinZ + y * cosZ];
      const tri: [number, number][] = [[length / 2, 0], [-length / 2, -halfWidth], [-length / 2, halfWidth]];
      const frontBase = av.length / 9;
      for (const [x, y] of tri) { const [rx, ry] = rot(x, y); av.push(cx + rx, cy + ry, cz + thickness / 2, 0, 0, 1, color[0], color[1], color[2]); }
      ai.push(frontBase, frontBase + 1, frontBase + 2);
      const backBase = av.length / 9;
      for (const [x, y] of tri) { const [rx, ry] = rot(x, y); av.push(cx + rx, cy + ry, cz - thickness / 2, 0, 0, -1, color[0], color[1], color[2]); }
      ai.push(backBase, backBase + 2, backBase + 1);
      for (let e = 0; e < 3; e++) {
        const ne = (e + 1) % 3;
        const ex = tri[ne][0] - tri[e][0], ey = tri[ne][1] - tri[e][1];
        const elen = Math.sqrt(ex * ex + ey * ey) || 1;
        const [nx, ny] = rot(ey / elen, -ex / elen);
        const [v0x, v0y] = rot(tri[e][0], tri[e][1]);
        const [v1x, v1y] = rot(tri[ne][0], tri[ne][1]);
        const sb = av.length / 9;
        av.push(cx + v0x, cy + v0y, cz + thickness / 2, nx, ny, 0, color[0], color[1], color[2]);
        av.push(cx + v1x, cy + v1y, cz + thickness / 2, nx, ny, 0, color[0], color[1], color[2]);
        av.push(cx + v1x, cy + v1y, cz - thickness / 2, nx, ny, 0, color[0], color[1], color[2]);
        av.push(cx + v0x, cy + v0y, cz - thickness / 2, nx, ny, 0, color[0], color[1], color[2]);
        ai.push(sb, sb + 1, sb + 2, sb, sb + 2, sb + 3);
      }
    };

    pushPrism(0, -0.25, 0, 0.07, 1.5, 8, 0, 0, darkIron);
    pushPrism(0, 0.3, 0, 0.04, 0.8, 8, 0, Math.PI / 2, lightIron);
    pushPrism(0, -0.95, 0, 0.05, 0.22, 8, 0, Math.PI / 2, lightIron);
    pushFluke(0.08, -0.9, 0, 0.16, 0.5, 0.025, -0.15, rustColor);
    pushFluke(-0.08, -0.9, 0, 0.16, 0.5, 0.025, Math.PI + 0.15, rustColor);
    pushPrism(0, 0.55, 0, 0.06, 0.08, 8, Math.PI / 2, 0, lightIron);

    const anchorVerts = new Float32Array(av);
    const anchorIdx = new Uint16Array(ai);
    this.anchorMeshIndexCount = anchorIdx.length;

    // Build chain link mesh
    const cv: number[] = [];
    const ci: number[] = [];
    const chainColor = [0.30, 0.27, 0.24];
    const linkSides = 6;
    const linkRadius = 0.04;
    const linkLength = 0.25;
    {
      const base = cv.length / 9;
      const halfLen = linkLength / 2;
      for (let i = 0; i < linkSides; i++) {
        const a = (i / linkSides) * Math.PI * 2;
        const x = Math.cos(a) * linkRadius, z = Math.sin(a) * linkRadius;
        cv.push(x, halfLen, z, x, 0, z, chainColor[0], chainColor[1], chainColor[2]);
        cv.push(x, -halfLen, z, x, 0, z, chainColor[0], chainColor[1], chainColor[2]);
      }
      for (let i = 0; i < linkSides; i++) {
        const ni = (i + 1) % linkSides;
        ci.push(base + i * 2, base + ni * 2, base + i * 2 + 1, base + ni * 2, base + ni * 2 + 1, base + i * 2 + 1);
      }
      const tc = cv.length / 9;
      cv.push(0, halfLen, 0, 0, 1, 0, chainColor[0], chainColor[1], chainColor[2]);
      for (let i = 0; i < linkSides; i++) ci.push(tc, base + ((i + 1) % linkSides) * 2, base + i * 2);
      const bc = cv.length / 9;
      cv.push(0, -halfLen, 0, 0, -1, 0, chainColor[0], chainColor[1], chainColor[2]);
      for (let i = 0; i < linkSides; i++) ci.push(bc, base + i * 2 + 1, base + ((i + 1) % linkSides) * 2 + 1);
    }
    const chainVerts = new Float32Array(cv);
    const chainIdx = new Uint16Array(ci);
    this.chainLinkIndexCount = chainIdx.length;

    if (backend && !device) {
      this.anchorMeshVerts = backend.createBuffer({ size: anchorVerts.byteLength, usage: 0x20 | 0x08 });
      backend.queue.writeBuffer(this.anchorMeshVerts as any, 0, anchorVerts as any);
      this.anchorMeshIdx = backend.createBuffer({ size: anchorIdx.byteLength, usage: 0x10 | 0x08 });
      backend.queue.writeBuffer(this.anchorMeshIdx as any, 0, anchorIdx as any);
      this.chainLinkVerts = backend.createBuffer({ size: chainVerts.byteLength, usage: 0x20 | 0x08 });
      backend.queue.writeBuffer(this.chainLinkVerts as any, 0, chainVerts as any);
      this.chainLinkIdx = backend.createBuffer({ size: chainIdx.byteLength, usage: 0x10 | 0x08 });
      backend.queue.writeBuffer(this.chainLinkIdx as any, 0, chainIdx as any);

      const boatShaderModule = backend.createShaderModule({ wgsl: BOAT_WGSL }, "wgsl");
      this.anchorPipeline3D = backend.createRenderPipeline({
        layout: pbrLitPipelineLayout as any,
        vertex: {
          module: boatShaderModule, entryPoint: "vs_main",
          buffers: [{ arrayStride: 36, attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
            { shaderLocation: 2, offset: 24, format: "float32x3" },
          ]}],
        },
        fragment: { module: boatShaderModule, entryPoint: "fs_main", targets: [{ format: format as any }] },
        primitive: { topology: "triangle-list" },
        multisample: { count: MSAA_SAMPLE_COUNT },
        depthStencil: { format: DEPTH_FORMAT as any, depthWriteEnabled: false, depthCompare: "always" },
      });
      return;
    }

    const dev = device!;
    const boatShaderModule = dev.createShaderModule({ code: BOAT_WGSL });
    this.anchorMeshVerts = dev.createBuffer({
      size: anchorVerts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    dev.queue.writeBuffer(this.anchorMeshVerts as any, 0, anchorVerts);
    this.anchorMeshIdx = dev.createBuffer({
      size: anchorIdx.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    dev.queue.writeBuffer(this.anchorMeshIdx as any, 0, anchorIdx);
    this.chainLinkVerts = dev.createBuffer({
      size: chainVerts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    dev.queue.writeBuffer(this.chainLinkVerts as any, 0, chainVerts);
    this.chainLinkIdx = dev.createBuffer({
      size: chainIdx.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    dev.queue.writeBuffer(this.chainLinkIdx as any, 0, chainIdx);

    this.anchorPipeline3D = dev.createRenderPipeline({
      layout: pbrLitPipelineLayout as any,
      vertex: {
        module: boatShaderModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: 36,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
            { shaderLocation: 2, offset: 24, format: "float32x3" },
          ],
        }],
      },
      fragment: {
        module: boatShaderModule,
        entryPoint: "fs_main",
        targets: [{ format }],
      },
      primitive: { topology: "triangle-list" },
      multisample: { count: MSAA_SAMPLE_COUNT },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: false,
        depthCompare: "always",
      },
    });
  }

  render(passEncoder: GPURenderPassEncoder | BackendRenderPassEncoder, simReader: SimBufferReader): void {
    const ctx = this.ctx;
    if (!this.anchorPipeline3D || !ctx.bindGroup || !ctx.uniformBuffer || !this.anchorMeshVerts || !this.anchorMeshIdx || !this.chainLinkVerts || !this.chainLinkIdx || !ctx.viewProjCache) return;
    if (!simReader.isValid()) return;

    const entityCount = simReader.getEntityCount();
    let uniformSlot = MAX_DRAW_ENTITIES - 1;
    const maxSlot = 450;

    const drawList: DrawCmd[] = [];

    for (let i = 0; i < entityCount; i++) {
      const entSlot = simReader.getEntitySlot(i);
      if (!entSlot) continue;
      const type = entSlot.u32[ENT.TYPE];
      if (type !== EntityType.Ship && type !== EntityType.SmallCraft) continue;

      const ax = entSlot.f32[ENT.DATA + 8];
      const az = entSlot.f32[ENT.DATA + 9];
      if (!Number.isFinite(ax) || !Number.isFinite(az)) continue;

      const sx = entSlot.f32[ENT.POS_X];
      const sy = entSlot.f32[ENT.POS_Y];
      const sz = entSlot.f32[ENT.POS_Z];
      const heading = entSlot.f32[ENT.DATA + 3] ?? 0;
      const bowX = sx + (-Math.sin(heading)) * ANCHOR_BOW_OFFSET;
      const bowZ = sz + (-Math.cos(heading)) * ANCHOR_BOW_OFFSET;
      const bowY = sy + 1.0;
      const anchorY = ANCHOR_DEPTH;

      if (uniformSlot < maxSlot) break;
      drawList.push({ slot: uniformSlot, pos: { x: ax, y: anchorY, z: az }, scale: 1.5, rot: { x: 0, y: 0, z: 0, w: 1 }, mesh: "anchor" });
      uniformSlot--;

      const dx = ax - bowX;
      const dz = az - bowZ;
      const vertDist = anchorY - bowY;
      const straightDist = Math.sqrt(dx * dx + dz * dz + vertDist * vertDist);
      const sag = Math.max(0, (straightDist * 1.3 - straightDist) * 0.5);

      const chainStep = Math.max(1, Math.floor(ROPE_SEGMENTS / 8));
      let prevPx = bowX, prevPy = bowY, prevPz = bowZ;
      for (let s = chainStep; s <= ROPE_SEGMENTS; s += chainStep) {
        if (uniformSlot < maxSlot) break;
        const t = s / ROPE_SEGMENTS;
        const px = bowX + dx * t;
        const catenary = 4 * sag * t * (1 - t);
        const py = bowY + vertDist * t - catenary;
        const pz = bowZ + dz * t;

        const ddx = px - prevPx, ddy = py - prevPy, ddz = pz - prevPz;
        const dlen = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz) || 1;
        const dirx = ddx / dlen, diry = ddy / dlen, dirz = ddz / dlen;

        const ax2 = -dirz, ay2 = 0, az2 = dirx;
        const axisLen = Math.sqrt(ax2 * ax2 + az2 * az2);
        let qx, qy, qz, qw;
        if (axisLen < 0.001) {
          if (diry > 0) { qx = 0; qy = 0; qz = 0; qw = 1; }
          else { qx = 1; qy = 0; qz = 0; qw = 0; }
        } else {
          const angle = Math.acos(Math.max(-1, Math.min(1, diry)));
          const halfAngle = angle / 2;
          const s2 = Math.sin(halfAngle);
          qx = (ax2 / axisLen) * s2;
          qy = (ay2 / axisLen) * s2;
          qz = (az2 / axisLen) * s2;
          qw = Math.cos(halfAngle);
        }

        drawList.push({ slot: uniformSlot, pos: { x: (px + prevPx) / 2, y: (py + prevPy) / 2, z: (pz + prevPz) / 2 }, scale: 1.0, rot: { x: qx, y: qy, z: qz, w: qw }, mesh: "chain" });
        uniformSlot--;

        prevPx = px; prevPy = py; prevPz = pz;
      }
    }

    if (drawList.length === 0) return;

    for (const d of drawList) {
      this.writeAnchorUniform(d.slot, d.pos, d.scale, d.rot);
    }

    passEncoder.setPipeline(this.anchorPipeline3D! as any);
    if (ctx.lightBindGroup) {
      passEncoder.setBindGroup(1, ctx.lightBindGroup as any);
    }
    if (ctx.pbrBindGroup) {
      passEncoder.setBindGroup(2, ctx.pbrBindGroup as any);
    }
    for (const d of drawList) {
      if (d.mesh === "anchor") {
        passEncoder.setVertexBuffer(0, this.anchorMeshVerts! as any);
        passEncoder.setIndexBuffer(this.anchorMeshIdx! as any, "uint16");
        passEncoder.setBindGroup(0, ctx.bindGroup as any, [d.slot * 256]);
        passEncoder.drawIndexed(this.anchorMeshIndexCount);
      } else {
        passEncoder.setVertexBuffer(0, this.chainLinkVerts! as any);
        passEncoder.setIndexBuffer(this.chainLinkIdx! as any, "uint16");
        passEncoder.setBindGroup(0, ctx.bindGroup as any, [d.slot * 256]);
        passEncoder.drawIndexed(this.chainLinkIndexCount);
      }
    }
  }

  private writeAnchorUniform(idx: number, pos: { x: number; y: number; z: number }, scale: number, rot: { x: number; y: number; z: number; w: number }): void {
    const ctx = this.ctx;
    if (!ctx.uniformBuffer || !ctx.viewProjCache) return;

    const uniforms = ctx.reusableUniforms;
    for (let i = 0; i < 16; i++) uniforms[i] = ctx.viewProjCache[i];
    uniforms[16] = ctx.cameraPosCache[0];
    uniforms[17] = ctx.cameraPosCache[1];
    uniforms[18] = ctx.cameraPosCache[2];
    uniforms[19] = performance.now() / 1000;
    uniforms[20] = pos.x;
    uniforms[21] = pos.y;
    uniforms[22] = pos.z;
    uniforms[23] = scale;
    uniforms[24] = rot.x;
    uniforms[25] = rot.y;
    uniforms[26] = rot.z;
    uniforms[27] = rot.w;
    const dv = new DataView(uniforms.buffer);
    dv.setUint32(112, EntityType.Ship, true);

    const lp = ctx.lightingParamsCache;
    uniforms[30] = 0;
    uniforms[31] = 0;
    uniforms[32] = lp.sunDir[0];
    uniforms[33] = lp.sunDir[1];
    uniforms[34] = lp.sunDir[2];
    uniforms[35] = lp.sunIntensity;
    uniforms[36] = lp.ambient;
    uniforms[37] = 0;
    uniforms[38] = 0;
    uniforms[39] = 0;
    uniforms[40] = lp.fogColor[0];
    uniforms[41] = lp.fogColor[1];
    uniforms[42] = lp.fogColor[2];
    uniforms[43] = 0;

    const queue = ctx.device?.queue ?? ctx.backend?.queue;
    queue?.writeBuffer(ctx.uniformBuffer as any, idx * 256, uniforms as any);
  }
}
