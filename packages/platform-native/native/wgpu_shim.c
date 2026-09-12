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
// AUDIT FIX: previously hardcoded addressModeW, mipmapFilter, lod clamps, compare,
// and maxAnisotropy — which silently broke comparison samplers (shadow mapping).
// Now all fields are passed from the JS descriptor.
//   mag_filter/min_filter/mipmap_filter: WGPUFilterMode (Nearest=1, Linear=2; 0=Undefined→Nearest)
//   address_mode_u/v/w: WGPUAddressMode (ClampToEdge=1, Repeat=2, MirrorRepeat=3; 0=Undefined→ClampToEdge)
//   compare: WGPUCompareFunction (Never=1..Always=8; 0=Undefined → no comparison)
//   lod_min_clamp/lod_max_clamp: float
//   max_anisotropy: uint16
void* wgpu_shim_create_sampler(
    void* device_ptr,
    uint32_t mag_filter, uint32_t min_filter, uint32_t mipmap_filter,
    uint32_t address_mode_u, uint32_t address_mode_v, uint32_t address_mode_w,
    float lod_min_clamp, float lod_max_clamp,
    uint32_t compare, uint32_t max_anisotropy
) {
    WGPUSamplerDescriptor desc = {0};
    desc.nextInChain = NULL;
    desc.label = (WGPUStringView){0};
    // 0 (Undefined) defaults: address modes → ClampToEdge, filters → Nearest.
    desc.addressModeU = address_mode_u ? (WGPUAddressMode)address_mode_u : WGPUAddressMode_ClampToEdge;
    desc.addressModeV = address_mode_v ? (WGPUAddressMode)address_mode_v : WGPUAddressMode_ClampToEdge;
    desc.addressModeW = address_mode_w ? (WGPUAddressMode)address_mode_w : WGPUAddressMode_ClampToEdge;
    desc.magFilter = mag_filter ? (WGPUFilterMode)mag_filter : WGPUFilterMode_Nearest;
    desc.minFilter = min_filter ? (WGPUFilterMode)min_filter : WGPUFilterMode_Nearest;
    desc.mipmapFilter = mipmap_filter ? (WGPUMipmapFilterMode)mipmap_filter : WGPUMipmapFilterMode_Nearest;
    desc.lodMinClamp = lod_min_clamp;
    desc.lodMaxClamp = lod_max_clamp;
    // 0 (Undefined) means "no comparison function" — required for non-comparison samplers.
    desc.compare = compare ? (WGPUCompareFunction)compare : WGPUCompareFunction_Undefined;
    desc.maxAnisotropy = max_anisotropy ? max_anisotropy : 1;

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

// AUDIT FIX: previously supported only a single color attachment with hardcoded
// depth-stencil load/store/clear. Now supports multiple color attachments (MRT
// for deferred G-buffer), full depth-stencil attachment descriptor, occlusion
// query set, and pass timestamp writes.
//
// color_attachments: flat array, 11 u32 per attachment:
//   [0-1] view ptr (lo, hi), [2] depthSlice, [3-4] resolveTarget ptr (lo/hi, 0=NULL),
//   [5] loadOp, [6] storeOp, [7-10] clearValue (4x f32 bit patterns)
// depth_attachment: flat array of 10 u32, or NULL:
//   [0-1] view ptr (lo/hi, 0=no depth), [2] depthLoadOp, [3] depthStoreOp,
//   [4] depthClearValue (f32), [5] depthReadOnly, [6] stencilLoadOp,
//   [7] stencilStoreOp, [8] stencilClearValue, [9] stencilReadOnly
// occlusion_query_set: WGPUQuerySet ptr or NULL
// timestamp_writes: flat array of 4 u32 [qsLo, qsHi, beginIdx, endIdx], or NULL
void* wgpu_shim_begin_render_pass(
    void* encoder_ptr,
    uint32_t color_count,
    const uint32_t* color_attachments,
    const uint32_t* depth_attachment,
    void* occlusion_query_set,
    const uint32_t* timestamp_writes
) {
    // Build color attachments (max 8 MRT).
    WGPURenderPassColorAttachment colorAtts[8] = {0};
    uint32_t n = color_count < 8 ? color_count : 8;
    for (uint32_t i = 0; i < n; i++) {
        const uint32_t* a = color_attachments + i * 11;
        WGPURenderPassColorAttachment* ca = &colorAtts[i];
        ca->view = (WGPUTextureView)(uintptr_t)((uint64_t)a[1] << 32 | a[0]);
        ca->depthSlice = a[2] == 0xFFFFFFFF ? WGPU_DEPTH_SLICE_UNDEFINED : a[2];
        uint64_t rt = (uint64_t)a[4] << 32 | a[3];
        ca->resolveTarget = rt ? (WGPUTextureView)(uintptr_t)rt : NULL;
        ca->loadOp = (WGPULoadOp)a[5];
        ca->storeOp = (WGPUStoreOp)a[6];
        // clearValue: 4 floats stored as bit patterns
        memcpy(&ca->clearValue.r, &a[7], sizeof(float));
        memcpy(&ca->clearValue.g, &a[8], sizeof(float));
        memcpy(&ca->clearValue.b, &a[9], sizeof(float));
        memcpy(&ca->clearValue.a, &a[10], sizeof(float));
    }

    WGPURenderPassDescriptor desc = {0};
    desc.nextInChain = NULL;
    desc.label = (WGPUStringView){0};
    desc.colorAttachmentCount = n;
    desc.colorAttachments = colorAtts;
    desc.depthStencilAttachment = NULL;

    // Depth-stencil attachment (from flat array, no longer hardcoded).
    WGPURenderPassDepthStencilAttachment depthAtt = {0};
    if (depth_attachment) {
        uint64_t dv = (uint64_t)depth_attachment[1] << 32 | depth_attachment[0];
        if (dv) {
            depthAtt.view = (WGPUTextureView)(uintptr_t)dv;
            depthAtt.depthLoadOp = (WGPULoadOp)depth_attachment[2];
            depthAtt.depthStoreOp = (WGPUStoreOp)depth_attachment[3];
            memcpy(&depthAtt.depthClearValue, &depth_attachment[4], sizeof(float));
            depthAtt.depthReadOnly = depth_attachment[5] ? WGPU_TRUE : WGPU_FALSE;
            depthAtt.stencilLoadOp = (WGPULoadOp)depth_attachment[6];
            depthAtt.stencilStoreOp = (WGPUStoreOp)depth_attachment[7];
            depthAtt.stencilClearValue = depth_attachment[8];
            depthAtt.stencilReadOnly = depth_attachment[9] ? WGPU_TRUE : WGPU_FALSE;
            desc.depthStencilAttachment = &depthAtt;
        }
    }

    desc.occlusionQuerySet = (WGPUQuerySet)occlusion_query_set;

    // Pass timestamp writes.
    WGPUPassTimestampWrites tsWrites = {0};
    if (timestamp_writes) {
        uint64_t qs = (uint64_t)timestamp_writes[1] << 32 | timestamp_writes[0];
        tsWrites.querySet = (WGPUQuerySet)(uintptr_t)qs;
        tsWrites.beginningOfPassWriteIndex = timestamp_writes[2];
        tsWrites.endOfPassWriteIndex = timestamp_writes[3];
        desc.timestampWrites = &tsWrites;
    } else {
        desc.timestampWrites = NULL;
    }

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
// AUDIT FIX: previously hardcoded depth-stencil state (depthWriteEnabled=1,
// depthCompare=Less, stencilFront/Back.compare=Always) and supported only a
// single color attachment. This broke transparent pass (depthWriteEnabled=false),
// skybox (depthCompare=less-equal), and deferred G-buffer MRT (up to 4 targets).
//
// Now accepts:
//   color_target_count + color_targets: flat array, 9 u32 per target:
//     [format, hasBlend, colorSrc, colorDst, colorOp, alphaSrc, alphaDst, alphaOp, writeMask]
//   depth_stencil: flat array of 16 u32, or NULL for no depth-stencil:
//     [0]=depth_format(0=none), [1]=depthWriteEnabled(WGPUOptionalBool: 0/1/2),
//     [2]=depthCompare, [3-6]=stencilFront(compare,failOp,depthFailOp,passOp),
//     [7-10]=stencilBack(compare,failOp,depthFailOp,passOp),
//     [11]=stencilReadMask, [12]=stencilWriteMask,
//     [13]=depthBias(i32 bit pattern), [14]=depthBiasSlopeScale(f32 bit pattern),
//     [15]=depthBiasClamp(f32 bit pattern)
//   strip_index_format: WGPUIndexFormat for strip topologies (0=Undefined)
void* wgpu_shim_create_render_pipeline(
    void* device_ptr,
    void* vertex_shader_ptr, const char* vertex_entry,
    void* fragment_shader_ptr, const char* fragment_entry,
    uint32_t color_target_count, const uint32_t* color_targets,
    const uint32_t* depth_stencil,
    uint32_t topology, uint32_t strip_index_format,
    uint32_t sample_count,
    void* layout_ptr,
    uint32_t cull_mode, uint32_t front_face,
    uint32_t vertex_buffer_count, const uint32_t* vertex_buffer_data
) {
    // ── Vertex buffers (unchanged: walk flat data linearly) ──
    WGPUVertexBufferLayout vertexBufferLayouts[8] = {0};
    WGPUVertexAttribute* attrArrays[8] = {0};
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

    // ── Fragment state with multiple color targets ──
    WGPUFragmentState fragmentState = {0};
    // Allocate blend states and color targets on the stack (max 8 MRT).
    WGPUBlendState blendStates[8] = {0};
    WGPUColorTargetState colorTargets[8] = {0};
    if (fragment_shader_ptr && color_target_count > 0) {
        uint32_t n = color_target_count < 8 ? color_target_count : 8;
        for (uint32_t i = 0; i < n; i++) {
            const uint32_t* t = color_targets + i * 9;
            colorTargets[i].nextInChain = NULL;
            colorTargets[i].format = (WGPUTextureFormat)t[0];
            if (t[1]) { // hasBlend
                blendStates[i].color.srcFactor = (WGPUBlendFactor)t[2];
                blendStates[i].color.dstFactor = (WGPUBlendFactor)t[3];
                blendStates[i].color.operation = (WGPUBlendOperation)t[4];
                blendStates[i].alpha.srcFactor = (WGPUBlendFactor)t[5];
                blendStates[i].alpha.dstFactor = (WGPUBlendFactor)t[6];
                blendStates[i].alpha.operation = (WGPUBlendOperation)t[7];
                colorTargets[i].blend = &blendStates[i];
            } else {
                colorTargets[i].blend = NULL;
            }
            colorTargets[i].writeMask = t[8] ? (WGPUColorWriteMask)t[8] : WGPUColorWriteMask_All;
        }

        fragmentState.nextInChain = NULL;
        fragmentState.module = (WGPUShaderModule)fragment_shader_ptr;
        fragmentState.entryPoint = (WGPUStringView){ .data = fragment_entry, .length = strlen(fragment_entry) };
        fragmentState.constantCount = 0;
        fragmentState.constants = NULL;
        fragmentState.targetCount = n;
        fragmentState.targets = colorTargets;
    }

    // ── Primitive state (now with stripIndexFormat) ──
    WGPUPrimitiveState primitiveState = {0};
    primitiveState.nextInChain = NULL;
    primitiveState.topology = (WGPUPrimitiveTopology)topology;
    primitiveState.stripIndexFormat = (WGPUIndexFormat)strip_index_format;
    primitiveState.frontFace = front_face ? (WGPUFrontFace)front_face : WGPUFrontFace_CCW;
    primitiveState.cullMode = cull_mode ? (WGPUCullMode)cull_mode : WGPUCullMode_None;
    primitiveState.unclippedDepth = WGPU_FALSE;

    // ── Depth-stencil state (from flat array, no longer hardcoded) ──
    WGPUDepthStencilState depthStencilState = {0};
    if (depth_stencil && depth_stencil[0] != 0) {
        const uint32_t* ds = depth_stencil;
        depthStencilState.nextInChain = NULL;
        depthStencilState.format = (WGPUTextureFormat)ds[0];
        depthStencilState.depthWriteEnabled = ds[1] ? (WGPUOptionalBool)ds[1] : WGPUOptionalBool_Undefined;
        depthStencilState.depthCompare = ds[2] ? (WGPUCompareFunction)ds[2] : WGPUCompareFunction_Less;
        depthStencilState.stencilFront.compare = ds[3] ? (WGPUCompareFunction)ds[3] : WGPUCompareFunction_Always;
        depthStencilState.stencilFront.failOp = ds[4] ? (WGPUStencilOperation)ds[4] : WGPUStencilOperation_Keep;
        depthStencilState.stencilFront.depthFailOp = ds[5] ? (WGPUStencilOperation)ds[5] : WGPUStencilOperation_Keep;
        depthStencilState.stencilFront.passOp = ds[6] ? (WGPUStencilOperation)ds[6] : WGPUStencilOperation_Keep;
        depthStencilState.stencilBack.compare = ds[7] ? (WGPUCompareFunction)ds[7] : WGPUCompareFunction_Always;
        depthStencilState.stencilBack.failOp = ds[8] ? (WGPUStencilOperation)ds[8] : WGPUStencilOperation_Keep;
        depthStencilState.stencilBack.depthFailOp = ds[9] ? (WGPUStencilOperation)ds[9] : WGPUStencilOperation_Keep;
        depthStencilState.stencilBack.passOp = ds[10] ? (WGPUStencilOperation)ds[10] : WGPUStencilOperation_Keep;
        depthStencilState.stencilReadMask = ds[11] ? ds[11] : 0xFFFFFFFF;
        depthStencilState.stencilWriteMask = ds[12] ? ds[12] : 0xFFFFFFFF;
        // depth_bias (i32), depth_bias_slope_scale (f32), depth_bias_clamp (f32) stored as bit patterns
        int32_t depthBias;
        float depthBiasSlopeScale, depthBiasClamp;
        memcpy(&depthBias, &ds[13], sizeof(int32_t));
        memcpy(&depthBiasSlopeScale, &ds[14], sizeof(float));
        memcpy(&depthBiasClamp, &ds[15], sizeof(float));
        depthStencilState.depthBias = depthBias;
        depthStencilState.depthBiasSlopeScale = depthBiasSlopeScale;
        depthStencilState.depthBiasClamp = depthBiasClamp;
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
    desc.depthStencil = (depth_stencil && depth_stencil[0] != 0) ? &depthStencilState : NULL;
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
// AUDIT FIX: now accepts optional timestamp writes (flat 4 u32: qsLo, qsHi, beginIdx, endIdx, or NULL).
void* wgpu_shim_begin_compute_pass(void* encoder_ptr, const uint32_t* timestamp_writes) {
    WGPUComputePassDescriptor desc = {0};
    desc.nextInChain = NULL;
    desc.label = (WGPUStringView){0};
    WGPUPassTimestampWrites tsWrites = {0};
    if (timestamp_writes) {
        uint64_t qs = (uint64_t)timestamp_writes[1] << 32 | timestamp_writes[0];
        tsWrites.querySet = (WGPUQuerySet)(uintptr_t)qs;
        tsWrites.beginningOfPassWriteIndex = timestamp_writes[2];
        tsWrites.endOfPassWriteIndex = timestamp_writes[3];
        desc.timestampWrites = &tsWrites;
    } else {
        desc.timestampWrites = NULL;
    }
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

// ============================================================================
// AUDIT FIX: New functions implementing previously-silent no-op stubs.
// All functions below were no-ops in the JS wrapper, causing silent failures.
// ============================================================================

// ── Query sets ──
// AUDIT FIX: createQuerySet was a fake {destroy(){}} — GPUTimer silently no-op'd.
void* wgpu_shim_create_query_set(void* device_ptr, uint32_t type, uint32_t count) {
    WGPUQuerySetDescriptor desc = {0};
    desc.nextInChain = NULL;
    desc.label = (WGPUStringView){0};
    desc.type = (WGPUQueryType)type;
    desc.count = count;
    return (void*)wgpuDeviceCreateQuerySet((WGPUDevice)device_ptr, &desc);
}

void wgpu_shim_destroy_query_set(void* query_set_ptr) {
    wgpuQuerySetDestroy((WGPUQuerySet)query_set_ptr);
}

void wgpu_shim_release_query_set(void* ptr) { wgpuQuerySetRelease((WGPUQuerySet)ptr); }

// ── Timestamp + query resolve (command encoder level) ──
// AUDIT FIX: writeTimestamp/resolveQuerySet were no-ops — GPUTimer silently no-op'd.
// Note: pass-level writeTimestamp is not available in this wgpu-native version;
// the engine gates on "chromium-experimental-timestamp-query-inside-passes" which
// we don't report as a feature, so pass.writeTimestamp is never called.
void wgpu_shim_command_encoder_write_timestamp(void* encoder_ptr, void* query_set_ptr, uint32_t query_index) {
    wgpuCommandEncoderWriteTimestamp((WGPUCommandEncoder)encoder_ptr, (WGPUQuerySet)query_set_ptr, query_index);
}

void wgpu_shim_resolve_query_set(void* encoder_ptr, void* query_set_ptr, uint32_t first_query, uint32_t query_count, void* dest_buffer_ptr, uint64_t dest_offset) {
    wgpuCommandEncoderResolveQuerySet((WGPUCommandEncoder)encoder_ptr, (WGPUQuerySet)query_set_ptr, first_query, query_count, (WGPUBuffer)dest_buffer_ptr, dest_offset);
}

// ── Indirect draws ──
// AUDIT FIX: drawIndirect/drawIndexedIndirect were no-ops — GPU-driven rendering
// (indirect-draw-pass.ts) silently did nothing.
void wgpu_shim_render_pass_draw_indirect(void* pass_ptr, void* buffer_ptr, uint64_t offset) {
    wgpuRenderPassEncoderDrawIndirect((WGPURenderPassEncoder)pass_ptr, (WGPUBuffer)buffer_ptr, offset);
}

void wgpu_shim_render_pass_draw_indexed_indirect(void* pass_ptr, void* buffer_ptr, uint64_t offset) {
    wgpuRenderPassEncoderDrawIndexedIndirect((WGPURenderPassEncoder)pass_ptr, (WGPUBuffer)buffer_ptr, offset);
}

void wgpu_shim_compute_pass_dispatch_indirect(void* pass_ptr, void* buffer_ptr, uint64_t offset) {
    wgpuComputePassEncoderDispatchWorkgroupsIndirect((WGPUComputePassEncoder)pass_ptr, (WGPUBuffer)buffer_ptr, offset);
}

// ── Clear buffer ──
// AUDIT FIX: clearBuffer was a no-op.
void wgpu_shim_command_encoder_clear_buffer(void* encoder_ptr, void* buffer_ptr, uint64_t offset, uint64_t size) {
    wgpuCommandEncoderClearBuffer((WGPUCommandEncoder)encoder_ptr, (WGPUBuffer)buffer_ptr, offset, size);
}

// ── Blend constant + stencil reference ──
// AUDIT FIX: setBlendConstant/setStencilReference were no-ops — blend modes using
// "constant" factor and stencil operations were silently broken.
void wgpu_shim_render_pass_set_blend_constant(void* pass_ptr, float r, float g, float b, float a) {
    WGPUColor color = {0};
    color.r = r; color.g = g; color.b = b; color.a = a;
    wgpuRenderPassEncoderSetBlendConstant((WGPURenderPassEncoder)pass_ptr, &color);
}

void wgpu_shim_render_pass_set_stencil_reference(void* pass_ptr, uint32_t reference) {
    wgpuRenderPassEncoderSetStencilReference((WGPURenderPassEncoder)pass_ptr, reference);
}

// ── Occlusion queries ──
// AUDIT FIX: beginOcclusionQuery/endOcclusionQuery were no-ops.
void wgpu_shim_render_pass_begin_occlusion_query(void* pass_ptr, uint32_t query_index) {
    wgpuRenderPassEncoderBeginOcclusionQuery((WGPURenderPassEncoder)pass_ptr, query_index);
}

void wgpu_shim_render_pass_end_occlusion_query(void* pass_ptr) {
    wgpuRenderPassEncoderEndOcclusionQuery((WGPURenderPassEncoder)pass_ptr);
}

// ── Copy buffer-to-texture and texture-to-texture ──
// AUDIT FIX: copyBufferToTexture/copyTextureToTexture were no-ops — postfx
// afterimage/TAA (copyTextureToTexture) was silently broken.
void wgpu_shim_copy_buffer_to_texture(
    void* encoder_ptr,
    void* src_buffer_ptr, uint64_t src_offset, uint32_t src_bytes_per_row, uint32_t src_rows_per_image,
    void* dst_texture_ptr, uint32_t dst_mip_level, uint32_t dst_origin_x, uint32_t dst_origin_y, uint32_t dst_origin_z,
    uint32_t dst_aspect,
    uint32_t copy_w, uint32_t copy_h, uint32_t copy_d
) {
    WGPUTexelCopyBufferInfo src = {0};
    src.buffer = (WGPUBuffer)src_buffer_ptr;
    src.layout.offset = src_offset;
    src.layout.bytesPerRow = src_bytes_per_row;
    src.layout.rowsPerImage = src_rows_per_image;

    WGPUTexelCopyTextureInfo dst = {0};
    dst.texture = (WGPUTexture)dst_texture_ptr;
    dst.mipLevel = dst_mip_level;
    dst.origin.x = dst_origin_x;
    dst.origin.y = dst_origin_y;
    dst.origin.z = dst_origin_z;
    dst.aspect = dst_aspect ? (WGPUTextureAspect)dst_aspect : WGPUTextureAspect_All;

    WGPUExtent3D copySize = {0};
    copySize.width = copy_w;
    copySize.height = copy_h;
    copySize.depthOrArrayLayers = copy_d;

    wgpuCommandEncoderCopyBufferToTexture((WGPUCommandEncoder)encoder_ptr, &src, &dst, &copySize);
}

void wgpu_shim_copy_texture_to_texture(
    void* encoder_ptr,
    void* src_texture_ptr, uint32_t src_mip_level, uint32_t src_origin_x, uint32_t src_origin_y, uint32_t src_origin_z, uint32_t src_aspect,
    void* dst_texture_ptr, uint32_t dst_mip_level, uint32_t dst_origin_x, uint32_t dst_origin_y, uint32_t dst_origin_z, uint32_t dst_aspect,
    uint32_t copy_w, uint32_t copy_h, uint32_t copy_d
) {
    WGPUTexelCopyTextureInfo src = {0};
    src.texture = (WGPUTexture)src_texture_ptr;
    src.mipLevel = src_mip_level;
    src.origin.x = src_origin_x;
    src.origin.y = src_origin_y;
    src.origin.z = src_origin_z;
    src.aspect = src_aspect ? (WGPUTextureAspect)src_aspect : WGPUTextureAspect_All;

    WGPUTexelCopyTextureInfo dst = {0};
    dst.texture = (WGPUTexture)dst_texture_ptr;
    dst.mipLevel = dst_mip_level;
    dst.origin.x = dst_origin_x;
    dst.origin.y = dst_origin_y;
    dst.origin.z = dst_origin_z;
    dst.aspect = dst_aspect ? (WGPUTextureAspect)dst_aspect : WGPUTextureAspect_All;

    WGPUExtent3D copySize = {0};
    copySize.width = copy_w;
    copySize.height = copy_h;
    copySize.depthOrArrayLayers = copy_d;

    wgpuCommandEncoderCopyTextureToTexture((WGPUCommandEncoder)encoder_ptr, &src, &dst, &copySize);
}

// ── Debug groups and markers ──
// AUDIT FIX: all debug group/marker methods were no-ops. Now wired through.
void wgpu_shim_render_pass_push_debug_group(void* pass_ptr, const char* label) {
    wgpuRenderPassEncoderPushDebugGroup((WGPURenderPassEncoder)pass_ptr, (WGPUStringView){ .data = label, .length = label ? strlen(label) : 0 });
}
void wgpu_shim_render_pass_pop_debug_group(void* pass_ptr) {
    wgpuRenderPassEncoderPopDebugGroup((WGPURenderPassEncoder)pass_ptr);
}
void wgpu_shim_render_pass_insert_debug_marker(void* pass_ptr, const char* label) {
    wgpuRenderPassEncoderInsertDebugMarker((WGPURenderPassEncoder)pass_ptr, (WGPUStringView){ .data = label, .length = label ? strlen(label) : 0 });
}
void wgpu_shim_compute_pass_push_debug_group(void* pass_ptr, const char* label) {
    wgpuComputePassEncoderPushDebugGroup((WGPUComputePassEncoder)pass_ptr, (WGPUStringView){ .data = label, .length = label ? strlen(label) : 0 });
}
void wgpu_shim_compute_pass_pop_debug_group(void* pass_ptr) {
    wgpuComputePassEncoderPopDebugGroup((WGPUComputePassEncoder)pass_ptr);
}
void wgpu_shim_compute_pass_insert_debug_marker(void* pass_ptr, const char* label) {
    wgpuComputePassEncoderInsertDebugMarker((WGPUComputePassEncoder)pass_ptr, (WGPUStringView){ .data = label, .length = label ? strlen(label) : 0 });
}
void wgpu_shim_command_encoder_push_debug_group(void* encoder_ptr, const char* label) {
    wgpuCommandEncoderPushDebugGroup((WGPUCommandEncoder)encoder_ptr, (WGPUStringView){ .data = label, .length = label ? strlen(label) : 0 });
}
void wgpu_shim_command_encoder_pop_debug_group(void* encoder_ptr) {
    wgpuCommandEncoderPopDebugGroup((WGPUCommandEncoder)encoder_ptr);
}
void wgpu_shim_command_encoder_insert_debug_marker(void* encoder_ptr, const char* label) {
    wgpuCommandEncoderInsertDebugMarker((WGPUCommandEncoder)encoder_ptr, (WGPUStringView){ .data = label, .length = label ? strlen(label) : 0 });
}

// ── Error scopes ──
// AUDIT FIX: pushErrorScope/popErrorScope were no-ops returning null.
// popErrorScope is async — we poll wgpuInstanceProcessEvents until the callback fires.
static int g_pop_error_complete = 0;
static WGPUErrorType g_pop_error_type = WGPUErrorType_NoError;
static char g_pop_error_msg[4096] = {0};

static void on_pop_error_scope(WGPUPopErrorScopeStatus status, WGPUErrorType type, WGPUStringView message, void* userdata1, void* userdata2) {
    g_pop_error_complete = 1;
    g_pop_error_type = type;
    if (message.data && message.length > 0) {
        size_t len = message.length < sizeof(g_pop_error_msg) - 1 ? message.length : sizeof(g_pop_error_msg) - 1;
        memcpy(g_pop_error_msg, message.data, len);
        g_pop_error_msg[len] = '\0';
    } else {
        g_pop_error_msg[0] = '\0';
    }
    (void)status;
}

void wgpu_shim_device_push_error_scope(void* device_ptr, uint32_t filter) {
    wgpuDevicePushErrorScope((WGPUDevice)device_ptr, (WGPUErrorFilter)filter);
}

// Returns the error type (1=NoError, 2=Validation, 3=OutOfMemory, 4=Internal, 5=Unknown).
// Copies the error message into out_msg (up to out_msg_size bytes). Returns 0 on failure.
uint32_t wgpu_shim_device_pop_error_scope(void* device_ptr, char* out_msg, int out_msg_size) {
    g_pop_error_complete = 0;
    g_pop_error_type = WGPUErrorType_NoError;
    g_pop_error_msg[0] = '\0';

    WGPUPopErrorScopeCallbackInfo callbackInfo = {0};
    callbackInfo.mode = WGPUCallbackMode_AllowProcessEvents;
    callbackInfo.callback = on_pop_error_scope;
    callbackInfo.userdata1 = NULL;
    callbackInfo.userdata2 = NULL;

    wgpuDevicePopErrorScope((WGPUDevice)device_ptr, callbackInfo);

    // Poll until the callback fires
    while (!g_pop_error_complete) {
        wgpuInstanceProcessEvents(g_instance);
    }

    if (out_msg && out_msg_size > 0) {
        strncpy(out_msg, g_pop_error_msg, out_msg_size - 1);
        out_msg[out_msg_size - 1] = '\0';
    }

    return (uint32_t)g_pop_error_type;
}

// ── Adapter/device limits and features ──
// AUDIT FIX: previously returned hardcoded desktop values. Now queries the real device.
// Copies the WGPULimits struct into out_buffer (caller must allocate sizeof(WGPULimits) bytes).
// Returns 0 on success, non-zero on failure.
int wgpu_shim_adapter_get_limits(void* adapter_ptr, void* out_buffer) {
    WGPULimits limits = WGPU_LIMITS_INIT;
    WGPUStatus status = wgpuAdapterGetLimits((WGPUAdapter)adapter_ptr, &limits);
    if (status != WGPUStatus_Success) return 1;
    memcpy(out_buffer, &limits, sizeof(WGPULimits));
    return 0;
}

int wgpu_shim_device_get_limits(void* device_ptr, void* out_buffer) {
    WGPULimits limits = WGPU_LIMITS_INIT;
    WGPUStatus status = wgpuDeviceGetLimits((WGPUDevice)device_ptr, &limits);
    if (status != WGPUStatus_Success) return 1;
    memcpy(out_buffer, &limits, sizeof(WGPULimits));
    return 0;
}

// Fills out_features (uint32_t array) with WGPUFeatureName enum values.
// Returns the feature count. If out_features is NULL, just returns the count.
uint32_t wgpu_shim_adapter_get_features(void* adapter_ptr, uint32_t* out_features, uint32_t max_count) {
    WGPUSupportedFeatures sf = {0};
    wgpuAdapterGetFeatures((WGPUAdapter)adapter_ptr, &sf);
    uint32_t count = sf.featureCount;
    if (out_features && max_count > 0) {
        uint32_t n = count < max_count ? count : max_count;
        for (uint32_t i = 0; i < n; i++) {
            out_features[i] = (uint32_t)sf.features[i];
        }
    }
    return count;
}

uint32_t wgpu_shim_device_get_features(void* device_ptr, uint32_t* out_features, uint32_t max_count) {
    WGPUSupportedFeatures sf = {0};
    wgpuDeviceGetFeatures((WGPUDevice)device_ptr, &sf);
    uint32_t count = sf.featureCount;
    if (out_features && max_count > 0) {
        uint32_t n = count < max_count ? count : max_count;
        for (uint32_t i = 0; i < n; i++) {
            out_features[i] = (uint32_t)sf.features[i];
        }
    }
    return count;
}

// ── Queue onSubmittedWorkDone ──
// AUDIT FIX: queue.onSubmittedWorkDone was missing. Async — polls until callback fires.
static int g_work_done_complete = 0;

static void on_work_done(WGPUQueueWorkDoneStatus status, WGPUStringView message, void* userdata1, void* userdata2) {
    g_work_done_complete = 1;
    (void)status; (void)message; (void)userdata1; (void)userdata2;
}

void wgpu_shim_queue_on_submitted_work_done(void* queue_ptr) {
    g_work_done_complete = 0;
    WGPUQueueWorkDoneCallbackInfo callbackInfo = {0};
    callbackInfo.mode = WGPUCallbackMode_AllowProcessEvents;
    callbackInfo.callback = on_work_done;
    callbackInfo.userdata1 = NULL;
    callbackInfo.userdata2 = NULL;
    wgpuQueueOnSubmittedWorkDone((WGPUQueue)queue_ptr, callbackInfo);
    while (!g_work_done_complete) {
        wgpuInstanceProcessEvents(g_instance);
    }
}
