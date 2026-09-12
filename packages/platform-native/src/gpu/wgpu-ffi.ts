// ============================================================================
// wgpu-ffi.ts — bun:ffi bindings to the wgpu_shim C library
//
// This file loads libwgpu_shim.so (compiled from wgpu_shim.c) and exposes
// its functions as typed JS functions. The C shim flattens the wgpu-native
// struct-based API into individual parameters for easy FFI binding.
//
// The shim handles async APIs (requestAdapter, requestDevice, bufferMapAsync)
// synchronously by polling wgpuInstanceProcessEvents() until callbacks fire.
// ============================================================================

import { dlopen, ptr, type CFunction } from "bun:ffi";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const _dirname = typeof (globalThis as any).__dirname !== "undefined"
  ? (globalThis as any).__dirname
  : dirname(fileURLToPath(import.meta.url));

// ── Locate the shim library ──

function findShimLibrary(): string {
  // 1. Explicit env var
  const envPath = process.env.WGPU_SHIM_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  // 2. native/libwgpu_shim.so (has correct rpath $ORIGIN/lib → native/lib/)
  const legacyPath = join(_dirname, "..", "..", "native", "libwgpu_shim.so");
  if (existsSync(legacyPath)) return legacyPath;

  // 2b. native/lib/libwgpu_shim.so (rpath $ORIGIN/lib is broken here — only
  // works if libwgpu_native.so is on the loader path)
  const relativePath = join(_dirname, "..", "..", "native", "lib", "libwgpu_shim.so");
  if (existsSync(relativePath)) return relativePath;

  // 3. System-installed
  const systemPath = "/usr/local/lib/libwgpu_shim.so";
  if (existsSync(systemPath)) return systemPath;

  throw new Error(
    `wgpu_shim library not found. Set WGPU_SHIM_PATH or build with ` +
    `"cd packages/platform-native/native && gcc -shared -fPIC -o ` +
    `libwgpu_shim.so wgpu_shim.c -I./include -L./lib -lwgpu_native -lSDL2 ` +
    `-Wl,-rpath,'$ORIGIN/lib'"`
  );
}

// ── FFI symbol definitions ──
// Each entry maps a C function to a JS function with typed parameters.
// bun:ffi uses C type abbreviations: i32, u32, i64, u64, f32, f64, ptr, bool, char *

const shimPath = findShimLibrary();

const { symbols } = dlopen(shimPath, {
  // ── Instance / adapter / device ──
  wgpu_shim_create_instance: { args: [], returns: "ptr" } as CFunction,
  wgpu_shim_request_adapter: { args: ["ptr", "i32"], returns: "ptr" } as CFunction,
  wgpu_shim_request_device: {
    args: ["ptr", "u64", "u32", "u32", "u32"],
    returns: "ptr",
  } as CFunction,
  wgpu_shim_device_get_queue: { args: ["ptr"], returns: "ptr" } as CFunction,
  wgpu_shim_process_events: { args: ["ptr"], returns: "void" } as CFunction,

  // ── Buffer ──
  wgpu_shim_create_buffer: {
    args: ["ptr", "u64", "u32", "i32"],
    returns: "ptr",
  } as CFunction,
  wgpu_shim_queue_write_buffer: {
    args: ["ptr", "ptr", "u64", "ptr", "usize"],
    returns: "void",
  } as CFunction,
  wgpu_shim_buffer_map_async: {
    args: ["ptr", "u32", "u64", "u64"],
    returns: "void",
  } as CFunction,
  wgpu_shim_buffer_get_mapped_range: {
    args: ["ptr", "u64", "u64"],
    returns: "ptr",
  } as CFunction,
  wgpu_shim_buffer_read_mapped: {
    args: ["ptr", "u64", "u64", "ptr", "i32"],
    returns: "i32",
  } as CFunction,
  wgpu_shim_buffer_unmap: { args: ["ptr"], returns: "void" } as CFunction,

  // ── Shader ──
  wgpu_shim_create_shader_module: {
    args: ["ptr", "cstring"],
    returns: "ptr",
  } as CFunction,

  // ── Texture ──
  wgpu_shim_create_texture: {
    args: ["ptr", "u32", "u32", "u32", "u32", "u32", "u32", "u32", "u32", "u32", "ptr"],
    returns: "ptr",
  } as CFunction,
  wgpu_shim_texture_create_view: {
    args: ["ptr", "u32", "u32", "u32", "u32", "u32", "u32", "u32"],
    returns: "ptr",
  } as CFunction,
  wgpu_shim_queue_write_texture: {
    args: ["ptr", "ptr", "ptr", "usize", "u32", "u32", "u32"],
    returns: "void",
  } as CFunction,

  // ── Sampler ──
  // AUDIT FIX: extended to pass all sampler fields (compare, anisotropy, addressModeW, mipmap, lod).
  wgpu_shim_create_sampler: {
    args: ["ptr", "u32", "u32", "u32", "u32", "u32", "u32", "f32", "f32", "u32", "u32"],
    returns: "ptr",
  } as CFunction,

  // ── Bind group ──
  wgpu_shim_create_bind_group_layout: {
    args: ["ptr", "u32", "ptr"],
    returns: "ptr",
  } as CFunction,
  wgpu_shim_create_pipeline_layout: {
    args: ["ptr", "u32", "ptr"],
    returns: "ptr",
  } as CFunction,
  wgpu_shim_create_bind_group: {
    args: ["ptr", "ptr", "u32", "ptr"],
    returns: "ptr",
  } as CFunction,

  // ── Command encoder ──
  wgpu_shim_create_command_encoder: { args: ["ptr"], returns: "ptr" } as CFunction,
  wgpu_shim_command_encoder_finish: { args: ["ptr"], returns: "ptr" } as CFunction,
  wgpu_shim_queue_submit: {
    args: ["ptr", "ptr", "u32"],
    returns: "void",
  } as CFunction,

  // ── Render pass ──
  // AUDIT FIX: extended to support multiple color attachments, full depth-stencil,
  // occlusion query set, and timestamp writes.
  wgpu_shim_begin_render_pass: {
    args: ["ptr", "u32", "ptr", "ptr", "ptr", "ptr"],
    returns: "ptr",
  } as CFunction,
  wgpu_shim_render_pass_set_pipeline: {
    args: ["ptr", "ptr"],
    returns: "void",
  } as CFunction,
  wgpu_shim_render_pass_set_bind_group: {
    args: ["ptr", "u32", "ptr"],
    returns: "void",
  } as CFunction,
  wgpu_shim_render_pass_set_vertex_buffer: {
    args: ["ptr", "u32", "ptr", "u64", "u64"],
    returns: "void",
  } as CFunction,
  wgpu_shim_render_pass_set_index_buffer: {
    args: ["ptr", "ptr", "u32", "u64", "u64"],
    returns: "void",
  } as CFunction,
  wgpu_shim_render_pass_draw: {
    args: ["ptr", "u32", "u32", "u32", "u32"],
    returns: "void",
  } as CFunction,
  wgpu_shim_render_pass_draw_indexed: {
    args: ["ptr", "u32", "u32", "u32", "i32", "u32"],
    returns: "void",
  } as CFunction,
  wgpu_shim_render_pass_end: { args: ["ptr"], returns: "void" } as CFunction,
  wgpu_shim_render_pass_set_scissor_rect: {
    args: ["ptr", "u32", "u32", "u32", "u32"],
    returns: "void",
  } as CFunction,
  wgpu_shim_render_pass_set_viewport: {
    args: ["ptr", "f32", "f32", "f32", "f32", "f32", "f32"],
    returns: "void",
  } as CFunction,

  // ── Render pipeline ──
  // AUDIT FIX: extended to support multiple color targets, full depth-stencil state,
  // and stripIndexFormat. Uses flat arrays for color targets and depth-stencil.
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
  } as CFunction,

  // ── Compute pipeline ──
  wgpu_shim_create_compute_pipeline: {
    args: ["ptr", "ptr", "cstring", "ptr"],
    returns: "ptr",
  } as CFunction,

  // ── Compute pass ──
  // AUDIT FIX: now accepts optional timestamp writes (ptr to flat 4 u32 array, or NULL).
  wgpu_shim_begin_compute_pass: { args: ["ptr", "ptr"], returns: "ptr" } as CFunction,
  wgpu_shim_compute_pass_set_pipeline: {
    args: ["ptr", "ptr"],
    returns: "void",
  } as CFunction,
  wgpu_shim_compute_pass_set_bind_group: {
    args: ["ptr", "u32", "ptr"],
    returns: "void",
  } as CFunction,
  wgpu_shim_compute_pass_dispatch: {
    args: ["ptr", "u32", "u32", "u32"],
    returns: "void",
  } as CFunction,
  wgpu_shim_compute_pass_end: { args: ["ptr"], returns: "void" } as CFunction,

  // ── Copy ──
  wgpu_shim_copy_buffer_to_buffer: {
    args: ["ptr", "ptr", "u64", "ptr", "u64", "u64"],
    returns: "void",
  } as CFunction,
  wgpu_shim_copy_texture_to_buffer: {
    args: ["ptr", "ptr", "ptr", "u32", "u32", "u32"],
    returns: "void",
  } as CFunction,

  // ── AUDIT FIX: New functions implementing previously-silent no-op stubs ──

  // Query sets
  wgpu_shim_create_query_set: { args: ["ptr", "u32", "u32"], returns: "ptr" } as CFunction,
  wgpu_shim_destroy_query_set: { args: ["ptr"], returns: "void" } as CFunction,

  // Timestamp + query resolve (command encoder level)
  wgpu_shim_command_encoder_write_timestamp: { args: ["ptr", "ptr", "u32"], returns: "void" } as CFunction,
  wgpu_shim_resolve_query_set: { args: ["ptr", "ptr", "u32", "u32", "ptr", "u64"], returns: "void" } as CFunction,

  // Indirect draws
  wgpu_shim_render_pass_draw_indirect: { args: ["ptr", "ptr", "u64"], returns: "void" } as CFunction,
  wgpu_shim_render_pass_draw_indexed_indirect: { args: ["ptr", "ptr", "u64"], returns: "void" } as CFunction,
  wgpu_shim_compute_pass_dispatch_indirect: { args: ["ptr", "ptr", "u64"], returns: "void" } as CFunction,

  // Clear buffer
  wgpu_shim_command_encoder_clear_buffer: { args: ["ptr", "ptr", "u64", "u64"], returns: "void" } as CFunction,

  // Blend constant + stencil reference
  wgpu_shim_render_pass_set_blend_constant: { args: ["ptr", "f32", "f32", "f32", "f32"], returns: "void" } as CFunction,
  wgpu_shim_render_pass_set_stencil_reference: { args: ["ptr", "u32"], returns: "void" } as CFunction,

  // Occlusion queries
  wgpu_shim_render_pass_begin_occlusion_query: { args: ["ptr", "u32"], returns: "void" } as CFunction,
  wgpu_shim_render_pass_end_occlusion_query: { args: ["ptr"], returns: "void" } as CFunction,

  // Copy buffer-to-texture and texture-to-texture
  wgpu_shim_copy_buffer_to_texture: {
    args: ["ptr", "ptr", "u64", "u32", "u32", "ptr", "u32", "u32", "u32", "u32", "u32", "u32", "u32", "u32"],
    returns: "void",
  } as CFunction,
  wgpu_shim_copy_texture_to_texture: {
    args: ["ptr", "ptr", "u32", "u32", "u32", "u32", "u32", "ptr", "u32", "u32", "u32", "u32", "u32", "u32", "u32", "u32"],
    returns: "void",
  } as CFunction,

  // Debug groups and markers (render pass)
  wgpu_shim_render_pass_push_debug_group: { args: ["ptr", "cstring"], returns: "void" } as CFunction,
  wgpu_shim_render_pass_pop_debug_group: { args: ["ptr"], returns: "void" } as CFunction,
  wgpu_shim_render_pass_insert_debug_marker: { args: ["ptr", "cstring"], returns: "void" } as CFunction,
  // (compute pass)
  wgpu_shim_compute_pass_push_debug_group: { args: ["ptr", "cstring"], returns: "void" } as CFunction,
  wgpu_shim_compute_pass_pop_debug_group: { args: ["ptr"], returns: "void" } as CFunction,
  wgpu_shim_compute_pass_insert_debug_marker: { args: ["ptr", "cstring"], returns: "void" } as CFunction,
  // (command encoder)
  wgpu_shim_command_encoder_push_debug_group: { args: ["ptr", "cstring"], returns: "void" } as CFunction,
  wgpu_shim_command_encoder_pop_debug_group: { args: ["ptr"], returns: "void" } as CFunction,
  wgpu_shim_command_encoder_insert_debug_marker: { args: ["ptr", "cstring"], returns: "void" } as CFunction,

  // Error scopes
  wgpu_shim_device_push_error_scope: { args: ["ptr", "u32"], returns: "void" } as CFunction,
  wgpu_shim_device_pop_error_scope: { args: ["ptr", "ptr", "i32"], returns: "u32" } as CFunction,

  // Adapter/device limits and features
  wgpu_shim_adapter_get_limits: { args: ["ptr", "ptr"], returns: "i32" } as CFunction,
  wgpu_shim_device_get_limits: { args: ["ptr", "ptr"], returns: "i32" } as CFunction,
  wgpu_shim_adapter_get_features: { args: ["ptr", "ptr", "u32"], returns: "u32" } as CFunction,
  wgpu_shim_device_get_features: { args: ["ptr", "ptr", "u32"], returns: "u32" } as CFunction,

  // Queue onSubmittedWorkDone
  wgpu_shim_queue_on_submitted_work_done: { args: ["ptr"], returns: "void" } as CFunction,

  // ── Surface ──
  wgpu_shim_surface_configure: {
    args: ["ptr", "ptr", "u32", "u32", "u32", "u32", "u32"],
    returns: "void",
  } as CFunction,
  wgpu_shim_surface_get_current_texture: {
    args: ["ptr", "ptr"],
    returns: "i32",
  } as CFunction,
  wgpu_shim_surface_present: { args: ["ptr"], returns: "void" } as CFunction,
  wgpu_shim_process_events: { args: ["ptr"], returns: "void" } as CFunction,
  wgpu_shim_get_preferred_format: { args: [], returns: "u32" } as CFunction,

  // ── Release ──
  wgpu_shim_release_buffer: { args: ["ptr"], returns: "void" } as CFunction,
  wgpu_shim_release_texture: { args: ["ptr"], returns: "void" } as CFunction,
  wgpu_shim_release_texture_view: { args: ["ptr"], returns: "void" } as CFunction,
  wgpu_shim_release_sampler: { args: ["ptr"], returns: "void" } as CFunction,
  wgpu_shim_release_bind_group: { args: ["ptr"], returns: "void" } as CFunction,
  wgpu_shim_release_bind_group_layout: { args: ["ptr"], returns: "void" } as CFunction,
  wgpu_shim_release_pipeline_layout: { args: ["ptr"], returns: "void" } as CFunction,
  wgpu_shim_release_render_pipeline: { args: ["ptr"], returns: "void" } as CFunction,
  wgpu_shim_release_compute_pipeline: { args: ["ptr"], returns: "void" } as CFunction,
  wgpu_shim_release_shader_module: { args: ["ptr"], returns: "void" } as CFunction,
  wgpu_shim_release_command_buffer: { args: ["ptr"], returns: "void" } as CFunction,
  wgpu_shim_release_command_encoder: { args: ["ptr"], returns: "void" } as CFunction,
  wgpu_shim_release_device: { args: ["ptr"], returns: "void" } as CFunction,
  wgpu_shim_release_adapter: { args: ["ptr"], returns: "void" } as CFunction,
  wgpu_shim_release_instance: { args: ["ptr"], returns: "void" } as CFunction,
  wgpu_shim_release_surface: { args: ["ptr"], returns: "void" } as CFunction,
  wgpu_shim_release_query_set: { args: ["ptr"], returns: "void" } as CFunction,
});

export const wgpu = symbols as unknown as WgpuShimSymbols;

// ── Typed interface for the FFI symbols ──

export interface WgpuShimSymbols {
  wgpu_shim_create_instance: () => ptr;
  wgpu_shim_request_adapter: (instance: ptr, powerPreference: number) => ptr;
  wgpu_shim_request_device: (
    adapter: ptr,
    maxStorageBufferSize: bigint,
    maxStorageBuffersPerStage: number,
    maxSampledTexturesPerStage: number,
    maxTextureArrayLayers: number,
  ) => ptr;
  wgpu_shim_device_get_queue: (device: ptr) => ptr;
  wgpu_shim_process_events: (instance: ptr) => void;

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
  ) => void;
  wgpu_shim_buffer_get_mapped_range: (
    buffer: ptr,
    offset: bigint,
    size: bigint,
  ) => ptr;
  wgpu_shim_buffer_read_mapped: (
    buffer: ptr,
    offset: bigint,
    size: bigint,
    outData: ptr,
    outSize: number,
  ) => number;
  wgpu_shim_buffer_unmap: (buffer: ptr) => void;

  wgpu_shim_create_shader_module: (device: ptr, wgslCode: string) => ptr;

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
    width: number,
    height: number,
    bytesPerRow: number,
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
    colorTargets: ArrayBufferView,
    depthStencil: ArrayBufferView,
    topology: number,
    stripIndexFormat: number,
    sampleCount: number,
    layout: ptr,
    cullMode: number,
    frontFace: number,
    vertexBufferCount: number,
    vertexBufferData: ArrayBufferView,
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
    dstBuffer: ptr,
    width: number,
    height: number,
    bytesPerRow: number,
  ) => void;

  // ── AUDIT FIX: New functions ──
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
  wgpu_shim_process_events: (instance: ptr) => void;
  wgpu_shim_get_preferred_format: () => number;

  // Release functions
  wgpu_shim_release_buffer: (ptr: ptr) => void;
  wgpu_shim_release_texture: (ptr: ptr) => void;
  wgpu_shim_release_texture_view: (ptr: ptr) => void;
  wgpu_shim_release_sampler: (ptr: ptr) => void;
  wgpu_shim_release_bind_group: (ptr: ptr) => void;
  wgpu_shim_release_bind_group_layout: (ptr: ptr) => void;
  wgpu_shim_release_pipeline_layout: (ptr: ptr) => void;
  wgpu_shim_release_render_pipeline: (ptr: ptr) => void;
  wgpu_shim_release_compute_pipeline: (ptr: ptr) => void;
  wgpu_shim_release_shader_module: (ptr: ptr) => void;
  wgpu_shim_release_command_buffer: (ptr: ptr) => void;
  wgpu_shim_release_command_encoder: (ptr: ptr) => void;
  wgpu_shim_release_device: (ptr: ptr) => void;
  wgpu_shim_release_adapter: (ptr: ptr) => void;
  wgpu_shim_release_instance: (ptr: ptr) => void;
  wgpu_shim_release_surface: (ptr: ptr) => void;
  wgpu_shim_release_query_set: (ptr: ptr) => void;
}

// ── Helper: create a Uint8Array from a native mapped range ──
export function readMappedRange(nativePtr: ptr, byteLength: number): Uint8Array {
  // bun:ffi ptr points to a native buffer. We can create a Uint8Array view
  // over it using new Uint8Array(ptr, 0, byteLength) — but bun:ffi doesn't
  // directly support this. Instead, we use Buffer.from() with the pointer.
  const buf = Buffer.from(nativePtr as unknown as ArrayBuffer, 0, byteLength);
  return new Uint8Array(buf.buffer, buf.byteOffset, byteLength);
}
