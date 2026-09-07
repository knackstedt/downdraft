// ============================================================================
// wgpu_shim.c — thin C wrapper over wgpu-native that flattens struct-based
// APIs into individual parameters for easy bun:ffi binding.
//
// The webgpu.h API uses C struct descriptors for every creation function.
// This shim constructs those structs internally and exposes simple functions
// that take primitive parameters (ints, pointers, strings).
//
// Async APIs (requestAdapter, requestDevice, bufferMapAsync) are made
// synchronous by spinning wgpuInstanceProcessEvents() until the callback fires.
//
// Compile: gcc -shared -fPIC -o libwgpu_shim.so wgpu_shim.c \
//   -I./include -L./lib -lwgpu_native -lSDL2
// ============================================================================

#include <webgpu/webgpu.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <fcntl.h>
#include <unistd.h>

// ── Global instance for async polling ──
static WGPUInstance g_instance = NULL;

// ── Async result storage ──
static WGPUAdapter g_pending_adapter = NULL;
static int g_adapter_requested = 0;
static WGPUDevice g_pending_device = NULL;
static int g_device_requested = 0;
static const char* g_device_error_msg = NULL;

// ── Callbacks ──
static void on_adapter_request(WGPURequestAdapterStatus status, WGPUAdapter adapter, WGPUStringView message, void* userdata1, void* userdata2) {
    if (status == WGPURequestAdapterStatus_Success) {
        g_pending_adapter = adapter;
    } else {
        fprintf(stderr, "[wgpu_shim] Adapter request failed: %.*s\n", (int)message.length, message.data);
    }
    g_adapter_requested = 1;
}

static void on_device_request(WGPURequestDeviceStatus status, WGPUDevice device, WGPUStringView message, void* userdata1, void* userdata2) {
    if (status == WGPURequestDeviceStatus_Success) {
        g_pending_device = device;
    } else {
        g_device_error_msg = strndup(message.data, message.length);
        fprintf(stderr, "[wgpu_shim] Device request failed: %.*s\n", (int)message.length, message.data);
    }
    g_device_requested = 1;
}

static void on_device_lost(WGPUDevice const* device, WGPUDeviceLostReason reason, WGPUStringView message, void* userdata1, void* userdata2) {
    fprintf(stderr, "[wgpu_shim] Device lost: %.*s\n", (int)message.length, message.data);
}

// ── Poll until an async result is ready ──
static void poll_events(void) {
    if (g_instance) {
        wgpuInstanceProcessEvents(g_instance);
    }
}

// ============================================================================
// Public API — called from bun:ffi
// ============================================================================

// Create a WGPUInstance. Returns the opaque pointer (as void*).
void* wgpu_shim_create_instance(void) {
    WGPUInstanceDescriptor desc = {0};
    desc.nextInChain = NULL;
    g_instance = wgpuCreateInstance(&desc);
    return (void*)g_instance;
}

// Request an adapter synchronously. power_preference: 0=default, 1=low-power, 2=high-performance.
// Returns the WGPUAdapter pointer or NULL on failure.
void* wgpu_shim_request_adapter(void* instance_ptr, int power_preference) {
    WGPUInstance instance = (WGPUInstance)instance_ptr;
    g_instance = instance;
    g_pending_adapter = NULL;
    g_adapter_requested = 0;

    WGPURequestAdapterOptions options = {0};
    options.nextInChain = NULL;
    options.powerPreference = (WGPUPowerPreference)power_preference;
    options.backendType = WGPUBackendType_Undefined;
    options.compatibleSurface = NULL;
    options.forceFallbackAdapter = 0;

    WGPURequestAdapterCallbackInfo callbackInfo = {0};
    callbackInfo.mode = WGPUCallbackMode_AllowProcessEvents;
    callbackInfo.callback = on_adapter_request;
    callbackInfo.userdata1 = NULL;
    callbackInfo.userdata2 = NULL;

    wgpuInstanceRequestAdapter(instance, &options, callbackInfo);

    // Poll until the callback fires
    while (!g_adapter_requested) {
        wgpuInstanceProcessEvents(instance);
    }

    return (void*)g_pending_adapter;
}

// Request a device synchronously. Returns the WGPUDevice pointer or NULL.
// max_storage_buffer_binding_size: 0 for default, or a specific limit value.
// Uncaptured error callback — logs the error instead of panicking
static void on_uncaptured_error(WGPUDevice const * device, WGPUErrorType type, WGPUStringView message, void *userdata1, void *userdata2) {
    (void)device; (void)type; (void)userdata1; (void)userdata2;
    fprintf(stderr, "[wgpu] uncaptured error (type=%d): %s\n", (int)type, message.data ? message.data : "(null)");
    fflush(stderr);
}

void* wgpu_shim_request_device(void* adapter_ptr, uint64_t max_storage_buffer_size, uint32_t max_storage_buffers_per_stage, uint32_t max_sampled_textures_per_stage, uint32_t max_texture_array_layers) {
    WGPUAdapter adapter = (WGPUAdapter)adapter_ptr;
    g_pending_device = NULL;
    g_device_requested = 0;
    g_device_error_msg = NULL;

    // Build required limits — initialize all to UNDEFINED so only explicitly
    // requested limits are enforced. Zero values would be interpreted as
    // "require this limit to be 0" which is stricter than adapter defaults.
    WGPULimits requiredLimits = WGPU_LIMITS_INIT;

    // Override only the limits that were explicitly requested (non-zero)
    if (max_storage_buffer_size > 0) requiredLimits.maxStorageBufferBindingSize = max_storage_buffer_size;
    if (max_storage_buffers_per_stage > 0) requiredLimits.maxStorageBuffersPerShaderStage = max_storage_buffers_per_stage;
    if (max_sampled_textures_per_stage > 0) requiredLimits.maxSampledTexturesPerShaderStage = max_sampled_textures_per_stage;
    if (max_texture_array_layers > 0) requiredLimits.maxTextureArrayLayers = max_texture_array_layers;

    WGPUUncapturedErrorCallbackInfo uncapturedErrorInfo = WGPU_UNCAPTURED_ERROR_CALLBACK_INFO_INIT;
    uncapturedErrorInfo.callback = on_uncaptured_error;
    uncapturedErrorInfo.userdata1 = NULL;
    uncapturedErrorInfo.userdata2 = NULL;

    WGPUDeviceDescriptor desc = {0};
    desc.nextInChain = NULL;
    desc.label = (WGPUStringView){0};
    desc.requiredFeatureCount = 0;
    desc.requiredFeatures = NULL;
    desc.requiredLimits = &requiredLimits;
    desc.defaultQueue.nextInChain = NULL;
    desc.defaultQueue.label = (WGPUStringView){0};
    desc.deviceLostCallbackInfo.mode = WGPUCallbackMode_AllowProcessEvents;
    desc.deviceLostCallbackInfo.callback = on_device_lost;
    desc.deviceLostCallbackInfo.userdata1 = NULL;
    desc.deviceLostCallbackInfo.userdata2 = NULL;
    desc.uncapturedErrorCallbackInfo = uncapturedErrorInfo;

    WGPURequestDeviceCallbackInfo callbackInfo = {0};
    callbackInfo.mode = WGPUCallbackMode_AllowProcessEvents;
    callbackInfo.callback = on_device_request;
    callbackInfo.userdata1 = NULL;
    callbackInfo.userdata2 = NULL;

    wgpuAdapterRequestDevice(adapter, &desc, callbackInfo);

    // Poll until the callback fires
    while (!g_device_requested) {
        wgpuInstanceProcessEvents(g_instance);
    }

    return (void*)g_pending_device;
}

// Get the queue from a device.
void* wgpu_shim_device_get_queue(void* device_ptr) {
    return (void*)wgpuDeviceGetQueue((WGPUDevice)device_ptr);
}

// Create a buffer. usage is a bitmask of WGPUBufferUsage flags.
void* wgpu_shim_create_buffer(void* device_ptr, uint64_t size, uint32_t usage, int mapped_at_creation) {
    WGPUBufferDescriptor desc = {0};
    desc.nextInChain = NULL;
    desc.label = (WGPUStringView){0};
    desc.usage = (WGPUBufferUsage)usage;
    desc.size = size;
    desc.mappedAtCreation = mapped_at_creation ? 1 : 0;

    return (void*)wgpuDeviceCreateBuffer((WGPUDevice)device_ptr, &desc);
}

// Write data to a buffer via the queue.
void wgpu_shim_queue_write_buffer(void* queue_ptr, void* buffer_ptr, uint64_t offset, void* data, size_t size) {
    wgpuQueueWriteBuffer((WGPUQueue)queue_ptr, (WGPUBuffer)buffer_ptr, offset, data, size);
}

// Create a shader module from WGSL code.
void* wgpu_shim_create_shader_module(void* device_ptr, const char* wgsl_code) {
    WGPUShaderModuleDescriptor desc = {0};
    desc.nextInChain = NULL;
    desc.label = (WGPUStringView){0};

    WGPUShaderSourceWGSL wgslSource = {0};
    wgslSource.chain.next = NULL;
    wgslSource.chain.sType = WGPUSType_ShaderSourceWGSL;
    wgslSource.code = (WGPUStringView){ .data = wgsl_code, .length = strlen(wgsl_code) };

    desc.nextInChain = (const WGPUChainedStruct*)&wgslSource;

    return (void*)wgpuDeviceCreateShaderModule((WGPUDevice)device_ptr, &desc);
}

// Create a texture.
void* wgpu_shim_create_texture(void* device_ptr, uint32_t width, uint32_t height, uint32_t depth_or_array_layers, uint32_t mip_level_count, uint32_t sample_count, uint32_t dimension, uint32_t format, uint32_t usage, uint32_t view_format_count, const uint32_t* view_formats) {
    WGPUTextureDescriptor desc = {0};
    desc.nextInChain = NULL;
    desc.label = (WGPUStringView){0};
    desc.usage = (WGPUTextureUsage)usage;
    desc.dimension = (WGPUTextureDimension)dimension;
    desc.size.width = width;
    desc.size.height = height;
    desc.size.depthOrArrayLayers = depth_or_array_layers;
    desc.mipLevelCount = mip_level_count;
    desc.sampleCount = sample_count;
    desc.format = (WGPUTextureFormat)format;
    desc.viewFormatCount = view_format_count;
    desc.viewFormats = (WGPUTextureFormat*)view_formats;

    return (void*)wgpuDeviceCreateTexture((WGPUDevice)device_ptr, &desc);
}

// Create a texture view.
void* wgpu_shim_texture_create_view(void* texture_ptr, uint32_t format, uint32_t dimension, uint32_t aspect, uint32_t base_mip_level, uint32_t mip_level_count, uint32_t base_array_layer, uint32_t array_layer_count) {
    WGPUTextureViewDescriptor desc = {0};
    desc.nextInChain = NULL;
    desc.label = (WGPUStringView){0};
    desc.format = format == 0 ? WGPUTextureFormat_Undefined : (WGPUTextureFormat)format;
    desc.dimension = dimension == 0 ? WGPUTextureViewDimension_Undefined : (WGPUTextureViewDimension)dimension;
    desc.aspect = (WGPUTextureAspect)aspect;
    desc.baseMipLevel = base_mip_level;
    desc.mipLevelCount = mip_level_count;
    desc.baseArrayLayer = base_array_layer;
    desc.arrayLayerCount = array_layer_count;

    return (void*)wgpuTextureCreateView((WGPUTexture)texture_ptr, &desc);
}

// Create a sampler.
void* wgpu_shim_create_sampler(void* device_ptr, uint32_t mag_filter, uint32_t min_filter, uint32_t address_mode_u, uint32_t address_mode_v) {
    WGPUSamplerDescriptor desc = {0};
    desc.nextInChain = NULL;
    desc.label = (WGPUStringView){0};
    desc.addressModeU = (WGPUAddressMode)address_mode_u;
    desc.addressModeV = (WGPUAddressMode)address_mode_v;
    desc.addressModeW = WGPUAddressMode_ClampToEdge;
    desc.magFilter = (WGPUFilterMode)mag_filter;
    desc.minFilter = (WGPUFilterMode)min_filter;
    desc.mipmapFilter = WGPUMipmapFilterMode_Nearest;
    desc.lodMinClamp = 0.0f;
    desc.lodMaxClamp = 0.0f;
    desc.compare = WGPUCompareFunction_Undefined;
    desc.maxAnisotropy = 1;

    return (void*)wgpuDeviceCreateSampler((WGPUDevice)device_ptr, &desc);
}

// Create a bind group layout.
// entry_count: number of entries
// entries: flat array of (binding, visibility, buffer_type, sampler_type, texture_sample_type, texture_view_dimension, storage_texture_access, storage_texture_format) per entry
// Each entry is 8 uint32_t values.
void* wgpu_shim_create_bind_group_layout(void* device_ptr, uint32_t entry_count, const uint32_t* entries_flat) {
    WGPUBindGroupLayoutEntry* entries = (WGPUBindGroupLayoutEntry*)calloc(entry_count, sizeof(WGPUBindGroupLayoutEntry));

    for (uint32_t i = 0; i < entry_count; i++) {
        const uint32_t* e = entries_flat + i * 8;
        // Zero the entire entry first (all binding types = BindingNotUsed)
        memset(&entries[i], 0, sizeof(WGPUBindGroupLayoutEntry));
        entries[i].nextInChain = NULL;
        entries[i].binding = e[0];
        entries[i].visibility = (WGPUShaderStage)e[1];

        // Buffer binding
        if (e[2] != 0) {
            entries[i].buffer.type = (WGPUBufferBindingType)e[2];
            entries[i].buffer.hasDynamicOffset = 0;
            entries[i].buffer.minBindingSize = 0;
        }
        // Sampler binding
        if (e[3] != 0) {
            entries[i].sampler.type = (WGPUSamplerBindingType)e[3];
        }
        // Texture binding
        if (e[4] != 0) {
            entries[i].texture.sampleType = (WGPUTextureSampleType)e[4];
            entries[i].texture.viewDimension = (WGPUTextureViewDimension)e[5];
            entries[i].texture.multisampled = 0;
        }
        // Storage texture binding
        if (e[6] != 0) {
            entries[i].storageTexture.access = (WGPUStorageTextureAccess)e[6];
            entries[i].storageTexture.format = (WGPUTextureFormat)e[7];
            entries[i].storageTexture.viewDimension = (WGPUTextureViewDimension)e[5];
        }
    }

    WGPUBindGroupLayoutDescriptor desc = {0};
    desc.nextInChain = NULL;
    desc.label = (WGPUStringView){0};
    desc.entryCount = entry_count;
    desc.entries = entries;

    WGPUBindGroupLayout result = wgpuDeviceCreateBindGroupLayout((WGPUDevice)device_ptr, &desc);
    free(entries);
    return (void*)result;
}

// Create a pipeline layout from an array of bind group layout pointers.
void* wgpu_shim_create_pipeline_layout(void* device_ptr, uint32_t layout_count, const void** layouts) {
    WGPUPipelineLayoutDescriptor desc = {0};
    desc.nextInChain = NULL;
    desc.label = (WGPUStringView){0};
    desc.bindGroupLayoutCount = layout_count;
    desc.bindGroupLayouts = (const WGPUBindGroupLayout*)layouts;

    return (void*)wgpuDeviceCreatePipelineLayout((WGPUDevice)device_ptr, &desc);
}

// Create a bind group.
// entry_count: number of entries
// entries_flat: flat array of (binding, resource_type, resource_ptr, offset, size) per entry
// Each entry is: uint32_t binding, uint32_t resource_type (0=buffer, 1=sampler, 2=texture_view), void* resource, uint64_t offset, uint64_t size
void* wgpu_shim_create_bind_group(void* device_ptr, void* layout_ptr, uint32_t entry_count, const uint32_t* entries_flat) {
    WGPUBindGroupEntry* entries = (WGPUBindGroupEntry*)calloc(entry_count, sizeof(WGPUBindGroupEntry));

    for (uint32_t i = 0; i < entry_count; i++) {
        const uint32_t* e = entries_flat + i * 8; // 8 uint32_t per entry (binding, type, ptr_lo, ptr_hi, offset_lo, offset_hi, size_lo, size_hi)
        entries[i].binding = e[0];
        uint32_t type = e[1];
        void* resource = (void*)(uintptr_t)((uint64_t)e[3] << 32 | e[2]);
        uint64_t offset = (uint64_t)e[5] << 32 | e[4];
        uint64_t size = (uint64_t)e[7] << 32 | e[6];

        if (type == 0) { // buffer
            entries[i].buffer = (WGPUBuffer)resource;
            entries[i].offset = offset;
            entries[i].size = (size == 0) ? WGPU_WHOLE_SIZE : size;
        } else if (type == 1) { // sampler
            entries[i].sampler = (WGPUSampler)resource;
        } else if (type == 2) { // texture view
            entries[i].textureView = (WGPUTextureView)resource;
        }
    }

    WGPUBindGroupDescriptor desc = {0};
    desc.nextInChain = NULL;
    desc.label = (WGPUStringView){0};
    desc.layout = (WGPUBindGroupLayout)layout_ptr;
    desc.entryCount = entry_count;
    desc.entries = entries;

    WGPUBindGroup result = wgpuDeviceCreateBindGroup((WGPUDevice)device_ptr, &desc);
    free(entries);
    return (void*)result;
}

// Create a command encoder.
void* wgpu_shim_create_command_encoder(void* device_ptr) {
    WGPUCommandEncoderDescriptor desc = {0};
    desc.nextInChain = NULL;
    desc.label = (WGPUStringView){0};
    return (void*)wgpuDeviceCreateCommandEncoder((WGPUDevice)device_ptr, &desc);
}

// Finish a command encoder and return the command buffer.
void* wgpu_shim_command_encoder_finish(void* encoder_ptr) {
    WGPUCommandBufferDescriptor desc = {0};
    desc.nextInChain = NULL;
    desc.label = (WGPUStringView){0};
    return (void*)wgpuCommandEncoderFinish((WGPUCommandEncoder)encoder_ptr, &desc);
}

// Submit command buffers to the queue.
void wgpu_shim_queue_submit(void* queue_ptr, void** command_buffers, uint32_t count) {
    wgpuQueueSubmit((WGPUQueue)queue_ptr, count, (const WGPUCommandBuffer*)command_buffers);
}

// Process events (for async callback delivery).
void wgpu_shim_process_events(void* instance_ptr) {
    wgpuInstanceProcessEvents((WGPUInstance)instance_ptr);
}

// ── Surface support (SDL2 window) ──
// These are implemented in the SDL2 window module, but we declare them here
// so the shim can be compiled independently.

// Get the preferred canvas format (bgra8unorm on most platforms).
uint32_t wgpu_shim_get_preferred_format(void) {
    return (uint32_t)WGPUTextureFormat_BGRA8Unorm;
}

// ── Render pass helpers ──

// Begin a render pass with a single color attachment.
// color_attachment_ptr: pointer to a WGPUTextureView
// clear_r, clear_g, clear_b, clear_a: clear color
// load_op: 0=clear, 1=load
// store_op: 0=store, 1=discard
void* wgpu_shim_begin_render_pass(void* encoder_ptr, void* color_view_ptr, float clear_r, float clear_g, float clear_b, float clear_a, uint32_t load_op, uint32_t store_op, void* depth_view_ptr) {
    WGPURenderPassColorAttachment colorAttachment = {0};
    colorAttachment.view = (WGPUTextureView)color_view_ptr;
    colorAttachment.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
    colorAttachment.loadOp = (WGPULoadOp)load_op;
    colorAttachment.storeOp = (WGPUStoreOp)store_op;
    colorAttachment.clearValue.r = clear_r;
    colorAttachment.clearValue.g = clear_g;
    colorAttachment.clearValue.b = clear_b;
    colorAttachment.clearValue.a = clear_a;

    WGPURenderPassDescriptor desc = {0};
    desc.nextInChain = NULL;
    desc.label = (WGPUStringView){0};
    desc.colorAttachmentCount = 1;
    desc.colorAttachments = &colorAttachment;
    desc.depthStencilAttachment = NULL;
    if (depth_view_ptr) {
        static WGPURenderPassDepthStencilAttachment depthAttachment;
        depthAttachment.view = (WGPUTextureView)depth_view_ptr;
        depthAttachment.depthLoadOp = WGPULoadOp_Clear;
        depthAttachment.depthStoreOp = WGPUStoreOp_Store;
        depthAttachment.depthClearValue = 1.0f;
        depthAttachment.depthReadOnly = 0;
        depthAttachment.stencilLoadOp = WGPULoadOp_Clear;
        depthAttachment.stencilStoreOp = WGPUStoreOp_Store;
        depthAttachment.stencilClearValue = 0;
        depthAttachment.stencilReadOnly = 0;
        desc.depthStencilAttachment = &depthAttachment;
    }
    desc.occlusionQuerySet = NULL;
    desc.timestampWrites = NULL;

    return (void*)wgpuCommandEncoderBeginRenderPass((WGPUCommandEncoder)encoder_ptr, &desc);
}

// Set pipeline on a render pass encoder.
void wgpu_shim_render_pass_set_pipeline(void* pass_ptr, void* pipeline_ptr) {
    wgpuRenderPassEncoderSetPipeline((WGPURenderPassEncoder)pass_ptr, (WGPURenderPipeline)pipeline_ptr);
}

// Set bind group on a render pass encoder.
void wgpu_shim_render_pass_set_bind_group(void* pass_ptr, uint32_t group_index, void* bind_group_ptr) {
    wgpuRenderPassEncoderSetBindGroup((WGPURenderPassEncoder)pass_ptr, group_index, (WGPUBindGroup)bind_group_ptr, 0, NULL);
}

// Set vertex buffer on a render pass encoder.
void wgpu_shim_render_pass_set_vertex_buffer(void* pass_ptr, uint32_t slot, void* buffer_ptr, uint64_t offset, uint64_t size) {
    wgpuRenderPassEncoderSetVertexBuffer((WGPURenderPassEncoder)pass_ptr, slot, (WGPUBuffer)buffer_ptr, offset, size);
}

// Set index buffer on a render pass encoder.
void wgpu_shim_render_pass_set_index_buffer(void* pass_ptr, void* buffer_ptr, uint32_t format, uint64_t offset, uint64_t size) {
    wgpuRenderPassEncoderSetIndexBuffer((WGPURenderPassEncoder)pass_ptr, (WGPUBuffer)buffer_ptr, (WGPUIndexFormat)format, offset, size);
}

// Draw on a render pass encoder.
void wgpu_shim_render_pass_draw(void* pass_ptr, uint32_t vertex_count, uint32_t instance_count, uint32_t first_vertex, uint32_t first_instance) {
    wgpuRenderPassEncoderDraw((WGPURenderPassEncoder)pass_ptr, vertex_count, instance_count, first_vertex, first_instance);
}

// Draw indexed on a render pass encoder.
void wgpu_shim_render_pass_draw_indexed(void* pass_ptr, uint32_t index_count, uint32_t instance_count, uint32_t first_index, int32_t base_vertex, uint32_t first_instance) {
    wgpuRenderPassEncoderDrawIndexed((WGPURenderPassEncoder)pass_ptr, index_count, instance_count, first_index, base_vertex, first_instance);
}

// End a render pass.
void wgpu_shim_render_pass_end(void* pass_ptr) {
    wgpuRenderPassEncoderEnd((WGPURenderPassEncoder)pass_ptr);
}

// Set scissor rect on a render pass encoder.
void wgpu_shim_render_pass_set_scissor_rect(void* pass_ptr, uint32_t x, uint32_t y, uint32_t width, uint32_t height) {
    wgpuRenderPassEncoderSetScissorRect((WGPURenderPassEncoder)pass_ptr, x, y, width, height);
}

// Set viewport on a render pass encoder.
void wgpu_shim_render_pass_set_viewport(void* pass_ptr, float x, float y, float width, float height, float min_depth, float max_depth) {
    wgpuRenderPassEncoderSetViewport((WGPURenderPassEncoder)pass_ptr, x, y, width, height, min_depth, max_depth);
}

// ── Render pipeline creation ──
// This is the most complex one. We take individual parameters for the most
// common pipeline configuration (vertex + fragment with one bind group layout).
// For more complex pipelines, use the full wgpu API directly.

// Create a simple render pipeline with vertex + fragment shaders.
// vertex_shader_ptr: WGPUShaderModule pointer
// vertex_entry: entry point string
// fragment_shader_ptr: WGPUShaderModule pointer (can be NULL for depth-only)
// fragment_entry: entry point string
// color_format: WGPUTextureFormat for the color target
// depth_format: WGPUTextureFormat for depth (0 = no depth)
// topology: WGPUPrimitiveTopology
// sample_count: MSAA sample count (1 = no MSAA)
// layout_ptr: WGPUPipelineLayout pointer (can be NULL for auto-layout)
void* wgpu_shim_create_render_pipeline(
    void* device_ptr,
    void* vertex_shader_ptr, const char* vertex_entry,
    void* fragment_shader_ptr, const char* fragment_entry,
    uint32_t color_format, uint32_t depth_format,
    uint32_t topology, uint32_t sample_count,
    void* layout_ptr,
    uint32_t cull_mode,
    uint32_t front_face,
    uint32_t vertex_buffer_count, const uint32_t* vertex_buffer_data,
    uint32_t has_blend,
    uint32_t color_src_factor, uint32_t color_dst_factor, uint32_t color_operation,
    uint32_t alpha_src_factor, uint32_t alpha_dst_factor, uint32_t alpha_operation
) {
    // vertex_buffer_data is a flat array. For each vertex buffer:
    //   arrayStride (u32), stepMode (u32: 0=vertex, 1=instance), attributeCount (u32),
    //   followed by attributeCount * 3 u32s: format, offset, shaderLocation
    WGPUVertexBufferLayout vertexBufferLayouts[8] = {0};
    WGPUVertexAttribute* attrArrays[8] = {0};
    for (uint32_t b = 0; b < vertex_buffer_count && b < 8; b++) {
        const uint32_t* bufData = vertex_buffer_data;
        // Skip to the correct buffer by walking the variable-size records
        for (uint32_t i = 0; i < b; i++) {
            uint32_t ac = vertex_buffer_data[2]; // attributeCount of buffer i
            // But we need to walk from the start each time since records are variable-size
            (void)ac;
        }
        // Actually, we need to walk linearly. Let me restructure.
        (void)bufData;
    }

    // Walk the flat data linearly
    const uint32_t* cursor = vertex_buffer_data;
    uint32_t actualBufferCount = 0;
    for (uint32_t b = 0; b < vertex_buffer_count && b < 8; b++) {
        uint32_t arrayStride = cursor[0];
        uint32_t stepMode = cursor[1];
        uint32_t attrCount = cursor[2];
        cursor += 3;

        vertexBufferLayouts[b].arrayStride = arrayStride;
        vertexBufferLayouts[b].stepMode = (stepMode == 1) ? WGPUVertexStepMode_Instance : WGPUVertexStepMode_Vertex;
        vertexBufferLayouts[b].attributeCount = attrCount;

        if (attrCount > 0) {
            WGPUVertexAttribute* attrs = (WGPUVertexAttribute*)calloc(attrCount, sizeof(WGPUVertexAttribute));
            for (uint32_t i = 0; i < attrCount; i++) {
                attrs[i].format = (WGPUVertexFormat)cursor[0];
                attrs[i].offset = cursor[1];
                attrs[i].shaderLocation = cursor[2];
                cursor += 3;
            }
            vertexBufferLayouts[b].attributes = attrs;
            attrArrays[b] = attrs;
        }
        actualBufferCount++;
    }

    WGPUVertexState vertexState = {0};
    vertexState.nextInChain = NULL;
    vertexState.module = (WGPUShaderModule)vertex_shader_ptr;
    vertexState.entryPoint = (WGPUStringView){ .data = vertex_entry, .length = strlen(vertex_entry) };
    vertexState.constantCount = 0;
    vertexState.constants = NULL;
    vertexState.bufferCount = actualBufferCount;
    vertexState.buffers = actualBufferCount > 0 ? vertexBufferLayouts : NULL;

    WGPUFragmentState fragmentState = {0};
    WGPUBlendState blendState = {0};
    WGPUColorTargetState colorTarget = {0};
    if (fragment_shader_ptr) {
        colorTarget.nextInChain = NULL;
        colorTarget.format = (WGPUTextureFormat)color_format;
        if (has_blend) {
            blendState.color.srcFactor = (WGPUBlendFactor)color_src_factor;
            blendState.color.dstFactor = (WGPUBlendFactor)color_dst_factor;
            blendState.color.operation = (WGPUBlendOperation)color_operation;
            blendState.alpha.srcFactor = (WGPUBlendFactor)alpha_src_factor;
            blendState.alpha.dstFactor = (WGPUBlendFactor)alpha_dst_factor;
            blendState.alpha.operation = (WGPUBlendOperation)alpha_operation;
            colorTarget.blend = &blendState;
        } else {
            colorTarget.blend = NULL;
        }
        colorTarget.writeMask = WGPUColorWriteMask_All;

        fragmentState.nextInChain = NULL;
        fragmentState.module = (WGPUShaderModule)fragment_shader_ptr;
        fragmentState.entryPoint = (WGPUStringView){ .data = fragment_entry, .length = strlen(fragment_entry) };
        fragmentState.constantCount = 0;
        fragmentState.constants = NULL;
        fragmentState.targetCount = 1;
        fragmentState.targets = &colorTarget;
    }

    WGPUPrimitiveState primitiveState = {0};
    primitiveState.nextInChain = NULL;
    primitiveState.topology = (WGPUPrimitiveTopology)topology;
    primitiveState.stripIndexFormat = WGPUIndexFormat_Undefined;
    primitiveState.frontFace = (WGPUFrontFace)front_face;
    primitiveState.cullMode = (WGPUCullMode)cull_mode;

    WGPUDepthStencilState depthStencilState = {0};
    if (depth_format != 0) {
        depthStencilState.nextInChain = NULL;
        depthStencilState.format = (WGPUTextureFormat)depth_format;
        depthStencilState.depthWriteEnabled = 1;
        depthStencilState.depthCompare = WGPUCompareFunction_Less;
        depthStencilState.stencilFront.compare = WGPUCompareFunction_Always;
        depthStencilState.stencilBack.compare = WGPUCompareFunction_Always;
        depthStencilState.stencilReadMask = 0xFFFFFFFF;
        depthStencilState.stencilWriteMask = 0xFFFFFFFF;
        depthStencilState.depthBias = 0;
        depthStencilState.depthBiasSlopeScale = 0.0f;
        depthStencilState.depthBiasClamp = 0.0f;
    }

    WGPUMultisampleState multisampleState = {0};
    multisampleState.nextInChain = NULL;
    multisampleState.count = sample_count;
    multisampleState.mask = 0xFFFFFFFF;
    multisampleState.alphaToCoverageEnabled = 0;

    WGPURenderPipelineDescriptor desc = {0};
    desc.nextInChain = NULL;
    desc.label = (WGPUStringView){0};
    desc.layout = (WGPUPipelineLayout)layout_ptr;
    desc.vertex = vertexState;
    desc.fragment = fragment_shader_ptr ? &fragmentState : NULL;
    desc.primitive = primitiveState;
    desc.depthStencil = depth_format != 0 ? &depthStencilState : NULL;
    desc.multisample = multisampleState;

    WGPURenderPipeline result = wgpuDeviceCreateRenderPipeline((WGPUDevice)device_ptr, &desc);

    for (uint32_t b = 0; b < actualBufferCount; b++) {
        if (attrArrays[b]) free(attrArrays[b]);
    }

    return (void*)result;
}

// ── Compute pipeline creation ──
void* wgpu_shim_create_compute_pipeline(
    void* device_ptr,
    void* shader_ptr, const char* entry_point,
    void* layout_ptr
) {
    WGPUComputePipelineDescriptor desc = {0};
    desc.nextInChain = NULL;
    desc.label = (WGPUStringView){0};
    desc.layout = (WGPUPipelineLayout)layout_ptr;
    desc.compute.nextInChain = NULL;
    desc.compute.module = (WGPUShaderModule)shader_ptr;
    desc.compute.entryPoint = (WGPUStringView){ .data = entry_point, .length = strlen(entry_point) };
    desc.compute.constantCount = 0;
    desc.compute.constants = NULL;

    return (void*)wgpuDeviceCreateComputePipeline((WGPUDevice)device_ptr, &desc);
}

// ── Compute pass helpers ──
void* wgpu_shim_begin_compute_pass(void* encoder_ptr) {
    WGPUComputePassDescriptor desc = {0};
    desc.nextInChain = NULL;
    desc.label = (WGPUStringView){0};
    return (void*)wgpuCommandEncoderBeginComputePass((WGPUCommandEncoder)encoder_ptr, &desc);
}

void wgpu_shim_compute_pass_set_pipeline(void* pass_ptr, void* pipeline_ptr) {
    wgpuComputePassEncoderSetPipeline((WGPUComputePassEncoder)pass_ptr, (WGPUComputePipeline)pipeline_ptr);
}

void wgpu_shim_compute_pass_set_bind_group(void* pass_ptr, uint32_t group_index, void* bind_group_ptr) {
    wgpuComputePassEncoderSetBindGroup((WGPUComputePassEncoder)pass_ptr, group_index, (WGPUBindGroup)bind_group_ptr, 0, NULL);
}

void wgpu_shim_compute_pass_dispatch(void* pass_ptr, uint32_t x, uint32_t y, uint32_t z) {
    wgpuComputePassEncoderDispatchWorkgroups((WGPUComputePassEncoder)pass_ptr, x, y, z);
}

void wgpu_shim_compute_pass_end(void* pass_ptr) {
    wgpuComputePassEncoderEnd((WGPUComputePassEncoder)pass_ptr);
}

// ── Copy helpers ──
void wgpu_shim_copy_buffer_to_buffer(void* encoder_ptr, void* src_ptr, uint64_t src_offset, void* dst_ptr, uint64_t dst_offset, uint64_t size) {
    wgpuCommandEncoderCopyBufferToBuffer((WGPUCommandEncoder)encoder_ptr, (WGPUBuffer)src_ptr, src_offset, (WGPUBuffer)dst_ptr, dst_offset, size);
}

// ── Buffer mapping ──
static void* g_mapped_range = NULL;
static int g_map_complete = 0;
static WGPUBufferMapState g_map_status = WGPUBufferMapState_Unmapped;

static void on_buffer_map(WGPUMapAsyncStatus status, WGPUStringView message, void* userdata1, void* userdata2) {
    g_map_complete = 1;
    g_map_status = (status == WGPUMapAsyncStatus_Success) ? WGPUBufferMapState_Mapped : WGPUBufferMapState_Unmapped;
}

void wgpu_shim_buffer_map_async(void* buffer_ptr, uint32_t mode, uint64_t offset, uint64_t size) {
    g_map_complete = 0;
    WGPUBufferMapCallbackInfo callbackInfo = {0};
    callbackInfo.mode = WGPUCallbackMode_AllowProcessEvents;
    callbackInfo.callback = on_buffer_map;
    wgpuBufferMapAsync((WGPUBuffer)buffer_ptr, (WGPUMapMode)mode, offset, size, callbackInfo);
    while (!g_map_complete) {
        wgpuInstanceProcessEvents(g_instance);
    }
}

void* wgpu_shim_buffer_get_mapped_range(void* buffer_ptr, uint64_t offset, uint64_t size) {
    return wgpuBufferGetMappedRange((WGPUBuffer)buffer_ptr, offset, size);
}

// Copy mapped buffer data into a provided output buffer (JS-owned memory).
// This avoids the need to read from a native pointer in JS.
// Returns 0 on success, non-zero on failure.
int wgpu_shim_buffer_read_mapped(void* buffer_ptr, uint64_t offset, uint64_t size, void* out_data, int out_size) {
    void* mapped = wgpuBufferGetMappedRange((WGPUBuffer)buffer_ptr, offset, size);
    if (!mapped) return 1;
    if (out_size < (int)size) return 2;
    memcpy(out_data, mapped, size);
    return 0;
}

void wgpu_shim_buffer_unmap(void* buffer_ptr) {
    wgpuBufferUnmap((WGPUBuffer)buffer_ptr);
}

// ── Surface configuration (for SDL2 window) ──
// This requires SDL2 to create the window, then we create a wgpu surface from it.
// The surface creation is platform-specific, so we delegate to a separate function
// that's implemented in the SDL2 window module.

// Configure a surface for presentation.
void wgpu_shim_surface_configure(void* surface_ptr, void* device_ptr, uint32_t format, uint32_t usage, uint32_t width, uint32_t height, uint32_t present_mode) {
    WGPUSurfaceConfiguration config = {0};
    config.nextInChain = NULL;
    config.device = (WGPUDevice)device_ptr;
    config.format = (WGPUTextureFormat)format;
    config.usage = (WGPUTextureUsage)usage;
    config.width = width;
    config.height = height;
    config.presentMode = (WGPUPresentMode)present_mode;
    config.alphaMode = WGPUCompositeAlphaMode_Auto;
    config.viewFormatCount = 0;
    config.viewFormats = NULL;

    wgpuSurfaceConfigure((WGPUSurface)surface_ptr, &config);
}

// Get the current texture from a surface.
// Returns 0 on success, non-zero on error.
// texture_ptr_out: pointer to where the WGPUTexture pointer will be stored.
int wgpu_shim_surface_get_current_texture(void* surface_ptr, void** texture_ptr_out) {
    WGPUSurfaceTexture surfaceTexture;
    wgpuSurfaceGetCurrentTexture((WGPUSurface)surface_ptr, &surfaceTexture);
    *texture_ptr_out = (void*)surfaceTexture.texture;
    return (int)surfaceTexture.status;
}

// Present a surface.
void wgpu_shim_surface_present(void* surface_ptr) {
    wgpuSurfacePresent((WGPUSurface)surface_ptr);
}

// ── Release functions (for cleanup) ──
void wgpu_shim_release_buffer(void* ptr) { wgpuBufferRelease((WGPUBuffer)ptr); }
void wgpu_shim_release_texture(void* ptr) { wgpuTextureRelease((WGPUTexture)ptr); }
void wgpu_shim_release_texture_view(void* ptr) { wgpuTextureViewRelease((WGPUTextureView)ptr); }
void wgpu_shim_release_sampler(void* ptr) { wgpuSamplerRelease((WGPUSampler)ptr); }
void wgpu_shim_release_bind_group(void* ptr) { wgpuBindGroupRelease((WGPUBindGroup)ptr); }
void wgpu_shim_release_bind_group_layout(void* ptr) { wgpuBindGroupLayoutRelease((WGPUBindGroupLayout)ptr); }
void wgpu_shim_release_pipeline_layout(void* ptr) { wgpuPipelineLayoutRelease((WGPUPipelineLayout)ptr); }
void wgpu_shim_release_render_pipeline(void* ptr) { wgpuRenderPipelineRelease((WGPURenderPipeline)ptr); }
void wgpu_shim_release_compute_pipeline(void* ptr) { wgpuComputePipelineRelease((WGPUComputePipeline)ptr); }
void wgpu_shim_release_shader_module(void* ptr) { wgpuShaderModuleRelease((WGPUShaderModule)ptr); }
void wgpu_shim_release_command_buffer(void* ptr) { wgpuCommandBufferRelease((WGPUCommandBuffer)ptr); }
void wgpu_shim_release_command_encoder(void* ptr) { wgpuCommandEncoderRelease((WGPUCommandEncoder)ptr); }
void wgpu_shim_release_device(void* ptr) { wgpuDeviceRelease((WGPUDevice)ptr); }
void wgpu_shim_release_adapter(void* ptr) { wgpuAdapterRelease((WGPUAdapter)ptr); }
void wgpu_shim_release_instance(void* ptr) { wgpuInstanceRelease((WGPUInstance)ptr); }
void wgpu_shim_release_surface(void* ptr) { wgpuSurfaceRelease((WGPUSurface)ptr); }

// ── Queue write texture ──
void wgpu_shim_queue_write_texture(void* queue_ptr, void* texture_ptr, void* data, size_t data_size, uint32_t width, uint32_t height, uint32_t bytes_per_row) {
    WGPUTexelCopyTextureInfo dest = {0};
    dest.texture = (WGPUTexture)texture_ptr;
    dest.mipLevel = 0;
    dest.origin.x = 0;
    dest.origin.y = 0;
    dest.origin.z = 0;
    dest.aspect = WGPUTextureAspect_All;

    WGPUTexelCopyBufferLayout layout = {0};
    layout.offset = 0;
    layout.bytesPerRow = bytes_per_row;
    layout.rowsPerImage = height;

    WGPUExtent3D writeSize = {0};
    writeSize.width = width;
    writeSize.height = height;
    writeSize.depthOrArrayLayers = 1;

    wgpuQueueWriteTexture((WGPUQueue)queue_ptr, &dest, data, data_size, &layout, &writeSize);
}

// ── Copy texture to buffer (for screenshots) ──
void wgpu_shim_copy_texture_to_buffer(void* encoder_ptr, void* src_texture_ptr, void* dst_buffer_ptr, uint32_t width, uint32_t height, uint32_t bytes_per_row) {
    WGPUTexelCopyTextureInfo src = {0};
    src.texture = (WGPUTexture)src_texture_ptr;
    src.mipLevel = 0;
    src.origin.x = 0;
    src.origin.y = 0;
    src.origin.z = 0;
    src.aspect = WGPUTextureAspect_All;

    WGPUTexelCopyBufferInfo dst = {0};
    dst.buffer = (WGPUBuffer)dst_buffer_ptr;
    dst.layout.offset = 0;
    dst.layout.bytesPerRow = bytes_per_row;
    dst.layout.rowsPerImage = height;

    WGPUExtent3D copySize = {0};
    copySize.width = width;
    copySize.height = height;
    copySize.depthOrArrayLayers = 1;

    wgpuCommandEncoderCopyTextureToBuffer((WGPUCommandEncoder)encoder_ptr, &src, &dst, &copySize);
}
