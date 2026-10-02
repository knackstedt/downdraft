// ============================================================================
// wgpu-ffi.ts — FFI bindings to the wgpu shim surface
//
// Loads libdowndraft_platform (native-rs/src/gpu/ — Rust `wgpu` crate) and
// exposes its functions as typed JS functions. The shim flattens wgpu's
// struct-based API into individual parameters for easy FFI binding.
//
// The shim handles async APIs (requestAdapter, requestDevice, bufferMapAsync)
// synchronously via instance.poll(Wait) until callbacks fire.
//
// Loading is LAZY: importing this module does not call dlopen. The shared
// library is opened on the first symbol access (e.g. installGPU()). This
// keeps `import` side-effect-free for tools, tests, and runtimes that never
// touch the GPU.
// ============================================================================

import { dlopen, type CFunction, type ptr } from "../ffi/ffi-adapter";
import { resolvePlatformLibrary, resolveShimLibrary } from "../ffi/lib-paths";

// ── FFI symbol definitions ──
// Each entry maps a C function to a JS function with typed parameters.
// Canonical type strings (matching bun:ffi): i32, u32, i64, u64, f32, f64,
// ptr, cstring, usize.

const WGPU_SHIM_SPEC: Record<string, CFunction> = {
  // ── Instance / adapter / device ──
  wgpu_shim_create_instance: { args: [], returns: "ptr" },
  wgpu_shim_request_adapter: { args: ["ptr", "i32"], returns: "ptr" },
  // (adapter, limits u32 triples ptr, limit count, features u32 ptr, feature count)
  wgpu_shim_request_device: {
    args: ["ptr", "ptr", "u32", "ptr", "u32"],
    returns: "ptr",
  },
  wgpu_shim_device_get_queue: { args: ["ptr"], returns: "ptr" },
  wgpu_shim_process_events: { args: ["ptr"], returns: "void" },
  // (device, out_msg char*, out_msg_size) → WGPUDeviceLostReason (0 = alive)
  wgpu_shim_device_poll_lost: { args: ["ptr", "ptr", "i32"], returns: "u32" },

  // ── Buffer ──
  wgpu_shim_create_buffer: {
    args: ["ptr", "u64", "u32", "i32"],
    returns: "ptr",
  },
  wgpu_shim_queue_write_buffer: {
    args: ["ptr", "ptr", "u64", "ptr", "usize"],
    returns: "void",
  },
  // Returns WGPUBufferMapState: 3=Mapped on success.
  wgpu_shim_buffer_map_async: {
    args: ["ptr", "u32", "u64", "u64"],
    returns: "u32",
  },
  wgpu_shim_buffer_read_mapped: {
    args: ["ptr", "u64", "u64", "ptr", "i32"],
    returns: "i32",
  },
  wgpu_shim_buffer_write_mapped: {
    args: ["ptr", "u64", "ptr", "u64"],
    returns: "i32",
  },
  wgpu_shim_buffer_unmap: { args: ["ptr"], returns: "void" },

  // ── Shader ──
  wgpu_shim_create_shader_module: {
    args: ["ptr", "cstring"],
    returns: "ptr",
  },
  // Returns a static "[]" (wgpuShaderModuleGetCompilationInfo panics in this
  // wgpu-native build). Do NOT free the returned pointer.
  wgpu_shim_shader_get_compilation_info: {
    args: ["ptr"],
    returns: "cstring",
  },

  // ── Texture ──
  wgpu_shim_create_texture: {
    args: ["ptr", "u32", "u32", "u32", "u32", "u32", "u32", "u32", "u32", "u32", "ptr"],
    returns: "ptr",
  },
  wgpu_shim_texture_create_view: {
    args: ["ptr", "u32", "u32", "u32", "u32", "u32", "u32", "u32"],
    returns: "ptr",
  },
  // (queue, texture, data, dataSize, mip, ox, oy, oz, aspect,
  //  layoutOffset u64, bytesPerRow, rowsPerImage, w, h, d)
  wgpu_shim_queue_write_texture: {
    args: ["ptr", "ptr", "ptr", "usize", "u32", "u32", "u32", "u32", "u32", "u64", "u32", "u32", "u32", "u32", "u32"],
    returns: "void",
  },

  // ── Sampler ──
  wgpu_shim_create_sampler: {
    args: ["ptr", "u32", "u32", "u32", "u32", "u32", "u32", "f32", "f32", "u32", "u32"],
    returns: "ptr",
  },

  // ── Bind group ──
  // entries flat: 11 u32 per entry (incl. hasDynamicOffset + minBindingSize)
  wgpu_shim_create_bind_group_layout: {
    args: ["ptr", "u32", "ptr"],
    returns: "ptr",
  },
  wgpu_shim_create_pipeline_layout: {
    args: ["ptr", "u32", "ptr"],
    returns: "ptr",
  },
  wgpu_shim_create_bind_group: {
    args: ["ptr", "ptr", "u32", "ptr"],
    returns: "ptr",
  },

  // ── Command encoder ──
  wgpu_shim_create_command_encoder: { args: ["ptr"], returns: "ptr" },
  wgpu_shim_command_encoder_finish: { args: ["ptr"], returns: "ptr" },
  wgpu_shim_queue_submit: {
    args: ["ptr", "ptr", "u32"],
    returns: "void",
  },

  // ── Render pass ──
  wgpu_shim_begin_render_pass: {
    args: ["ptr", "u32", "ptr", "ptr", "ptr", "ptr"],
    returns: "ptr",
  },
  wgpu_shim_render_pass_set_pipeline: {
    args: ["ptr", "ptr"],
    returns: "void",
  },
  // (pass, groupIndex, bindGroup, dynamicOffsets u32* | NULL, count)
  wgpu_shim_render_pass_set_bind_group: {
    args: ["ptr", "u32", "ptr", "ptr", "u32"],
    returns: "void",
  },
  wgpu_shim_render_pass_set_vertex_buffer: {
    args: ["ptr", "u32", "ptr", "u64", "u64"],
    returns: "void",
  },
  wgpu_shim_render_pass_set_index_buffer: {
    args: ["ptr", "ptr", "u32", "u64", "u64"],
    returns: "void",
  },
  wgpu_shim_render_pass_draw: {
    args: ["ptr", "u32", "u32", "u32", "u32"],
    returns: "void",
  },
  wgpu_shim_render_pass_draw_indexed: {
    args: ["ptr", "u32", "u32", "u32", "i32", "u32"],
    returns: "void",
  },
  wgpu_shim_render_pass_end: { args: ["ptr"], returns: "void" },
  wgpu_shim_render_pass_write_timestamp: { args: ["ptr", "ptr", "u32"], returns: "void" },
  wgpu_shim_compute_pass_write_timestamp: { args: ["ptr", "ptr", "u32"], returns: "void" },
  wgpu_shim_render_pass_set_scissor_rect: {
    args: ["ptr", "u32", "u32", "u32", "u32"],
    returns: "void",
  },
  wgpu_shim_render_pass_set_viewport: {
    args: ["ptr", "f32", "f32", "f32", "f32", "f32", "f32"],
    returns: "void",
  },

  // ── Render pipeline ──
  wgpu_shim_create_render_pipeline: {
    args: [
      "ptr",           // device
      "ptr",           // vertex shader
      "cstring",       // vertex entry
      "ptr",           // fragment shader
      "cstring",       // fragment entry
      "u32",           // color target count
      "ptr",           // color target data (flat array, 9 u32 per target)
      "ptr",           // depth-stencil data (flat array, 16 u32, or NULL)
      "u32",           // topology
      "u32",           // strip index format
      "u32",           // sample count
      "ptr",           // layout
      "u32",           // cull mode
      "u32",           // front face
      "u32",           // vertex buffer count
      "ptr",           // vertex buffer data (flat array)
    ],
    returns: "ptr",
  },

  // ── Compute pipeline ──
  wgpu_shim_create_compute_pipeline: {
    args: ["ptr", "ptr", "cstring", "ptr"],
    returns: "ptr",
  },

  // ── Compute pass ──
  wgpu_shim_begin_compute_pass: { args: ["ptr", "ptr"], returns: "ptr" },
  wgpu_shim_compute_pass_set_pipeline: {
    args: ["ptr", "ptr"],
    returns: "void",
  },
  wgpu_shim_compute_pass_set_bind_group: {
    args: ["ptr", "u32", "ptr", "ptr", "u32"],
    returns: "void",
  },
  wgpu_shim_compute_pass_dispatch: {
    args: ["ptr", "u32", "u32", "u32"],
    returns: "void",
  },
  wgpu_shim_compute_pass_end: { args: ["ptr"], returns: "void" },

  // ── Copy ──
  wgpu_shim_copy_buffer_to_buffer: {
    args: ["ptr", "ptr", "u64", "ptr", "u64", "u64"],
    returns: "void",
  },
  // (encoder, srcTex, srcMip, sox, soy, soz, sAspect,
  //  dstBuf, dstOffset u64, dstBpr, dstRpi, w, h, d)
  wgpu_shim_copy_texture_to_buffer: {
    args: ["ptr", "ptr", "u32", "u32", "u32", "u32", "u32", "ptr", "u64", "u32", "u32", "u32", "u32", "u32"],
    returns: "void",
  },

  // ── Query sets ──
  wgpu_shim_create_query_set: { args: ["ptr", "u32", "u32"], returns: "ptr" },
  wgpu_shim_destroy_query_set: { args: ["ptr"], returns: "void" },

  // Timestamp + query resolve (command encoder level)
  wgpu_shim_command_encoder_write_timestamp: { args: ["ptr", "ptr", "u32"], returns: "void" },
  wgpu_shim_resolve_query_set: { args: ["ptr", "ptr", "u32", "u32", "ptr", "u64"], returns: "void" },

  // Indirect draws
  wgpu_shim_render_pass_draw_indirect: { args: ["ptr", "ptr", "u64"], returns: "void" },
  wgpu_shim_render_pass_draw_indexed_indirect: { args: ["ptr", "ptr", "u64"], returns: "void" },
  wgpu_shim_compute_pass_dispatch_indirect: { args: ["ptr", "ptr", "u64"], returns: "void" },

  // Clear buffer
  wgpu_shim_command_encoder_clear_buffer: { args: ["ptr", "ptr", "u64", "u64"], returns: "void" },

  // Blend constant + stencil reference
  wgpu_shim_render_pass_set_blend_constant: { args: ["ptr", "f32", "f32", "f32", "f32"], returns: "void" },
  wgpu_shim_render_pass_set_stencil_reference: { args: ["ptr", "u32"], returns: "void" },

  // Occlusion queries
  wgpu_shim_render_pass_begin_occlusion_query: { args: ["ptr", "u32"], returns: "void" },
  wgpu_shim_render_pass_end_occlusion_query: { args: ["ptr"], returns: "void" },

  // Copy buffer-to-texture and texture-to-texture
  wgpu_shim_copy_buffer_to_texture: {
    args: ["ptr", "ptr", "u64", "u32", "u32", "ptr", "u32", "u32", "u32", "u32", "u32", "u32", "u32", "u32"],
    returns: "void",
  },
  wgpu_shim_copy_texture_to_texture: {
    args: ["ptr", "ptr", "u32", "u32", "u32", "u32", "u32", "ptr", "u32", "u32", "u32", "u32", "u32", "u32", "u32", "u32"],
    returns: "void",
  },

  // Debug groups and markers
  wgpu_shim_render_pass_push_debug_group: { args: ["ptr", "cstring"], returns: "void" },
  wgpu_shim_render_pass_pop_debug_group: { args: ["ptr"], returns: "void" },
  wgpu_shim_render_pass_insert_debug_marker: { args: ["ptr", "cstring"], returns: "void" },
  wgpu_shim_compute_pass_push_debug_group: { args: ["ptr", "cstring"], returns: "void" },
  wgpu_shim_compute_pass_pop_debug_group: { args: ["ptr"], returns: "void" },
  wgpu_shim_compute_pass_insert_debug_marker: { args: ["ptr", "cstring"], returns: "void" },
  wgpu_shim_command_encoder_push_debug_group: { args: ["ptr", "cstring"], returns: "void" },
  wgpu_shim_command_encoder_pop_debug_group: { args: ["ptr"], returns: "void" },
  wgpu_shim_command_encoder_insert_debug_marker: { args: ["ptr", "cstring"], returns: "void" },

  // Error scopes
  wgpu_shim_device_push_error_scope: { args: ["ptr", "u32"], returns: "void" },
  wgpu_shim_device_pop_error_scope: { args: ["ptr", "ptr", "i32"], returns: "u32" },

  // Adapter/device limits and features
  wgpu_shim_adapter_get_limits: { args: ["ptr", "ptr"], returns: "i32" },
  wgpu_shim_device_get_limits: { args: ["ptr", "ptr"], returns: "i32" },
  wgpu_shim_adapter_get_features: { args: ["ptr", "ptr", "u32"], returns: "u32" },
  wgpu_shim_adapter_get_info: { args: ["ptr", "ptr", "i32"], returns: "i32" },
  wgpu_shim_device_get_features: { args: ["ptr", "ptr", "u32"], returns: "u32" },

  // Queue onSubmittedWorkDone
  wgpu_shim_queue_on_submitted_work_done: { args: ["ptr"], returns: "void" },

  // ── Surface ──
  wgpu_shim_surface_configure: {
    args: ["ptr", "ptr", "u32", "u32", "u32", "u32", "u32"],
    returns: "void",
  },
  wgpu_shim_surface_get_current_texture: {
    args: ["ptr", "ptr"],
    returns: "i32",
  },
  wgpu_shim_surface_present: { args: ["ptr"], returns: "void" },
  wgpu_shim_surface_unconfigure: { args: ["ptr"], returns: "void" },
  wgpu_shim_get_preferred_format: { args: [], returns: "u32" },
  wgpu_shim_surface_pick_format: {
    args: ["ptr", "ptr", "ptr", "usize"],
    returns: "u32",
  },

  // ── Release ──
  wgpu_shim_release_buffer: { args: ["ptr"], returns: "void" },
  wgpu_shim_release_texture: { args: ["ptr"], returns: "void" },
  wgpu_shim_release_texture_view: { args: ["ptr"], returns: "void" },
  wgpu_shim_release_sampler: { args: ["ptr"], returns: "void" },
  wgpu_shim_release_bind_group: { args: ["ptr"], returns: "void" },
  wgpu_shim_release_bind_group_layout: { args: ["ptr"], returns: "void" },
  wgpu_shim_release_pipeline_layout: { args: ["ptr"], returns: "void" },
  wgpu_shim_release_render_pipeline: { args: ["ptr"], returns: "void" },
  wgpu_shim_release_compute_pipeline: { args: ["ptr"], returns: "void" },
  wgpu_shim_release_shader_module: { args: ["ptr"], returns: "void" },
  wgpu_shim_release_command_buffer: { args: ["ptr"], returns: "void" },
  wgpu_shim_release_command_encoder: { args: ["ptr"], returns: "void" },
  wgpu_shim_release_device: { args: ["ptr"], returns: "void" },
  wgpu_shim_release_adapter: { args: ["ptr"], returns: "void" },
  wgpu_shim_release_instance: { args: ["ptr"], returns: "void" },
  wgpu_shim_release_surface: { args: ["ptr"], returns: "void" },
  wgpu_shim_release_query_set: { args: ["ptr"], returns: "void" },
  wgpu_shim_release_render_pass: { args: ["ptr"], returns: "void" },
  wgpu_shim_release_compute_pass: { args: ["ptr"], returns: "void" },
  wgpu_shim_release_queue: { args: ["ptr"], returns: "void" },
};

// ── Lazy library handle ──

let _wgpu: WgpuShimSymbols | null = null;

function loadWgpu(): WgpuShimSymbols {
  if (_wgpu) return _wgpu;
  // Resolution order: explicit WGPU_SHIM_PATH override → unified Rust
  // platform lib (downdraft_platform, wgpu crate).
  const shimPath = process.env.WGPU_SHIM_PATH
    ? resolveShimLibrary("wgpu_shim", "WGPU_SHIM_PATH")
    : resolvePlatformLibrary();
  const { symbols } = dlopen(shimPath, WGPU_SHIM_SPEC);
  _wgpu = symbols as unknown as WgpuShimSymbols;
  return _wgpu;
}

/**
 * The wgpu shim symbols. Accessing any property lazily dlopen()s the shared
 * library on first use. This module is safe to import in environments where
 * the library is absent — the error surfaces only when a symbol is called.
 */
export const wgpu: WgpuShimSymbols = new Proxy({} as WgpuShimSymbols, {
  get(_target, prop: string) {
    const lib = loadWgpu();
    const fn = (lib as any)[prop];
    if (fn === undefined) {
      throw new Error(`wgpu shim has no symbol "${prop}"`);
    }
    return fn;
  },
});

// ── Typed interface for the FFI symbols ──

export interface WgpuShimSymbols {
  wgpu_shim_create_instance: () => ptr;
  wgpu_shim_request_adapter: (instance: ptr, powerPreference: number) => ptr;
  wgpu_shim_request_device: (
    adapter: ptr,
    limits: ptr,
    limitCount: number,
    features: ptr,
    featureCount: number,
  ) => ptr;
  wgpu_shim_device_get_queue: (device: ptr) => ptr;
  wgpu_shim_process_events: (instance: ptr) => void;
  wgpu_shim_device_poll_lost: (device: ptr, outMsg: ptr, outMsgSize: number) => number;

  wgpu_shim_create_buffer: (
    device: ptr,
    size: bigint,
    usage: number,
    mappedAtCreation: number,
  ) => ptr;
  wgpu_shim_queue_write_buffer: (
    queue: ptr,
    buffer: ptr,
    offset: bigint,
    data: ptr,
    size: bigint,
  ) => void;
  wgpu_shim_buffer_map_async: (
    buffer: ptr,
    mode: number,
    offset: bigint,
    size: bigint,
  ) => number;
  wgpu_shim_buffer_read_mapped: (
    buffer: ptr,
    offset: bigint,
    size: bigint,
    outData: ptr,
    outSize: number,
  ) => number;
  wgpu_shim_buffer_write_mapped: (
    buffer: ptr,
    offset: bigint,
    data: ptr,
    size: bigint,
  ) => number;
  wgpu_shim_buffer_unmap: (buffer: ptr) => void;

  wgpu_shim_create_shader_module: (device: ptr, wgslCode: string) => ptr;
  wgpu_shim_shader_get_compilation_info: (shader: ptr) => string;

  wgpu_shim_create_texture: (
    device: ptr,
    width: number,
    height: number,
    depthOrArrayLayers: number,
    mipLevelCount: number,
    sampleCount: number,
    dimension: number,
    format: number,
    usage: number,
    viewFormatCount: number,
    viewFormats: ptr,
  ) => ptr;
  wgpu_shim_texture_create_view: (
    texture: ptr,
    format: number,
    dimension: number,
    aspect: number,
    baseMipLevel: number,
    mipLevelCount: number,
    baseArrayLayer: number,
    arrayLayerCount: number,
  ) => ptr;
  wgpu_shim_queue_write_texture: (
    queue: ptr,
    texture: ptr,
    data: ptr,
    dataSize: bigint,
    mipLevel: number,
    originX: number,
    originY: number,
    originZ: number,
    aspect: number,
    layoutOffset: bigint,
    bytesPerRow: number,
    rowsPerImage: number,
    width: number,
    height: number,
    depth: number,
  ) => void;

  wgpu_shim_create_sampler: (
    device: ptr,
    magFilter: number,
    minFilter: number,
    mipmapFilter: number,
    addressModeU: number,
    addressModeV: number,
    addressModeW: number,
    lodMinClamp: number,
    lodMaxClamp: number,
    compare: number,
    maxAnisotropy: number,
  ) => ptr;

  wgpu_shim_create_bind_group_layout: (
    device: ptr,
    entryCount: number,
    entriesFlat: ptr,
  ) => ptr;
  wgpu_shim_create_pipeline_layout: (
    device: ptr,
    layoutCount: number,
    layouts: ptr,
  ) => ptr;
  wgpu_shim_create_bind_group: (
    device: ptr,
    layout: ptr,
    entryCount: number,
    entriesFlat: ptr,
  ) => ptr;

  wgpu_shim_create_command_encoder: (device: ptr) => ptr;
  wgpu_shim_command_encoder_finish: (encoder: ptr) => ptr;
  wgpu_shim_queue_submit: (queue: ptr, commandBuffers: ptr, count: number) => void;

  wgpu_shim_begin_render_pass: (
    encoder: ptr,
    colorCount: number,
    colorAttachments: ptr,
    depthAttachment: ptr,
    occlusionQuerySet: ptr,
    timestampWrites: ptr,
  ) => ptr;
  wgpu_shim_render_pass_set_pipeline: (pass: ptr, pipeline: ptr) => void;
  wgpu_shim_render_pass_set_bind_group: (
    pass: ptr,
    groupIndex: number,
    bindGroup: ptr,
    dynamicOffsets: ptr,
    dynamicOffsetCount: number,
  ) => void;
  wgpu_shim_render_pass_set_vertex_buffer: (
    pass: ptr,
    slot: number,
    buffer: ptr,
    offset: bigint,
    size: bigint,
  ) => void;
  wgpu_shim_render_pass_set_index_buffer: (
    pass: ptr,
    buffer: ptr,
    format: number,
    offset: bigint,
    size: bigint,
  ) => void;
  wgpu_shim_render_pass_draw: (
    pass: ptr,
    vertexCount: number,
    instanceCount: number,
    firstVertex: number,
    firstInstance: number,
  ) => void;
  wgpu_shim_render_pass_draw_indexed: (
    pass: ptr,
    indexCount: number,
    instanceCount: number,
    firstIndex: number,
    baseVertex: number,
    firstInstance: number,
  ) => void;
  wgpu_shim_render_pass_end: (pass: ptr) => void;
  wgpu_shim_render_pass_write_timestamp: (pass: ptr, querySet: ptr, queryIndex: number) => void;
  wgpu_shim_compute_pass_write_timestamp: (pass: ptr, querySet: ptr, queryIndex: number) => void;
  wgpu_shim_render_pass_set_scissor_rect: (
    pass: ptr,
    x: number,
    y: number,
    width: number,
    height: number,
  ) => void;
  wgpu_shim_render_pass_set_viewport: (
    pass: ptr,
    x: number,
    y: number,
    width: number,
    height: number,
    minDepth: number,
    maxDepth: number,
  ) => void;

  wgpu_shim_create_render_pipeline: (
    device: ptr,
    vertexShader: ptr,
    vertexEntry: string,
    fragmentShader: ptr,
    fragmentEntry: string,
    colorTargetCount: number,
    colorTargets: ptr,
    depthStencil: ptr,
    topology: number,
    stripIndexFormat: number,
    sampleCount: number,
    layout: ptr,
    cullMode: number,
    frontFace: number,
    vertexBufferCount: number,
    vertexBufferData: ptr,
  ) => ptr;

  wgpu_shim_create_compute_pipeline: (
    device: ptr,
    shader: ptr,
    entryPoint: string,
    layout: ptr,
  ) => ptr;

  wgpu_shim_begin_compute_pass: (encoder: ptr, timestampWrites: ptr) => ptr;
  wgpu_shim_compute_pass_set_pipeline: (pass: ptr, pipeline: ptr) => void;
  wgpu_shim_compute_pass_set_bind_group: (
    pass: ptr,
    groupIndex: number,
    bindGroup: ptr,
    dynamicOffsets: ptr,
    dynamicOffsetCount: number,
  ) => void;
  wgpu_shim_compute_pass_dispatch: (
    pass: ptr,
    x: number,
    y: number,
    z: number,
  ) => void;
  wgpu_shim_compute_pass_end: (pass: ptr) => void;

  wgpu_shim_copy_buffer_to_buffer: (
    encoder: ptr,
    src: ptr,
    srcOffset: bigint,
    dst: ptr,
    dstOffset: bigint,
    size: bigint,
  ) => void;
  wgpu_shim_copy_texture_to_buffer: (
    encoder: ptr,
    srcTexture: ptr,
    srcMipLevel: number,
    srcOriginX: number,
    srcOriginY: number,
    srcOriginZ: number,
    srcAspect: number,
    dstBuffer: ptr,
    dstOffset: bigint,
    dstBytesPerRow: number,
    dstRowsPerImage: number,
    copyW: number,
    copyH: number,
    copyD: number,
  ) => void;

  wgpu_shim_create_query_set: (device: ptr, type: number, count: number) => ptr;
  wgpu_shim_destroy_query_set: (querySet: ptr) => void;
  wgpu_shim_command_encoder_write_timestamp: (encoder: ptr, querySet: ptr, queryIndex: number) => void;
  wgpu_shim_resolve_query_set: (encoder: ptr, querySet: ptr, firstQuery: number, queryCount: number, destBuffer: ptr, destOffset: bigint) => void;
  wgpu_shim_render_pass_draw_indirect: (pass: ptr, buffer: ptr, offset: bigint) => void;
  wgpu_shim_render_pass_draw_indexed_indirect: (pass: ptr, buffer: ptr, offset: bigint) => void;
  wgpu_shim_compute_pass_dispatch_indirect: (pass: ptr, buffer: ptr, offset: bigint) => void;
  wgpu_shim_command_encoder_clear_buffer: (encoder: ptr, buffer: ptr, offset: bigint, size: bigint) => void;
  wgpu_shim_render_pass_set_blend_constant: (pass: ptr, r: number, g: number, b: number, a: number) => void;
  wgpu_shim_render_pass_set_stencil_reference: (pass: ptr, reference: number) => void;
  wgpu_shim_render_pass_begin_occlusion_query: (pass: ptr, queryIndex: number) => void;
  wgpu_shim_render_pass_end_occlusion_query: (pass: ptr) => void;
  wgpu_shim_copy_buffer_to_texture: (
    encoder: ptr, srcBuffer: ptr, srcOffset: bigint, srcBytesPerRow: number, srcRowsPerImage: number,
    dstTexture: ptr, dstMipLevel: number, dstOriginX: number, dstOriginY: number, dstOriginZ: number,
    dstAspect: number, copyW: number, copyH: number, copyD: number,
  ) => void;
  wgpu_shim_copy_texture_to_texture: (
    encoder: ptr,
    srcTexture: ptr, srcMipLevel: number, srcOriginX: number, srcOriginY: number, srcOriginZ: number, srcAspect: number,
    dstTexture: ptr, dstMipLevel: number, dstOriginX: number, dstOriginY: number, dstOriginZ: number, dstAspect: number,
    copyW: number, copyH: number, copyD: number,
  ) => void;
  wgpu_shim_render_pass_push_debug_group: (pass: ptr, label: string) => void;
  wgpu_shim_render_pass_pop_debug_group: (pass: ptr) => void;
  wgpu_shim_render_pass_insert_debug_marker: (pass: ptr, label: string) => void;
  wgpu_shim_compute_pass_push_debug_group: (pass: ptr, label: string) => void;
  wgpu_shim_compute_pass_pop_debug_group: (pass: ptr) => void;
  wgpu_shim_compute_pass_insert_debug_marker: (pass: ptr, label: string) => void;
  wgpu_shim_command_encoder_push_debug_group: (encoder: ptr, label: string) => void;
  wgpu_shim_command_encoder_pop_debug_group: (encoder: ptr) => void;
  wgpu_shim_command_encoder_insert_debug_marker: (encoder: ptr, label: string) => void;
  wgpu_shim_device_push_error_scope: (device: ptr, filter: number) => void;
  wgpu_shim_device_pop_error_scope: (device: ptr, outMsg: ptr, outMsgSize: number) => number;
  wgpu_shim_adapter_get_limits: (adapter: ptr, outBuffer: ptr) => number;
  wgpu_shim_device_get_limits: (device: ptr, outBuffer: ptr) => number;
  wgpu_shim_adapter_get_features: (adapter: ptr, outFeatures: ptr, maxCount: number) => number;
  wgpu_shim_adapter_get_info: (adapter: ptr, outBuf: ptr, outSize: number) => number;
  wgpu_shim_device_get_features: (device: ptr, outFeatures: ptr, maxCount: number) => number;
  wgpu_shim_queue_on_submitted_work_done: (queue: ptr) => void;

  wgpu_shim_surface_configure: (
    surface: ptr,
    device: ptr,
    format: number,
    usage: number,
    width: number,
    height: number,
    presentMode: number,
  ) => void;
  wgpu_shim_surface_get_current_texture: (surface: ptr, textureOut: ptr) => number;
  wgpu_shim_surface_present: (surface: ptr) => void;
  wgpu_shim_surface_unconfigure: (surface: ptr) => void;
  wgpu_shim_get_preferred_format: () => number;
  wgpu_shim_surface_pick_format: (
    surface: ptr,
    adapter: ptr,
    candidates: ptr,
    count: number,
  ) => number;

  // Release functions
  wgpu_shim_release_buffer: (p: ptr) => void;
  wgpu_shim_release_texture: (p: ptr) => void;
  wgpu_shim_release_texture_view: (p: ptr) => void;
  wgpu_shim_release_sampler: (p: ptr) => void;
  wgpu_shim_release_bind_group: (p: ptr) => void;
  wgpu_shim_release_bind_group_layout: (p: ptr) => void;
  wgpu_shim_release_pipeline_layout: (p: ptr) => void;
  wgpu_shim_release_render_pipeline: (p: ptr) => void;
  wgpu_shim_release_compute_pipeline: (p: ptr) => void;
  wgpu_shim_release_shader_module: (p: ptr) => void;
  wgpu_shim_release_command_buffer: (p: ptr) => void;
  wgpu_shim_release_command_encoder: (p: ptr) => void;
  wgpu_shim_release_device: (p: ptr) => void;
  wgpu_shim_release_adapter: (p: ptr) => void;
  wgpu_shim_release_instance: (p: ptr) => void;
  wgpu_shim_release_surface: (p: ptr) => void;
  wgpu_shim_release_query_set: (p: ptr) => void;
  wgpu_shim_release_render_pass: (p: ptr) => void;
  wgpu_shim_release_compute_pass: (p: ptr) => void;
  wgpu_shim_release_queue: (p: ptr) => void;
}
