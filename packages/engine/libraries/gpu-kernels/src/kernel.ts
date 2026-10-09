// ============================================================================
// kernel.ts — GpuKernel host: transpiled JS kernels on the *shared* GPUDevice.
//
// Unlike gpu.js, a GpuKernel never creates its own device — it runs on the
// game's existing GPUDevice, so `resultBuffer` (or `dispatchInto` targets) can
// be bound straight into renderer/compute pipelines with no CPU round-trip.
// `readInto(view)` writes results into caller memory — including Float32Array
// views over SharedArrayBuffer for sim-worker handoff. `cpu()`/`cpuInto()` are
// the deterministic fallback (plain JS execution — the kernel is already JS).
// ============================================================================

import { transpileKernel, type KernelArgKind, type TranspileResult } from "./transpile";

/** GPUBufferUsage flags — defined locally (no GPUBufferUsage global on native). */
const BU = {
  MAP_READ: 0x1,
  COPY_SRC: 0x4,
  COPY_DST: 0x8,
  STORAGE: 0x80,
} as const;

const MAP_MODE_READ = 0x1;

export type KernelArg = ArrayBufferView | number | GPUBuffer;
export type KernelFn = (this: KernelThis, ...args: any[]) => number | number[];

/** The `this` shape kernels see. `constants` is the option map verbatim. */
export interface KernelThis {
  thread: { x: number; y: number; z: number };
  output: { x: number; y: number; z: number };
  constants: Record<string, number>;
}

export interface KernelOptions {
  /** The shared device — kernels never own a device (that's the point). */
  device: GPUDevice;
  /** Kernel function (or its source). See README for the dialect. */
  fn: KernelFn | string;
  /** Element grid: [x] | [x, y] | [x, y, z]. One invocation per element. */
  output: [number] | [number, number] | [number, number, number];
  /** f32 components written per element; >1 needs `return [a, b, ...]`. */
  outputStride?: 1 | 2 | 3 | 4;
  /** Baked `this.constants.NAME` values. `RAND_SEED` (u32) seeds Math.random(). */
  constants?: Record<string, number>;
  /** Per-param-position access for array/buffer args (default "read"). */
  access?: ("read" | "read_write")[];
  workgroupSize?: [number, number, number];
  /**
   * Caller-owned output buffer — the kernel writes into it directly
   * (zero-copy; e.g. a vertex/storage buffer the renderer binds).
   * Must have STORAGE usage; add COPY_SRC if you also want read()/readInto().
   */
  outputBuffer?: GPUBuffer;
  /** Extra GPUBufferUsage bits for the kernel-owned result buffer. */
  outputUsage?: number;
  /**
   * Pin the argument signature and compile eagerly. Per param:
   * "array" (TypedArray), "buffer" (GPUBuffer, bound directly), "scalar"
   * (number). Inferred from the first call's args if omitted.
   */
  argKinds?: KernelArgKind[];
  /**
   * Cap on kernel-owned GPU memory in bytes (upload buffers, scalar
   * buffers, result buffer, staging). On mobile, GPU memory is unified
   * system RAM and true OOM kills the PROCESS (lmkd), not the allocation —
   * a budget turns that into a catchable error. `allocatedBytes` reports
   * the current usage. Unlimited if unset.
   */
  memoryBudget?: number;
  label?: string;
}

interface CompiledUnit {
  sig: string;
  transpiled: TranspileResult;
  pipeline: GPUComputePipeline;
  bindGroupLayout: GPUBindGroupLayout;
  /** Cached upload buffers for TypedArray args, by param index. */
  uploadBuffers: Map<number, GPUBuffer>;
  uploadSizes: Map<number, number>;
  /** Current arg byte lengths (arrayLength of the next dispatch). */
  argBytes: Map<number, number>;
  /** Bound region sizes for array args in the cached bindGroup — drives
   *  `arg.length` correctness when a smaller array follows a bigger one. */
  boundSizes: Map<number, number>;
  /** Scalar args as (param index → scalars slot), precomputed at compile. */
  scalarInputs: { index: number; slot: number }[];
  scalarsBuffer: GPUBuffer | null;
  scalarsScratch: Float32Array | null;
  bindGroup: GPUBindGroup | null;
  bindGroupOut: GPUBuffer | null;
  /** Buffer args bound in the cached bindGroup, by param index. */
  boundBuffers: Map<number, GPUBuffer>;
}

function isGPUBuffer(a: unknown): a is GPUBuffer {
  return typeof a === "object" && a !== null &&
    typeof (a as GPUBuffer).mapAsync === "function" &&
    typeof (a as GPUBuffer).destroy === "function";
}

function kindOf(a: KernelArg): KernelArgKind {
  if (typeof a === "number") return "scalar";
  if (ArrayBuffer.isView(a)) return "array";
  if (isGPUBuffer(a)) return "buffer";
  throw new Error(`kernel arg must be a TypedArray, number, or GPUBuffer — got ${typeof a}`);
}

/** Array args are f32 storage — coerce non-f32 views (value conversion). */
function asF32View(a: ArrayBufferView): Float32Array {
  if (a instanceof Float32Array) return a;
  if (a instanceof DataView) {
    throw new Error(`DataView args aren't supported — pass a Float32Array`);
  }
  // Uint32/Int32/Float64/Uint8/... → element-wise conversion, matching cpu().
  return new Float32Array(a as unknown as ArrayLike<number>);
}

export class GpuKernel {
  readonly outputSize: [number, number, number];
  readonly outputStride: number;
  /** Total elements dispatched per call. */
  readonly outputCount: number;
  /** Floats per call result (outputCount * outputStride). */
  readonly resultFloats: number;

  private device: GPUDevice;
  private fn: KernelFn;
  private source: string;
  private constants: Record<string, number>;
  private access?: ("read" | "read_write")[];
  private workgroupSize: [number, number, number];
  private label: string;
  private units = new Map<string, CompiledUnit>();
  private ownedResult: GPUBuffer | null = null;
  private externalResult: GPUBuffer | null = null;
  private staging: GPUBuffer | null = null;
  private memoryBudget?: number;
  private destroyed = false;
  private isArrow: boolean;
  private cpuConstants: Readonly<Record<string, number>>;
  private readTail: Promise<unknown> = Promise.resolve();
  /** Last validation error from a fire-and-forget dispatch (error scope). */
  lastError: string | null = null;

  constructor(opts: KernelOptions) {
    this.device = opts.device;
    this.source = typeof opts.fn === "string" ? opts.fn : fnSource(opts.fn);
    this.fn = typeof opts.fn === "string"
      ? (new Function(`"use strict"; return (${opts.fn});`) as () => KernelFn)()
      : opts.fn;
    this.isArrow = this.source.includes("=>");
    this.cpuConstants = Object.freeze({ ...opts.constants });
    const o = opts.output;
    if (o.length > 3) {
      throw new Error(`kernel output must have 1–3 dims, got ${o.length}`);
    }
    this.outputSize = [o[0], o[1] ?? 1, o[2] ?? 1];
    this.outputCount = this.outputSize[0] * this.outputSize[1] * this.outputSize[2];
    this.outputStride = opts.outputStride ?? 1;
    this.resultFloats = this.outputCount * this.outputStride;
    this.outputSize.forEach((d) => {
      if (!Number.isInteger(d) || d <= 0) {
        throw new Error(`kernel output dims must be positive integers, got ${d}`);
      }
    });
    if (!Number.isInteger(this.outputStride) || this.outputStride < 1 || this.outputStride > 4) {
      throw new Error(`outputStride must be an integer 1–4, got ${this.outputStride}`);
    }
    this.constants = opts.constants ?? {};
    opts.access?.forEach((a) => {
      if (a !== "read" && a !== "read_write") {
        throw new Error(`kernel access entries must be "read" or "read_write", got ${JSON.stringify(a)}`);
      }
    });
    this.access = opts.access;
    const [, oy, oz] = this.outputSize;
    this.workgroupSize = opts.workgroupSize ?? (oy === 1 && oz === 1 ? [64, 1, 1] : [8, 8, 1]);
    const [wx, wy, wz] = this.workgroupSize;
    this.label = opts.label ?? "gpu-kernel";
    const lim = this.device?.limits as {
      maxComputeWorkgroupSizeX?: number;
      maxComputeWorkgroupSizeY?: number;
      maxComputeWorkgroupSizeZ?: number;
      maxComputeInvocationsPerWorkgroup?: number;
    } | undefined;
    if (lim) {
      const perDim = wx > (lim.maxComputeWorkgroupSizeX ?? wx)
        || wy > (lim.maxComputeWorkgroupSizeY ?? wy)
        || wz > (lim.maxComputeWorkgroupSizeZ ?? wz);
      const total = wx * wy * wz > (lim.maxComputeInvocationsPerWorkgroup ?? wx * wy * wz);
      if (perDim || total) {
        throw new Error(`kernel "${this.label}": workgroupSize ${wx}×${wy}×${wz} exceeds device limits`);
      }
    }
    this.memoryBudget = opts.memoryBudget;
    this.extraUsage = opts.outputUsage ?? 0;
    this.externalResult = opts.outputBuffer ?? null;
    if (this.externalResult && this.externalResult.size < Math.max(this.resultFloats * 4, 16)) {
      throw new Error(
        `kernel "${this.label}": outputBuffer is ${this.externalResult.size}B, needs ${Math.max(this.resultFloats * 4, 16)}B`);
    }
    if (opts.argKinds) this.unitForKinds(opts.argKinds); // eager compile
  }

  /** Bytes of GPU memory currently held by kernel-owned buffers. */
  get allocatedBytes(): number {
    let total = (this.ownedResult?.size ?? 0) + (this.staging?.size ?? 0);
    this.units.forEach((u) => {
      u.uploadBuffers.forEach((buf) => { total += buf.size; });
      total += u.scalarsBuffer?.size ?? 0;
    });
    return total;
  }

  /** Throws if allocating `additional` bytes (net of `freed`) would exceed
   *  the memoryBudget — turns mobile OOM process-death into a catchable
   *  error. */
  private checkBudget(additional: number, freed = 0): void {
    if (this.memoryBudget === undefined) return;
    const projected = this.allocatedBytes - freed + additional;
    if (projected > this.memoryBudget) {
      throw new Error(
        `kernel "${this.label}": allocation would use ${projected}B of GPU memory, ` +
        `memoryBudget is ${this.memoryBudget}B`);
    }
  }

  /** The buffer the kernel writes — bind it anywhere on this device. */
  get resultBuffer(): GPUBuffer {
    if (this.destroyed) throw new Error(`kernel "${this.label}" is destroyed`);
    if (this.externalResult) return this.externalResult;
    if (!this.ownedResult) {
      const size = Math.max(this.resultFloats * 4, 16);
      this.checkBudget(size);
      this.ownedResult = this.device.createBuffer({
        label: `${this.label}:result`,
        size,
        usage: BU.STORAGE | BU.COPY_SRC | BU.COPY_DST | this.extraUsage,
      });
    }
    return this.ownedResult;
  }

  private extraUsage: number;

  /** Generated WGSL — null until the first dispatch (or argKinds eager path). */
  get wgsl(): string | null {
    const u = this.units.values().next().value;
    return u ? u.transpiled.wgsl : null;
  }

  // ── dispatch ─────────────────────────────────────────────────────────────

  /** Encode + submit a dispatch writing to `resultBuffer`. Fire-and-forget. */
  dispatch(...args: KernelArg[]): void {
    const enc = this.device.createCommandEncoder({ label: this.label });
    this.encodeDispatch(enc, this.resultBuffer, ...args);
    this.submit(enc);
  }

  /** Encode + submit a dispatch writing into a caller buffer (zero-copy). */
  dispatchInto(out: GPUBuffer, ...args: KernelArg[]): void {
    const enc = this.device.createCommandEncoder({ label: this.label });
    this.encodeDispatch(enc, out, ...args);
    this.submit(enc);
  }

  /**
   * Encode a dispatch into a caller-owned encoder — batch kernels with your
   * own passes in one submit. `out` of null writes to `resultBuffer`.
   */
  encodeDispatch(enc: GPUCommandEncoder, out: GPUBuffer | null, ...args: KernelArg[]): void {
    this.encode(enc, args, out ?? this.resultBuffer, null);
  }

  /** Dispatch and read the result back. */
  async read(...args: KernelArg[]): Promise<Float32Array> {
    const view = await this.readback(args);
    return new Float32Array(view);
  }

  /**
   * Dispatch and read results into `view` — which may be a Float32Array over
   * a SharedArrayBuffer (the SAB handoff path). Returns `view`.
   */
  async readInto<T extends { set: (a: ArrayLike<number>) => void; length: number }>(
    view: T, ...args: KernelArg[]
  ): Promise<T> {
    if (view.length < this.resultFloats) {
      throw new Error(`readInto view too small — need ${this.resultFloats} floats, have ${view.length}`);
    }
    const ab = await this.readback(args);
    view.set(new Float32Array(ab));
    return view;
  }

  /** Read the current `resultBuffer` WITHOUT dispatching again. */
  async readResult(): Promise<Float32Array> {
    return new Float32Array(await this.mapResult());
  }

  /** Like `readResult` but into a caller view (SAB-friendly). */
  async readResultInto<T extends { set: (a: ArrayLike<number>) => void; length: number }>(view: T): Promise<T> {
    if (view.length < this.resultFloats) {
      throw new Error(`readResultInto view too small — need ${this.resultFloats} floats, have ${view.length}`);
    }
    view.set(new Float32Array(await this.mapResult()));
    return view;
  }

  /**
   * Readbacks are serialized — the shim's mapAsync blocks until the GPU work
   * completes, and concurrent mappers on one staging buffer would collide.
   */
  private readback(args: KernelArg[]): Promise<ArrayBuffer> {
    const run = this.readTail.then(() => this.doReadback(args));
    this.readTail = run.catch(() => {});
    return run;
  }

  private async doReadback(args: KernelArg[]): Promise<ArrayBuffer> {
    const bytes = Math.max(this.resultFloats * 4, 16);
    this.ensureStaging(bytes);
    const enc = this.device.createCommandEncoder({ label: this.label });
    this.encode(enc, args, this.resultBuffer, this.staging!);
    await this.submit(enc, true);
    return this.mapStaging(bytes);
  }

  private ensureStaging(bytes: number): void {
    if (!this.staging || this.staging.size < bytes) {
      this.checkBudget(bytes, this.staging?.size ?? 0);
      this.staging?.destroy();
      this.staging = this.device.createBuffer({
        label: `${this.label}:readback`,
        size: bytes,
        usage: BU.MAP_READ | BU.COPY_DST,
      });
    }
  }

  private mapResult(): Promise<ArrayBuffer> {
    const run = this.readTail.then(async () => {
      const bytes = Math.max(this.resultFloats * 4, 16);
      this.ensureStaging(bytes);
      const enc = this.device.createCommandEncoder({ label: this.label });
      enc.copyBufferToBuffer(this.resultBuffer, 0, this.staging!, 0, bytes);
      await this.submit(enc, true);
      return this.mapStaging(bytes);
    });
    this.readTail = run.catch(() => {});
    return run;
  }

  private async mapStaging(bytes: number): Promise<ArrayBuffer> {
    const buf = this.staging!;
    await buf.mapAsync(MAP_MODE_READ);
    // destroy() may have dropped the staging ref while the map was in flight.
    if (this.staging !== buf) {
      buf.unmap();
      throw new Error(`kernel "${this.label}" was destroyed during readback`);
    }
    try {
      return buf.getMappedRange(0, bytes).slice(0);
    } finally {
      buf.unmap();
    }
  }

  /**
   * Submit with a validation error scope so encode/submit failures surface
   * instead of being silently dropped. `raise` throws; otherwise the error
   * lands on `lastError` (fire-and-forget dispatches stay synchronous).
   */
  private submit(enc: GPUCommandEncoder, raise = false): Promise<void> {
    this.device.pushErrorScope("validation");
    const cmd = enc.finish();
    this.device.queue.submit([cmd]);
    const popped = this.device.popErrorScope();
    const done = popped.then((err) => {
      const shimInvalid = (cmd as unknown as { invalid?: boolean }).invalid === true;
      const message = err ? err.message : shimInvalid ? "command buffer failed validation" : null;
      if (!message) {
        this.lastError = null;
        return;
      }
      this.lastError = `kernel "${this.label}": ${message}`;
      if (raise) throw new Error(this.lastError);
      // fire-and-forget: leave it on lastError rather than unhandled-reject
    });
    return done;
  }

  // ── CPU fallback ─────────────────────────────────────────────────────────

  /**
   * Run the kernel on the CPU — plain JS per-element execution. Deterministic
   * (f64 math — may differ from GPU f32 in the last ulps). GPUBuffer args
   * aren't readable on CPU and will throw.
   */
  cpu(...args: KernelArg[]): Float32Array {
    const out = new Float32Array(this.resultFloats);
    this.cpuInto(out, ...args);
    return out;
  }

  /** CPU execution into a caller view (SAB-friendly). Returns `view`. */
  cpuInto<T extends { [i: number]: number; length: number }>(view: T, ...args: KernelArg[]): T {
    if (view.length < this.resultFloats) {
      throw new Error(`cpuInto view too small — need ${this.resultFloats} floats, have ${view.length}`);
    }
    if (this.isArrow) {
      throw new Error(
        `kernel "${this.label}" is an arrow function — 'this' is lexical, so cpu() can't bind this.thread. Use a function expression`);
    }
    if (args.length !== this.fn.length) {
      throw new Error(`kernel "${this.label}" expects ${this.fn.length} args, got ${args.length}`);
    }
    args.forEach((a) => {
      if (isGPUBuffer(a)) throw new Error(`cpu() can't take GPUBuffer args — no CPU-side view of device memory`);
    });
    const [ox, oy, oz] = this.outputSize;
    const self: KernelThis = {
      thread: { x: 0, y: 0, z: 0 },
      output: { x: ox, y: oy, z: oz },
      constants: this.cpuConstants as Record<string, number>,
    };
    const fn = this.fn;
    const stride = this.outputStride;
    let k = 0;
    for (let z = 0; z < oz; z++) {
      for (let y = 0; y < oy; y++) {
        for (let x = 0; x < ox; x++) {
          self.thread.x = x; self.thread.y = y; self.thread.z = z;
          const r = fn.apply(self, args);
          if (stride === 1) {
            if (Array.isArray(r)) {
              throw new Error(`kernel "${this.label}" returned an array but outputStride is 1`);
            }
            view[k++] = (r as number) ?? 0; // fall-through returns produce 0 like the GPU
          } else {
            if (!Array.isArray(r) || r.length !== stride) {
              throw new Error(
                `kernel "${this.label}" must return a ${stride}-element array (outputStride)`);
            }
            for (let c = 0; c < stride; c++) view[k++] = r[c];
          }
        }
      }
    }
    return view;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const u of this.units.values()) {
      for (const b of u.uploadBuffers.values()) b.destroy();
      u.scalarsBuffer?.destroy();
    }
    this.units.clear();
    this.ownedResult?.destroy();
    this.staging?.destroy();
    this.ownedResult = null;
    this.externalResult = null; // caller-owned — released, not destroyed
    this.staging = null;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private unitForKinds(kinds: KernelArgKind[]): CompiledUnit {
    const sig = kinds.join(",");
    let unit = this.units.get(sig);
    if (unit) return unit;
    if (this.units.size >= 16) {
      throw new Error(
        `kernel "${this.label}" has compiled ${this.units.size} arg signatures — pin argKinds`);
    }
    const transpiled = transpileKernel(this.source, {
      output: this.outputSize,
      outputStride: this.outputStride,
      constants: this.constants,
      argKinds: kinds,
      argAccess: this.access,
      workgroupSize: this.workgroupSize,
    });
    const module = this.device.createShaderModule({ label: this.label, code: transpiled.wgsl });
    const pipeline = this.device.createComputePipeline({
      label: this.label,
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
    const scalarInputs: { index: number; slot: number }[] = [];
    transpiled.scalarSlots.forEach((slot, name) => {
      scalarInputs.push({ index: transpiled.paramOrder.indexOf(name), slot });
    });
    unit = {
      sig,
      transpiled,
      pipeline,
      bindGroupLayout: pipeline.getBindGroupLayout(0),
      uploadBuffers: new Map(),
      uploadSizes: new Map(),
      argBytes: new Map(),
      boundSizes: new Map(),
      scalarInputs,
      scalarsBuffer: null,
      scalarsScratch: null,
      bindGroup: null,
      bindGroupOut: null,
      boundBuffers: new Map(),
    };
    this.units.set(sig, unit);
    return unit;
  }

  private unitForArgs(args: KernelArg[]): CompiledUnit {
    return this.unitForKinds(args.map(kindOf));
  }

  /** Upload args to device buffers; returns true if any binding changed. */
  private marshal(unit: CompiledUnit, args: KernelArg[]): boolean {
    let rebuilt = false;
    unit.transpiled.bindings.forEach((b) => {
      const arg = args[b.index];
      if (b.kind === "buffer") return; // bound directly
      const data = asF32View(arg as ArrayBufferView);
      const bytes = data.byteLength;
      const maxBuf = (this.device.limits as { maxBufferSize?: number | bigint } | undefined)
        ?.maxBufferSize;
      if (maxBuf !== undefined && bytes > Number(maxBuf)) {
        throw new Error(
          `kernel "${this.label}": array arg "${b.param}" is ${bytes}B, device limit is ${maxBuf}B (maxBufferSize)`);
      }
      let buf = unit.uploadBuffers.get(b.index);
      if (!buf || (unit.uploadSizes.get(b.index) ?? 0) < bytes) {
        const newSize = Math.max(bytes, 16);
        this.checkBudget(newSize, buf?.size ?? 0);
        buf?.destroy();
        buf = this.device.createBuffer({
          label: `${this.label}:${b.param}`,
          size: newSize,
          usage: BU.STORAGE | BU.COPY_DST | (b.access === "read_write" ? BU.COPY_SRC : 0),
        });
        unit.uploadBuffers.set(b.index, buf);
        unit.uploadSizes.set(b.index, bytes);
        rebuilt = true;
      }
      this.device.queue.writeBuffer(buf, 0, data as BufferSource);
      unit.argBytes.set(b.index, bytes);
      // arrayLength() sees the bound region size — a smaller array than the
      // (grown) buffer means the bind group must rebind with the right size.
      if (unit.boundSizes.get(b.index) !== bytes) rebuilt = true;
    });
    // scalars
    if (unit.transpiled.scalarsBinding !== null) {
      if (!unit.scalarsBuffer || !unit.scalarsScratch) {
        const n = unit.transpiled.scalarSlots.size;
        const size = Math.max(n * 4, 16);
        this.checkBudget(size);
        unit.scalarsScratch = new Float32Array(Math.max(n, 1));
        unit.scalarsBuffer = this.device.createBuffer({
          label: `${this.label}:scalars`,
          size,
          usage: BU.STORAGE | BU.COPY_DST,
        });
        rebuilt = true;
      }
      unit.scalarInputs.forEach(({ index, slot }) => {
        unit.scalarsScratch![slot] = args[index] as number;
      });
      this.device.queue.writeBuffer(unit.scalarsBuffer, 0, unit.scalarsScratch as BufferSource);
    }
    // directly-bound buffer args: identity change means the bind group is stale
    unit.transpiled.bindings.forEach((b) => {
      if (b.kind === "buffer" && unit.boundBuffers.get(b.index) !== args[b.index]) {
        rebuilt = true;
      }
    });
    return rebuilt;
  }

  private bindGroup(unit: CompiledUnit, args: KernelArg[], out: GPUBuffer, force: boolean): GPUBindGroup {
    if (!force && unit.bindGroup && unit.bindGroupOut === out) return unit.bindGroup;
    // Pre-validate against device limits — Adreno-class GPUs allow as few as
    // 16 storage buffers/stage and 256MB/binding, and wgpu otherwise reports a
    // generic "command buffer failed validation" at submit time.
    const limits = this.device.limits as unknown as Record<string, number | undefined> | undefined;
    const maxStorage = limits?.maxStorageBuffersPerShaderStage ?? Infinity;
    const maxBinding = limits?.maxStorageBufferBindingSize ?? Infinity;
    const storageCount = unit.transpiled.bindings.length
      + (unit.transpiled.scalarsBinding !== null ? 1 : 0) + 1;
    if (storageCount > maxStorage) {
      throw new Error(
        `kernel "${this.label}": needs ${storageCount} storage buffers ` +
        `(args + scalars + output), device limit is ${maxStorage}`);
    }
    const checkBoundSize = (what: string, size: number): void => {
      if (size > maxBinding) {
        throw new Error(
          `kernel "${this.label}": ${what} binds ${size}B, device limit is ${maxBinding}B ` +
          `(maxStorageBufferBindingSize)`);
      }
    };
    const entries: GPUBindGroupEntry[] = [];
    unit.boundBuffers.clear();
    unit.boundSizes.clear();
    unit.transpiled.bindings.forEach((b) => {
      if (b.kind === "buffer") {
        const buf = args[b.index] as GPUBuffer;
        unit.boundBuffers.set(b.index, buf);
        checkBoundSize(`buffer arg "${b.param}"`, buf.size);
        entries.push({ binding: b.binding, resource: { buffer: buf } });
      } else {
        // Bind a window of exactly the arg's length so arrayLength() and the
        // kernel's `arg.length` reflect THIS call's array, not buffer capacity.
        const size = Math.max(unit.argBytes.get(b.index) ?? 0, 16);
        unit.boundSizes.set(b.index, size);
        checkBoundSize(`array arg "${b.param}"`, size);
        entries.push({
          binding: b.binding,
          resource: { buffer: unit.uploadBuffers.get(b.index)!, size },
        });
      }
    });
    if (unit.transpiled.scalarsBinding !== null) {
      checkBoundSize("scalars", unit.scalarsBuffer!.size);
      entries.push({ binding: unit.transpiled.scalarsBinding, resource: { buffer: unit.scalarsBuffer! } });
    }
    checkBoundSize("output", out.size);
    entries.push({ binding: unit.transpiled.resultBinding, resource: { buffer: out } });
    const bg = this.device.createBindGroup({
      label: `${this.label}:bg`,
      layout: unit.bindGroupLayout,
      entries,
    });
    unit.bindGroup = bg;
    unit.bindGroupOut = out;
    return bg;
  }

  private encode(enc: GPUCommandEncoder, args: KernelArg[], out: GPUBuffer, staging: GPUBuffer | null): void {
    if (this.destroyed) throw new Error(`kernel "${this.label}" is destroyed`);
    const bytes = Math.max(this.resultFloats * 4, 16);
    if (out.size < bytes) {
      throw new Error(`kernel "${this.label}": output buffer is ${out.size}B, needs ${bytes}B`);
    }
    const unit = this.unitForArgs(args);
    if (unit.transpiled.bindings.length + unit.transpiled.scalarSlots.size !== args.length) {
      throw new Error(`kernel "${this.label}" expects ${unit.transpiled.bindings.length + unit.transpiled.scalarSlots.size} args, got ${args.length}`);
    }
    // A buffer can't be both an input arg and the output — aliased bindings.
    unit.transpiled.bindings.forEach((b) => {
      if (b.kind === "buffer" && args[b.index] === out) {
        throw new Error(`kernel "${this.label}": can't bind arg "${b.param}" and the output to the same buffer`);
      }
    });
    const rebuilt = this.marshal(unit, args);
    const bg = this.bindGroup(unit, args, out, rebuilt || out !== unit.bindGroupOut);
    const pass = enc.beginComputePass();
    pass.setPipeline(unit.pipeline);
    pass.setBindGroup(0, bg);
    const [wx, wy, wz] = this.workgroupSize;
    const [ox, oy, oz] = this.outputSize;
    const maxWg = (this.device.limits as { maxComputeWorkgroupsPerDimension?: number })
      ?.maxComputeWorkgroupsPerDimension ?? 65535;
    const gx = Math.ceil(ox / wx);
    const gy = Math.ceil(oy / wy);
    const gz = Math.ceil(oz / wz);
    if (gx > maxWg || gy > maxWg || gz > maxWg) {
      throw new Error(
        `kernel "${this.label}": dispatch needs ${gx}×${gy}×${gz} workgroups, limit is ${maxWg} per dimension`);
    }
    pass.dispatchWorkgroups(gx, gy, gz);
    pass.end();
    if (staging) {
      enc.copyBufferToBuffer(out, 0, staging, 0, bytes);
    }
  }
}

/** Extract `fn.toString()`, normalizing method shorthand if needed. */
function fnSource(fn: KernelFn): string {
  const s = Function.prototype.toString.call(fn);
  // Method shorthand `kernel(a) { ... }` isn't a valid expression — wrap it.
  if (!/^\s*(async\s+)?(function|\(|[A-Za-z_$][\w$]*\s*=>)/.test(s) &&
      /^[A-Za-z_$][\w$]*\s*\(/.test(s)) {
    return `function ${s}`;
  }
  return s;
}

export function createKernel(opts: KernelOptions): GpuKernel {
  return new GpuKernel(opts);
}
