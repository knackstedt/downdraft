// ============================================================================
// install.ts — installs the wgpu-native GPU binding as navigator.gpu
//
// Sets globalThis.navigator.gpu to a WgpuGPU instance so the engine's
// GPUDeviceManager (which calls navigator.gpu.requestAdapter()) works
// unchanged under Bun-native.
// ============================================================================

import { createLogger } from "@downdraft/core";
import { WgpuGPU } from "./wgpu-wrapper";

const log = createLogger();

let installed = false;

// ── WebGPU global constants ──
// The engine uses GPUBufferUsage, GPUTextureUsage, etc. as global constants.
// In the browser, these are provided by the WebGPU implementation. In native
// mode, we define them on globalThis.
function installGPUConstants(): void {
  const g = globalThis as any;
  g.GPUBufferUsage = {
    MAP_READ: 0x0001,
    MAP_WRITE: 0x0002,
    COPY_SRC: 0x0004,
    COPY_DST: 0x0008,
    INDEX: 0x0010,
    VERTEX: 0x0020,
    UNIFORM: 0x0040,
    STORAGE: 0x0080,
    INDIRECT: 0x0100,
    QUERY_RESOLVE: 0x0200,
  };
  g.GPUTextureUsage = {
    COPY_SRC: 0x0001,
    COPY_DST: 0x0002,
    TEXTURE_BINDING: 0x0004,
    STORAGE_BINDING: 0x0008,
    RENDER_ATTACHMENT: 0x0010,
  };
  g.GPUShaderStage = {
    VERTEX: 0x0001,
    FRAGMENT: 0x0002,
    COMPUTE: 0x0004,
  };
  g.GPUMapMode = {
    READ: 0x0001,
    WRITE: 0x0002,
  };
  // WGPUColorWriteMask bitflags — matches webgpu.h and the DOM constants.
  g.GPUColorWrite = {
    RED: 0x1,
    GREEN: 0x2,
    BLUE: 0x4,
    ALPHA: 0x8,
    ALL: 0xF,
  };
  g.GPUStoreOp = {
    STORE: "store",
    DISCARD: "discard",
  };
  g.GPULoadOp = {
    LOAD: "load",
    CLEAR: "clear",
  };
  g.GPUAddressMode = {
    CLAMP_TO_EDGE: "clamp-to-edge",
    REPEAT: "repeat",
    MIRROR_REPEAT: "mirror-repeat",
  };
  g.GPUFilterMode = {
    NEAREST: "nearest",
    LINEAR: "linear",
  };
  g.GPUPrimitiveTopology = {
    POINT_LIST: "point-list",
    LINE_LIST: "line-list",
    LINE_STRIP: "line-strip",
    TRIANGLE_LIST: "triangle-list",
    TRIANGLE_STRIP: "triangle-strip",
  };
  g.GPUCompareFunction = {
    UNDEFINED: "undefined",
    NEVER: "never",
    LESS: "less",
    EQUAL: "equal",
    LESS_EQUAL: "less-equal",
    GREATER: "greater",
    NOT_EQUAL: "not-equal",
    GREATER_EQUAL: "greater-equal",
    ALWAYS: "always",
  };
  g.GPUIndexFormat = {
    UNDEFINED: "undefined",
    UINT16: "uint16",
    UINT32: "uint32",
  };
  g.GPUTextureFormat = {
    // Common formats used by the engine
    BGRA8UNORM: "bgra8unorm",
    BGRA8UNORM_SRGB: "bgra8unorm-srgb",
    RGBA8UNORM: "rgba8unorm",
    RGBA8UNORM_SRGB: "rgba8unorm-srgb",
    DEPTH24PLUS: "depth24plus",
    DEPTH24PLUS_STENCIL8: "depth24plus-stencil8",
    DEPTH32FLOAT: "depth32float",
    DEPTH32FLOAT_STENCIL8: "depth32float-stencil8",
    R32FLOAT: "r32float",
    RG32FLOAT: "rg32float",
    RGBA32FLOAT: "rgba32float",
    RGBA16FLOAT: "rgba16float",
  };
  g.GPUCullMode = {
    NONE: "none",
    FRONT: "front",
    BACK: "back",
  };
  g.GPUFrontFace = {
    CCW: "ccw",
    CW: "cw",
  };
  g.GPUBufferBindingType = {
    UNIFORM: "uniform",
    STORAGE: "storage",
    READ_ONLY_STORAGE: "read-only-storage",
  };
  g.GPUSamplerBindingType = {
    FILTERING: "filtering",
    NON_FILTERING: "non-filtering",
    COMPARISON: "comparison",
  };
  g.GPUTextureSampleType = {
    FLOAT: "float",
    UNFILTERABLE_FLOAT: "unfilterable-float",
    DEPTH: "depth",
    SINT: "sint",
    UINT: "uint",
  };
  g.GPUTextureViewDimension = {
    "1D": "1d",
    "2D": "2d",
    "2D_ARRAY": "2d-array",
    CUBE: "cube",
    CUBE_ARRAY: "cube-array",
    "3D": "3d",
  };
  g.GPUTextureDimension = {
    "1D": "1d",
    "2D": "2d",
    "3D": "3d",
  };
  g.GPUBlendFactor = {
    ZERO: "zero",
    ONE: "one",
    SRC: "src",
    ONE_MINUS_SRC: "one-minus-src",
    SRC_ALPHA: "src-alpha",
    ONE_MINUS_SRC_ALPHA: "one-minus-src-alpha",
    DST: "dst",
    ONE_MINUS_DST: "one-minus-dst",
    DST_ALPHA: "dst-alpha",
    ONE_MINUS_DST_ALPHA: "one-minus-dst-alpha",
    SRC_ALPHA_SATURATED: "src-alpha-saturated",
    CONSTANT: "constant",
    ONE_MINUS_CONSTANT: "one-minus-constant",
  };
  g.GPUBlendOperation = {
    ADD: "add",
    SUBTRACT: "subtract",
    REVERSE_SUBTRACT: "reverse-subtract",
    MIN: "min",
    MAX: "max",
  };
  g.GPUStencilOperation = {
    KEEP: "keep",
    ZERO: "zero",
    REPLACE: "replace",
    INVERT: "invert",
    INCREMENT_CLAMP: "increment-clamp",
    DECREMENT_CLAMP: "decrement-clamp",
    INCREMENT_WRAP: "increment-wrap",
    DECREMENT_WRAP: "decrement-wrap",
  };
  g.GPUVertexStepMode = {
    VERTEX: "vertex",
    INSTANCE: "instance",
  };
  g.GPUCanvasAlphaMode = {
    OPAQUE: "opaque",
    PREMULTIPLIED: "premultiplied",
  };
  g.GPUErrorFilter = {
    VALIDATION: "validation",
    OUT_OF_MEMORY: "out-of-memory",
    INTERNAL: "internal",
  };
}

export function installGPU(): WgpuGPU {
  if (installed) return (globalThis as any).navigator.gpu;

  // Install WebGPU global constants first
  installGPUConstants();

  // Ensure navigator exists
  if (typeof (globalThis as any).navigator === "undefined") {
    (globalThis as any).navigator = {};
  }

  // Install gpu on navigator
  const gpu = new WgpuGPU();
  (globalThis as any).navigator.gpu = gpu;

  // Also set globalThis.__nativeGpu as a fallback
  (globalThis as any).__nativeGpu = gpu;

  // Store the instance pointer for SDL surface creation
  (globalThis as any).__wgpuInstancePtr = gpu.getInstancePtr();

  installed = true;
  log.info("platform-native", "GPU binding installed (wgpu-native)");
  return gpu;
}

/**
 * Uninstall the GPU binding — used by tests that need a fresh navigator.gpu
 * and by teardown paths. Does NOT release the native wgpu instance (it may
 * still back live surfaces); callers that own the instance should release it
 * via wgpu_shim_release_instance() first if appropriate.
 */
export function resetGPU(): void {
  const g = globalThis as any;
  if (g.navigator) g.navigator.gpu = undefined;
  g.__nativeGpu = undefined;
  g.__wgpuInstancePtr = 0;
  installed = false;
}
