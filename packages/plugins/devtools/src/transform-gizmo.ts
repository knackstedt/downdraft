// ============================================================================
// Transform Gizmo — 3D translate/rotate/scale gizmo rendered in WebGPU
// Supports omnidirectional drag (center sphere) and per-axis manipulation
// ============================================================================

import {
  calculateViewProj,
  dot3,
  invertMat4,
  normalize3,
  transformVec4,
  DEPTH_FORMAT,
  MSAA_SAMPLE_COUNT,
  type CameraState,
} from "@downdraft/core";
import type { GizmoMode } from "./index.ts";
import GIZMO_WGSL from "./shaders/transform-gizmo.wgsl?raw";


const AXIS_COLORS: [number, number, number][] = [
  [1.0, 0.2, 0.2], // X = red
  [0.2, 1.0, 0.2], // Y = green
  [0.2, 0.4, 1.0], // Z = blue
];

const HOVER_COLOR: [number, number, number] = [1.0, 1.0, 0.3]; // yellow

export type GizmoHitPart =
  | { kind: "translate"; axis: 0 | 1 | 2 }
  | { kind: "rotate"; axis: 0 | 1 | 2 }
  | { kind: "scale"; axis: 0 | 1 | 2 }
  | { kind: "omni" }
  | null;

interface DragState {
  part: NonNullable<GizmoHitPart>;
  startTransform: {
    position: [number, number, number];
    rotation: [number, number, number, number];
    scale: [number, number, number];
  };
  startMouseRay: { origin: [number, number, number]; dir: [number, number, number] };
  // For rotation
  startAngle?: number;
  // For translate axis
  startProjection?: number | null;
}

export class TransformGizmo {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;

  private vertexBuffer: GPUBuffer | null = null;
  private indexBuffer: GPUBuffer | null = null;
  private indexCount = 0;
  private indexFormat: GPUIndexFormat = "uint16";

  // State
  private position: [number, number, number] = [0, 0, 0];
  private gizmoScale = 1.0;
  private mode: GizmoMode = "translate";
  private hoverPart: GizmoHitPart = null;
  private dragState: DragState | null = null;
  private visible = false;
  private reusableUniforms = new Float32Array(64);

  // Callback when transform changes during drag
  onTransformUpdate: ((transform: {
    position?: [number, number, number];
    rotation?: [number, number, number, number];
    scale?: [number, number, number];
  }) => void) | null = null;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
  }

  async init(): Promise<void> {
    this.uniformBuffer = this.device.createBuffer({
      size: 256,
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

    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });

    const shaderModule = this.device.createShaderModule({ code: GIZMO_WGSL });
    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
        buffers: [
          {
            arrayStride: 24, // 3 floats position + 3 floats color
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "float32x3" },
            ],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [
          {
            format: this.format,
            blend: {
              color: {
                srcFactor: "src-alpha",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
              alpha: {
                srcFactor: "src-alpha",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
      multisample: { count: MSAA_SAMPLE_COUNT },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: false,
        depthCompare: "always",
      },
    });

    this.buildGeometry();
  }

  private buildGeometry(): void {
    const verts: number[] = [];
    const indices: number[] = [];
    let baseVi = 0;

    const addTri = (
      p0: [number, number, number],
      p1: [number, number, number],
      p2: [number, number, number],
      color: [number, number, number],
    ) => {
      verts.push(p0[0], p0[1], p0[2], color[0], color[1], color[2]);
      verts.push(p1[0], p1[1], p1[2], color[0], color[1], color[2]);
      verts.push(p2[0], p2[1], p2[2], color[0], color[1], color[2]);
      indices.push(baseVi, baseVi + 1, baseVi + 2);
      baseVi += 3;
    };

    const addQuad = (
      p0: [number, number, number],
      p1: [number, number, number],
      p2: [number, number, number],
      p3: [number, number, number],
      color: [number, number, number],
    ) => {
      verts.push(p0[0], p0[1], p0[2], color[0], color[1], color[2]);
      verts.push(p1[0], p1[1], p1[2], color[0], color[1], color[2]);
      verts.push(p2[0], p2[1], p2[2], color[0], color[1], color[2]);
      verts.push(p3[0], p3[1], p3[2], color[0], color[1], color[2]);
      indices.push(baseVi, baseVi + 1, baseVi + 2, baseVi, baseVi + 2, baseVi + 3);
      baseVi += 4;
    };

    // Helper: build a cylinder along an axis
    const buildCylinder = (
      axis: number,
      start: number,
      end: number,
      radius: number,
      color: [number, number, number],
      segments = 12,
    ) => {
      for (let i = 0; i < segments; i++) {
        const a0 = (i / segments) * Math.PI * 2;
        const a1 = ((i + 1) / segments) * Math.PI * 2;
        const cos0 = Math.cos(a0), sin0 = Math.sin(a0);
        const cos1 = Math.cos(a1), sin1 = Math.sin(a1);

        // Determine the two non-axis components
        const u = (axis + 1) % 3;
        const v = (axis + 2) % 3;

        const p0: number[] = [0, 0, 0];
        const p1: number[] = [0, 0, 0];
        const p2: number[] = [0, 0, 0];
        const p3: number[] = [0, 0, 0];
        p0[axis] = start; p0[u] = cos0 * radius; p0[v] = sin0 * radius;
        p1[axis] = start; p1[u] = cos1 * radius; p1[v] = sin1 * radius;
        p2[axis] = end; p2[u] = cos1 * radius; p2[v] = sin1 * radius;
        p3[axis] = end; p3[u] = cos0 * radius; p3[v] = sin0 * radius;

        addQuad(
          [p0[0], p0[1], p0[2]],
          [p1[0], p1[1], p1[2]],
          [p2[0], p2[1], p2[2]],
          [p3[0], p3[1], p3[2]],
          color,
        );
      }
    };

    // Helper: build a cone along an axis
    const buildCone = (
      axis: number,
      start: number,
      end: number,
      radius: number,
      color: [number, number, number],
      segments = 12,
    ) => {
      const u = (axis + 1) % 3;
      const v = (axis + 2) % 3;
      const tip: number[] = [0, 0, 0];
      tip[axis] = end;

      for (let i = 0; i < segments; i++) {
        const a0 = (i / segments) * Math.PI * 2;
        const a1 = ((i + 1) / segments) * Math.PI * 2;
        const p0: number[] = [0, 0, 0];
        const p1: number[] = [0, 0, 0];
        p0[axis] = start; p0[u] = Math.cos(a0) * radius; p0[v] = Math.sin(a0) * radius;
        p1[axis] = start; p1[u] = Math.cos(a1) * radius; p1[v] = Math.sin(a1) * radius;
        addTri(
          [p0[0], p0[1], p0[2]],
          [p1[0], p1[1], p1[2]],
          [tip[0], tip[1], tip[2]],
          color,
        );
      }
    };

    // Helper: build a torus perpendicular to an axis
    const buildTorus = (
      axis: number,
      majorRadius: number,
      minorRadius: number,
      color: [number, number, number],
      majorSegments = 32,
      minorSegments = 8,
    ) => {
      const u = (axis + 1) % 3;
      const v = (axis + 2) % 3;

      for (let i = 0; i < majorSegments; i++) {
        const a0 = (i / majorSegments) * Math.PI * 2;
        const a1 = ((i + 1) / majorSegments) * Math.PI * 2;
        for (let j = 0; j < minorSegments; j++) {
          const b0 = (j / minorSegments) * Math.PI * 2;
          const b1 = ((j + 1) / minorSegments) * Math.PI * 2;

          const cosA0 = Math.cos(a0), sinA0 = Math.sin(a0);
          const cosA1 = Math.cos(a1), sinA1 = Math.sin(a1);
          const cosB0 = Math.cos(b0), sinB0 = Math.sin(b0);
          const cosB1 = Math.cos(b1), sinB1 = Math.sin(b1);

          const r0 = majorRadius + minorRadius * cosB0;
          const r1 = majorRadius + minorRadius * cosB1;

          const p0: number[] = [0, 0, 0];
          const p1: number[] = [0, 0, 0];
          const p2: number[] = [0, 0, 0];
          const p3: number[] = [0, 0, 0];

          p0[u] = cosA0 * r0; p0[v] = sinA0 * r0; p0[axis] = minorRadius * sinB0;
          p1[u] = cosA1 * r0; p1[v] = sinA1 * r0; p1[axis] = minorRadius * sinB0;
          p2[u] = cosA1 * r1; p2[v] = sinA1 * r1; p2[axis] = minorRadius * sinB1;
          p3[u] = cosA0 * r1; p3[v] = sinA0 * r1; p3[axis] = minorRadius * sinB1;

          addQuad(
            [p0[0], p0[1], p0[2]],
            [p1[0], p1[1], p1[2]],
            [p2[0], p2[1], p2[2]],
            [p3[0], p3[1], p3[2]],
            color,
          );
        }
      }
    };

    // Helper: build a cube at a position
    const buildCube = (
      center: [number, number, number],
      size: number,
      color: [number, number, number],
    ) => {
      const s = size / 2;
      const [cx, cy, cz] = center;
      const p: [number, number, number][] = [
        [cx - s, cy - s, cz - s], [cx + s, cy - s, cz - s],
        [cx + s, cy + s, cz - s], [cx - s, cy + s, cz - s],
        [cx - s, cy - s, cz + s], [cx + s, cy - s, cz + s],
        [cx + s, cy + s, cz + s], [cx - s, cy + s, cz + s],
      ];
      addQuad(p[0], p[1], p[2], p[3], color); // -Z
      addQuad(p[5], p[4], p[7], p[6], color); // +Z
      addQuad(p[4], p[0], p[3], p[7], color); // -X
      addQuad(p[1], p[5], p[6], p[2], color); // +X
      addQuad(p[4], p[5], p[1], p[0], color); // -Y
      addQuad(p[3], p[2], p[6], p[7], color); // +Y
    };

    // Helper: build a sphere
    const buildSphere = (
      center: [number, number, number],
      radius: number,
      color: [number, number, number],
      segments = 16,
      rings = 12,
    ) => {
      const [cx, cy, cz] = center;
      for (let r = 0; r < rings; r++) {
        const phi0 = (r / rings) * Math.PI;
        const phi1 = ((r + 1) / rings) * Math.PI;
        for (let s = 0; s < segments; s++) {
          const theta0 = (s / segments) * Math.PI * 2;
          const theta1 = ((s + 1) / segments) * Math.PI * 2;

          const x0 = Math.sin(phi0) * Math.cos(theta0);
          const y0 = Math.cos(phi0);
          const z0 = Math.sin(phi0) * Math.sin(theta0);
          const x1 = Math.sin(phi0) * Math.cos(theta1);
          const y1 = Math.cos(phi0);
          const z1 = Math.sin(phi0) * Math.sin(theta1);
          const x2 = Math.sin(phi1) * Math.cos(theta1);
          const y2 = Math.cos(phi1);
          const z2 = Math.sin(phi1) * Math.sin(theta1);
          const x3 = Math.sin(phi1) * Math.cos(theta0);
          const y3 = Math.cos(phi1);
          const z3 = Math.sin(phi1) * Math.sin(theta0);

          addQuad(
            [cx + x0 * radius, cy + y0 * radius, cz + z0 * radius],
            [cx + x1 * radius, cy + y1 * radius, cz + z1 * radius],
            [cx + x2 * radius, cy + y2 * radius, cz + z2 * radius],
            [cx + x3 * radius, cy + y3 * radius, cz + z3 * radius],
            color,
          );
        }
      }
    };

    // Build geometry for all three modes
    // Translation: arrows on each axis + center sphere
    for (let axis = 0; axis < 3; axis++) {
      const color = AXIS_COLORS[axis];
      // Shaft
      buildCylinder(axis, 0, 0.8, 0.02, color);
      // Arrowhead (cone)
      buildCone(axis, 0.8, 1.0, 0.06, color);
    }
    // Center sphere for omnidirectional
    buildSphere([0, 0, 0], 0.12, [1.0, 1.0, 0.3]);

    // Rotation: rings perpendicular to each axis
    for (let axis = 0; axis < 3; axis++) {
      buildTorus(axis, 1.0, 0.015, AXIS_COLORS[axis]);
    }

    // Scale: small cubes at end of each axis
    for (let axis = 0; axis < 3; axis++) {
      const center: [number, number, number] = [0, 0, 0];
      center[axis] = 0.9;
      buildCube(center, 0.1, AXIS_COLORS[axis]);
    }

    // Upload geometry
    const vertData = new Float32Array(verts);
    const idxData = indices.length > 65535
      ? new Uint32Array(indices)
      : new Uint16Array(indices);
    this.indexFormat = indices.length > 65535 ? "uint32" : "uint16";
    this.indexCount = indices.length;

    this.vertexBuffer = this.device.createBuffer({
      size: vertData.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.vertexBuffer, 0, vertData as Float32Array<ArrayBuffer>);

    this.indexBuffer = this.device.createBuffer({
      size: idxData.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.indexBuffer, 0, idxData as (Uint16Array<ArrayBuffer> | Uint32Array<ArrayBuffer>));
  }

  // --- Public API ---

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) {
      this.dragState = null;
      this.hoverPart = null;
    }
  }

  isVisible(): boolean {
    return this.visible;
  }

  setPosition(pos: [number, number, number]): void {
    this.position = [...pos];
  }

  setMode(mode: GizmoMode): void {
    this.mode = mode;
  }

  getMode(): GizmoMode {
    return this.mode;
  }

  isDragging(): boolean {
    return this.dragState !== null;
  }

  // --- Rendering ---

  render(passEncoder: GPURenderPassEncoder, camera: CameraState): void {
    if (!this.visible || !this.pipeline || !this.bindGroup || !this.uniformBuffer) return;
    if (!this.vertexBuffer || !this.indexBuffer) return;

    // Scale gizmo based on distance to camera for consistent screen size
    const camPos = camera.position;
    const dx = camPos[0] - this.position[0];
    const dy = camPos[1] - this.position[1];
    const dz = camPos[2] - this.position[2];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    this.gizmoScale = Math.max(0.5, dist * 0.08);

    const viewProj = calculateViewProj(camera);
    const uniforms = this.reusableUniforms;
    for (let i = 0; i < 16; i++) uniforms[i] = viewProj[i];
    uniforms[16] = camPos[0];
    uniforms[17] = camPos[1];
    uniforms[18] = camPos[2];
    uniforms[19] = performance.now() / 1000;
    uniforms[20] = this.position[0];
    uniforms[21] = this.position[1];
    uniforms[22] = this.position[2];
    uniforms[23] = this.gizmoScale;

    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms as Float32Array<ArrayBuffer>);

    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, this.bindGroup, []);
    passEncoder.setVertexBuffer(0, this.vertexBuffer);
    passEncoder.setIndexBuffer(this.indexBuffer, this.indexFormat);
    passEncoder.drawIndexed(this.indexCount);
  }

  // --- Raycasting and Interaction ---

  hitTest(
    mouseX: number,
    mouseY: number,
    canvasW: number,
    canvasH: number,
    camera: CameraState,
  ): GizmoHitPart {
    if (!this.visible) return null;

    const ray = this.screenToRay(mouseX, mouseY, canvasW, canvasH, camera);
    const scale = this.gizmoScale;

    // Test center sphere first (omnidirectional)
    const sphereHit = this.raySphere(
      ray.origin, ray.dir,
      this.position,
      0.15 * scale,
    );
    if (sphereHit !== null) {
      return { kind: "omni" };
    }

    if (this.mode === "translate" || this.mode === "scale") {
      // Test axis arrows/cubes
      for (let axis = 0; axis < 3; axis++) {
        const axisDir: [number, number, number] = [0, 0, 0];
        axisDir[axis] = 1;

        if (this.mode === "translate") {
          // Test cylinder shaft
          const shaftHit = this.rayCylinder(
            ray.origin, ray.dir,
            this.position, axisDir,
            0.02 * scale, 0, 0.8 * scale,
          );
          if (shaftHit !== null) return { kind: "translate", axis: axis as 0 | 1 | 2 };

          // Test cone tip
          const tipCenter: [number, number, number] = [
            this.position[0] + axisDir[0] * 0.9 * scale,
            this.position[1] + axisDir[1] * 0.9 * scale,
            this.position[2] + axisDir[2] * 0.9 * scale,
          ];
          const tipHit = this.raySphere(ray.origin, ray.dir, tipCenter, 0.08 * scale);
          if (tipHit !== null) return { kind: "translate", axis: axis as 0 | 1 | 2 };
        } else if (this.mode === "scale") {
          // Test cube at end of axis
          const cubeCenter: [number, number, number] = [
            this.position[0] + axisDir[0] * 0.9 * scale,
            this.position[1] + axisDir[1] * 0.9 * scale,
            this.position[2] + axisDir[2] * 0.9 * scale,
          ];
          const cubeHit = this.raySphere(ray.origin, ray.dir, cubeCenter, 0.08 * scale);
          if (cubeHit !== null) return { kind: "scale", axis: axis as 0 | 1 | 2 };
        }
      }
    }

    if (this.mode === "rotate") {
      // Test rotation rings
      for (let axis = 0; axis < 3; axis++) {
        const ringHit = this.rayTorus(
          ray.origin, ray.dir,
          this.position, axis,
          1.0 * scale, 0.04 * scale,
        );
        if (ringHit !== null) return { kind: "rotate", axis: axis as 0 | 1 | 2 };
      }
    }

    return null;
  }

  startDrag(
    part: NonNullable<GizmoHitPart>,
    mouseX: number,
    mouseY: number,
    canvasW: number,
    canvasH: number,
    camera: CameraState,
    currentTransform: {
      position: [number, number, number];
      rotation: [number, number, number, number];
      scale: [number, number, number];
    },
  ): void {
    const ray = this.screenToRay(mouseX, mouseY, canvasW, canvasH, camera);
    this.dragState = {
      part,
      startTransform: {
        position: [...currentTransform.position] as [number, number, number],
        rotation: [...currentTransform.rotation] as [number, number, number, number],
        scale: [...currentTransform.scale] as [number, number, number],
      },
      startMouseRay: ray,
    };

    if (part.kind === "rotate") {
      // Compute initial angle on the rotation plane
      const axis = part.axis;
      const planeNormal: [number, number, number] = [0, 0, 0];
      planeNormal[axis] = 1;
      const hitPoint = this.rayPlaneIntersect(
        ray.origin, ray.dir,
        this.position, planeNormal,
      );
      if (hitPoint) {
        const u = (axis + 1) % 3;
        const v = (axis + 2) % 3;
        const dx = hitPoint[u] - this.position[u];
        const dy = hitPoint[v] - this.position[v];
        this.dragState.startAngle = Math.atan2(dy, dx);
      }
    } else if (part.kind === "translate" || part.kind === "scale") {
      // Project initial mouse ray onto axis
      const axis = part.axis;
      const axisDir: [number, number, number] = [0, 0, 0];
      axisDir[axis] = 1;
      this.dragState.startProjection = this.projectRayOntoAxis(
        ray.origin, ray.dir, this.position, axisDir,
      );
    }
  }

  updateDrag(
    mouseX: number,
    mouseY: number,
    canvasW: number,
    canvasH: number,
    camera: CameraState,
  ): void {
    if (!this.dragState || !this.onTransformUpdate) return;

    const ray = this.screenToRay(mouseX, mouseY, canvasW, canvasH, camera);
    const ds = this.dragState;
    const part = ds.part;

    if (part.kind === "omni") {
      // Screen-space translation: move parallel to camera view plane
      // Project mouse ray onto plane through gizmo position, parallel to camera
      const camForward = normalize3([
        camera.target[0] - camera.position[0],
        camera.target[1] - camera.position[1],
        camera.target[2] - camera.position[2],
      ]);

      // Get start point
      const startHit = this.rayPlaneIntersect(
        ds.startMouseRay.origin, ds.startMouseRay.dir,
        this.position, camForward,
      );
      const currentHit = this.rayPlaneIntersect(
        ray.origin, ray.dir,
        this.position, camForward,
      );

      if (startHit && currentHit) {
        const newPos: [number, number, number] = [
          ds.startTransform.position[0] + (currentHit[0] - startHit[0]),
          ds.startTransform.position[1] + (currentHit[1] - startHit[1]),
          ds.startTransform.position[2] + (currentHit[2] - startHit[2]),
        ];
        this.onTransformUpdate({ position: newPos });
      }
    } else if (part.kind === "translate") {
      const axis = part.axis;
      const axisDir: [number, number, number] = [0, 0, 0];
      axisDir[axis] = 1;
      const proj = this.projectRayOntoAxis(ray.origin, ray.dir, this.position, axisDir);
      if (ds.startProjection != null && proj != null) {
        const delta = proj - ds.startProjection;
        const newPos: [number, number, number] = [
          ds.startTransform.position[0] + axisDir[0] * delta,
          ds.startTransform.position[1] + axisDir[1] * delta,
          ds.startTransform.position[2] + axisDir[2] * delta,
        ];
        this.onTransformUpdate({ position: newPos });
      }
    } else if (part.kind === "scale") {
      const axis = part.axis;
      const axisDir: [number, number, number] = [0, 0, 0];
      axisDir[axis] = 1;
      const proj = this.projectRayOntoAxis(ray.origin, ray.dir, this.position, axisDir);
      if (ds.startProjection != null && proj != null) {
        const delta = proj - ds.startProjection;
        const factor = Math.max(0.01, 1 + delta * 0.5);
        const newScale: [number, number, number] = [
          ds.startTransform.scale[0],
          ds.startTransform.scale[1],
          ds.startTransform.scale[2],
        ];
        newScale[axis] = Math.max(0.01, ds.startTransform.scale[axis] * factor);
        this.onTransformUpdate({ scale: newScale });
      }
    } else if (part.kind === "rotate") {
      const axis = part.axis;
      const planeNormal: [number, number, number] = [0, 0, 0];
      planeNormal[axis] = 1;
      const hitPoint = this.rayPlaneIntersect(ray.origin, ray.dir, this.position, planeNormal);
      if (hitPoint && ds.startAngle !== undefined) {
        const u = (axis + 1) % 3;
        const v = (axis + 2) % 3;
        const dx = hitPoint[u] - this.position[u];
        const dy = hitPoint[v] - this.position[v];
        const angle = Math.atan2(dy, dx);
        let deltaAngle = angle - ds.startAngle;

        // Create rotation quaternion around the axis
        const halfAngle = deltaAngle / 2;
        const s = Math.sin(halfAngle);
        const c = Math.cos(halfAngle);
        const rotQuat: [number, number, number, number] = [0, 0, 0, c];
        rotQuat[axis] = s;

        // Apply to start rotation: q * startRot
        const newRot = this.multiplyQuat(rotQuat, ds.startTransform.rotation);
        this.onTransformUpdate({ rotation: newRot });
      }
    }
  }

  endDrag(): void {
    this.dragState = null;
  }

  setHover(part: GizmoHitPart): void {
    this.hoverPart = part;
  }

  // --- Math helpers ---

  private screenToRay(
    mouseX: number,
    mouseY: number,
    canvasW: number,
    canvasH: number,
    camera: CameraState,
  ): { origin: [number, number, number]; dir: [number, number, number] } {
    // Convert to NDC
    const ndcX = (mouseX / canvasW) * 2 - 1;
    const ndcY = -((mouseY / canvasH) * 2 - 1);

    // Build inverse view-projection
    const viewProj = calculateViewProj(camera);
    const invVP = invertMat4(viewProj);

    // Unproject near and far points
    const nearPoint = transformVec4(invVP, [ndcX, ndcY, -1, 1]);
    const farPoint = transformVec4(invVP, [ndcX, ndcY, 1, 1]);

    const origin: [number, number, number] = [
      nearPoint[0] / nearPoint[3],
      nearPoint[1] / nearPoint[3],
      nearPoint[2] / nearPoint[3],
    ];
    const far: [number, number, number] = [
      farPoint[0] / farPoint[3],
      farPoint[1] / farPoint[3],
      farPoint[2] / farPoint[3],
    ];
    const dir = normalize3([
      far[0] - origin[0],
      far[1] - origin[1],
      far[2] - origin[2],
    ]);

    return { origin, dir };
  }

  private raySphere(
    origin: [number, number, number],
    dir: [number, number, number],
    center: [number, number, number],
    radius: number,
  ): number | null {
    const oc: [number, number, number] = [
      origin[0] - center[0],
      origin[1] - center[1],
      origin[2] - center[2],
    ];
    const a = dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2];
    const b = 2 * (oc[0] * dir[0] + oc[1] * dir[1] + oc[2] * dir[2]);
    const c = oc[0] * oc[0] + oc[1] * oc[1] + oc[2] * oc[2] - radius * radius;
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) return null;
    const t = (-b - Math.sqrt(discriminant)) / (2 * a);
    return t >= 0 ? t : null;
  }

  private rayCylinder(
    origin: [number, number, number],
    dir: [number, number, number],
    center: [number, number, number],
    axisDir: [number, number, number],
    radius: number,
    start: number,
    end: number,
  ): number | null {
    // Transform ray to cylinder local space (cylinder along axis from center+start to center+end)
    const oc: [number, number, number] = [
      origin[0] - center[0],
      origin[1] - center[1],
      origin[2] - center[2],
    ];

    // Project oc and dir onto plane perpendicular to axis
    const dotOcAxis = oc[0] * axisDir[0] + oc[1] * axisDir[1] + oc[2] * axisDir[2];
    const dotDirAxis = dir[0] * axisDir[0] + dir[1] * axisDir[1] + dir[2] * axisDir[2];

    const perpOc: [number, number, number] = [
      oc[0] - dotOcAxis * axisDir[0],
      oc[1] - dotOcAxis * axisDir[1],
      oc[2] - dotOcAxis * axisDir[2],
    ];
    const perpDir: [number, number, number] = [
      dir[0] - dotDirAxis * axisDir[0],
      dir[1] - dotDirAxis * axisDir[1],
      dir[2] - dotDirAxis * axisDir[2],
    ];

    const a = perpDir[0] * perpDir[0] + perpDir[1] * perpDir[1] + perpDir[2] * perpDir[2];
    if (a < 1e-10) return null;
    const b = 2 * (perpOc[0] * perpDir[0] + perpOc[1] * perpDir[1] + perpOc[2] * perpDir[2]);
    const c = perpOc[0] * perpOc[0] + perpOc[1] * perpOc[1] + perpOc[2] * perpOc[2] - radius * radius;
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) return null;

    const t = (-b - Math.sqrt(discriminant)) / (2 * a);
    if (t < 0) return null;

    // Check if hit is within cylinder length
    const hitAxisPos = dotOcAxis + t * dotDirAxis;
    if (hitAxisPos < start || hitAxisPos > end) return null;

    return t;
  }

  private rayTorus(
    origin: [number, number, number],
    dir: [number, number, number],
    center: [number, number, number],
    axis: number,
    majorRadius: number,
    minorRadius: number,
  ): number | null {
    // Simplified torus intersection: test against the ring circle with tolerance
    const planeNormal: [number, number, number] = [0, 0, 0];
    planeNormal[axis] = 1;

    const hitPoint = this.rayPlaneIntersect(origin, dir, center, planeNormal);
    if (!hitPoint) return null;

    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    const dx = hitPoint[u] - center[u];
    const dy = hitPoint[v] - center[v];
    const distFromCenter = Math.sqrt(dx * dx + dy * dy);

    // Check if hit is near the ring (within minorRadius)
    if (Math.abs(distFromCenter - majorRadius) < minorRadius) {
      // Compute t (distance along ray)
      const t = Math.sqrt(
        (hitPoint[0] - origin[0]) ** 2 +
        (hitPoint[1] - origin[1]) ** 2 +
        (hitPoint[2] - origin[2]) ** 2,
      );
      return t;
    }
    return null;
  }

  private rayPlaneIntersect(
    origin: [number, number, number],
    dir: [number, number, number],
    planePoint: [number, number, number],
    planeNormal: [number, number, number],
  ): [number, number, number] | null {
    const denom =
      dir[0] * planeNormal[0] +
      dir[1] * planeNormal[1] +
      dir[2] * planeNormal[2];
    if (Math.abs(denom) < 1e-10) return null;

    const t =
      ((planePoint[0] - origin[0]) * planeNormal[0] +
        (planePoint[1] - origin[1]) * planeNormal[1] +
        (planePoint[2] - origin[2]) * planeNormal[2]) /
      denom;

    if (t < 0) return null;

    return [
      origin[0] + t * dir[0],
      origin[1] + t * dir[1],
      origin[2] + t * dir[2],
    ];
  }

  private projectRayOntoAxis(
    rayOrigin: [number, number, number],
    rayDir: [number, number, number],
    axisPoint: [number, number, number],
    axisDir: [number, number, number],
  ): number | null {
    // Find the closest point between the ray and the axis line
    // Returns the distance along the axis from axisPoint
    const w: [number, number, number] = [
      rayOrigin[0] - axisPoint[0],
      rayOrigin[1] - axisPoint[1],
      rayOrigin[2] - axisPoint[2],
    ];

    const a = dot3(rayDir, rayDir);
    const b = dot3(rayDir, axisDir);
    const c = dot3(axisDir, axisDir);
    const d = dot3(rayDir, w);
    const e = dot3(axisDir, w);

    const denom = a * c - b * b;
    if (Math.abs(denom) < 1e-10) return null;

    // Parameter along the axis line
    const t = (b * e - c * d) / denom;
    return t;
  }

  private multiplyQuat(
    a: [number, number, number, number],
    b: [number, number, number, number],
  ): [number, number, number, number] {
    return [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];
  }

  destroy(): void {
    this.vertexBuffer?.destroy();
    this.indexBuffer?.destroy();
    this.uniformBuffer?.destroy();
  }
}
