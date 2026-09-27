//! webgpu.h (v29) wire values → wgpu crate enum translation.
//!
//! Every inbound u32 is a webgpu.h enum value emitted by
//! src/gpu/enums.ts — the tables below are the only place that mapping lives.
//! Unknown values map to a safe default or are rejected with a log line,
//! matching the C shim's shim_valid_* behavior (wgpu panics on bad enums
//! internally, so the boundary validates).

#![allow(non_snake_case)]

use wgpu::*;

pub fn power_preference(v: u32) -> PowerPreference {
    match v {
        1 => PowerPreference::LowPower,
        2 => PowerPreference::HighPerformance,
        _ => PowerPreference::default(),
    }
}

/// WGPUFeatureName → wgpu::Features bit. Unknown → 0 (dropped, same as the C
/// side which passed the raw enum through — wgpu ignored unknown bits too).
pub fn feature(v: u32) -> Features {
    match v {
        2 => Features::DEPTH_CLIP_CONTROL,
        3 => Features::DEPTH32FLOAT_STENCIL8,
        4 => Features::TEXTURE_COMPRESSION_BC,
        5 => Features::TEXTURE_COMPRESSION_BC_SLICED_3D,
        6 => Features::TEXTURE_COMPRESSION_ETC2,
        7 => Features::TEXTURE_COMPRESSION_ASTC,
        8 => Features::TEXTURE_COMPRESSION_ASTC_SLICED_3D,
        9 => Features::TIMESTAMP_QUERY,
        10 => Features::INDIRECT_FIRST_INSTANCE,
        11 => Features::SHADER_F16,
        12 => Features::RG11B10UFLOAT_RENDERABLE,
        13 => Features::BGRA8UNORM_STORAGE,
        14 => Features::FLOAT32_FILTERABLE,
        15 => Features::FLOAT32_BLENDABLE,
        16 => Features::CLIP_DISTANCES,
        17 => Features::DUAL_SOURCE_BLENDING,
        18 => Features::SUBGROUP,
        // 19/20 (texture-formats-tier1/2) and 22 (texture-component-swizzle)
        // have no wgpu-29 Features counterpart — dropped, same as the C shim
        // passing unknown bits wgpu ignored.
        21 => Features::PRIMITIVE_INDEX,
        _ => Features::empty(),
    }
}

/// wgpu::Features → wire u32s (inverse of `feature`). Used by
/// adapter/device getFeatures.
pub fn features_to_wire(f: Features) -> Vec<u32> {
    let mut out = Vec::new();
    let map: &[(Features, u32)] = &[
        (Features::DEPTH_CLIP_CONTROL, 2),
        (Features::DEPTH32FLOAT_STENCIL8, 3),
        (Features::TEXTURE_COMPRESSION_BC, 4),
        (Features::TEXTURE_COMPRESSION_BC_SLICED_3D, 5),
        (Features::TEXTURE_COMPRESSION_ETC2, 6),
        (Features::TEXTURE_COMPRESSION_ASTC, 7),
        (Features::TEXTURE_COMPRESSION_ASTC_SLICED_3D, 8),
        (Features::TIMESTAMP_QUERY, 9),
        (Features::INDIRECT_FIRST_INSTANCE, 10),
        (Features::SHADER_F16, 11),
        (Features::RG11B10UFLOAT_RENDERABLE, 12),
        (Features::BGRA8UNORM_STORAGE, 13),
        (Features::FLOAT32_FILTERABLE, 14),
        (Features::FLOAT32_BLENDABLE, 15),
        (Features::CLIP_DISTANCES, 16),
        (Features::DUAL_SOURCE_BLENDING, 17),
        (Features::SUBGROUP, 18),
        (Features::PRIMITIVE_INDEX, 21),
    ];
    for (bit, wire) in map {
        if f.contains(*bit) {
            out.push(*wire);
        }
    }
    out
}

/// WGPUTextureFormat wire value → wgpu::TextureFormat.
/// Returns None for out-of-range — callers reject with a diagnostic, the same
/// place the C shim's shim_valid_texture_format did.
pub fn texture_format(v: u32) -> Option<TextureFormat> {
    use TextureFormat as T;
    Some(match v {
        1 => T::R8Unorm,
        2 => T::R8Snorm,
        3 => T::R8Uint,
        4 => T::R8Sint,
        5 => T::R16Unorm,
        6 => T::R16Snorm,
        7 => T::R16Uint,
        8 => T::R16Sint,
        9 => T::R16Float,
        10 => T::Rg8Unorm,
        11 => T::Rg8Snorm,
        12 => T::Rg8Uint,
        13 => T::Rg8Sint,
        14 => T::R32Float,
        15 => T::R32Uint,
        16 => T::R32Sint,
        17 => T::Rg16Unorm,
        18 => T::Rg16Snorm,
        19 => T::Rg16Uint,
        20 => T::Rg16Sint,
        21 => T::Rg16Float,
        22 => T::Rgba8Unorm,
        23 => T::Rgba8UnormSrgb,
        24 => T::Rgba8Snorm,
        25 => T::Rgba8Uint,
        26 => T::Rgba8Sint,
        27 => T::Bgra8Unorm,
        28 => T::Bgra8UnormSrgb,
        29 => T::Rgb10a2Uint,
        30 => T::Rgb10a2Unorm,
        31 => T::Rg11b10Ufloat,
        32 => T::Rgb9e5Ufloat,
        33 => T::Rg32Float,
        34 => T::Rg32Uint,
        35 => T::Rg32Sint,
        36 => T::Rgba16Unorm,
        37 => T::Rgba16Snorm,
        38 => T::Rgba16Uint,
        39 => T::Rgba16Sint,
        40 => T::Rgba16Float,
        41 => T::Rgba32Float,
        42 => T::Rgba32Uint,
        43 => T::Rgba32Sint,
        44 => T::Stencil8,
        45 => T::Depth16Unorm,
        46 => T::Depth24Plus,
        47 => T::Depth24PlusStencil8,
        48 => T::Depth32Float,
        49 => T::Depth32FloatStencil8,
        50 => T::Bc1RgbaUnorm,
        51 => T::Bc1RgbaUnormSrgb,
        52 => T::Bc2RgbaUnorm,
        53 => T::Bc2RgbaUnormSrgb,
        54 => T::Bc3RgbaUnorm,
        55 => T::Bc3RgbaUnormSrgb,
        56 => T::Bc4RUnorm,
        57 => T::Bc4RSnorm,
        58 => T::Bc5RgUnorm,
        59 => T::Bc5RgSnorm,
        60 => T::Bc6hRgbUfloat,
        61 => T::Bc6hRgbFloat,
        62 => T::Bc7RgbaUnorm,
        63 => T::Bc7RgbaUnormSrgb,
        64 => T::Etc2Rgb8Unorm,
        65 => T::Etc2Rgb8UnormSrgb,
        66 => T::Etc2Rgb8A1Unorm,
        67 => T::Etc2Rgb8A1UnormSrgb,
        68 => T::Etc2Rgba8Unorm,
        69 => T::Etc2Rgba8UnormSrgb,
        70 => T::EacR11Unorm,
        71 => T::EacR11Snorm,
        72 => T::EacRg11Unorm,
        73 => T::EacRg11Snorm,
        74 => T::Astc {
            block: AstcBlock::B4x4,
            channel: AstcChannel::Unorm,
        },
        75 => T::Astc {
            block: AstcBlock::B4x4,
            channel: AstcChannel::UnormSrgb,
        },
        76 => T::Astc {
            block: AstcBlock::B5x4,
            channel: AstcChannel::Unorm,
        },
        77 => T::Astc {
            block: AstcBlock::B5x4,
            channel: AstcChannel::UnormSrgb,
        },
        78 => T::Astc {
            block: AstcBlock::B5x5,
            channel: AstcChannel::Unorm,
        },
        79 => T::Astc {
            block: AstcBlock::B5x5,
            channel: AstcChannel::UnormSrgb,
        },
        80 => T::Astc {
            block: AstcBlock::B6x5,
            channel: AstcChannel::Unorm,
        },
        81 => T::Astc {
            block: AstcBlock::B6x5,
            channel: AstcChannel::UnormSrgb,
        },
        82 => T::Astc {
            block: AstcBlock::B6x6,
            channel: AstcChannel::Unorm,
        },
        83 => T::Astc {
            block: AstcBlock::B6x6,
            channel: AstcChannel::UnormSrgb,
        },
        84 => T::Astc {
            block: AstcBlock::B8x5,
            channel: AstcChannel::Unorm,
        },
        85 => T::Astc {
            block: AstcBlock::B8x5,
            channel: AstcChannel::UnormSrgb,
        },
        86 => T::Astc {
            block: AstcBlock::B8x6,
            channel: AstcChannel::Unorm,
        },
        87 => T::Astc {
            block: AstcBlock::B8x6,
            channel: AstcChannel::UnormSrgb,
        },
        88 => T::Astc {
            block: AstcBlock::B8x8,
            channel: AstcChannel::Unorm,
        },
        89 => T::Astc {
            block: AstcBlock::B8x8,
            channel: AstcChannel::UnormSrgb,
        },
        90 => T::Astc {
            block: AstcBlock::B10x5,
            channel: AstcChannel::Unorm,
        },
        91 => T::Astc {
            block: AstcBlock::B10x5,
            channel: AstcChannel::UnormSrgb,
        },
        92 => T::Astc {
            block: AstcBlock::B10x6,
            channel: AstcChannel::Unorm,
        },
        93 => T::Astc {
            block: AstcBlock::B10x6,
            channel: AstcChannel::UnormSrgb,
        },
        94 => T::Astc {
            block: AstcBlock::B10x8,
            channel: AstcChannel::Unorm,
        },
        95 => T::Astc {
            block: AstcBlock::B10x8,
            channel: AstcChannel::UnormSrgb,
        },
        96 => T::Astc {
            block: AstcBlock::B10x10,
            channel: AstcChannel::Unorm,
        },
        97 => T::Astc {
            block: AstcBlock::B10x10,
            channel: AstcChannel::UnormSrgb,
        },
        98 => T::Astc {
            block: AstcBlock::B12x10,
            channel: AstcChannel::Unorm,
        },
        99 => T::Astc {
            block: AstcBlock::B12x10,
            channel: AstcChannel::UnormSrgb,
        },
        100 => T::Astc {
            block: AstcBlock::B12x12,
            channel: AstcChannel::Unorm,
        },
        101 => T::Astc {
            block: AstcBlock::B12x12,
            channel: AstcChannel::UnormSrgb,
        },
        // wgpu.h native extensions.
        0x00030007 => T::NV12,
        0x00030008 => T::P010,
        _ => return None,
    })
}

pub fn texture_dimension(v: u32) -> TextureDimension {
    match v {
        1 => TextureDimension::D1,
        3 => TextureDimension::D3,
        _ => TextureDimension::D2, // 0 = Undefined → 2D, 2 = 2D
    }
}

pub fn texture_view_dimension(v: u32) -> TextureViewDimension {
    match v {
        1 => TextureViewDimension::D1,
        3 => TextureViewDimension::D2Array,
        4 => TextureViewDimension::Cube,
        5 => TextureViewDimension::CubeArray,
        6 => TextureViewDimension::D3,
        _ => TextureViewDimension::D2, // 0 = Undefined → 2D
    }
}

pub fn texture_aspect(v: u32) -> TextureAspect {
    match v {
        2 => TextureAspect::StencilOnly,
        3 => TextureAspect::DepthOnly,
        _ => TextureAspect::All,
    }
}

pub fn index_format(v: u32) -> IndexFormat {
    match v {
        2 => IndexFormat::Uint32,
        _ => IndexFormat::Uint16, // 0/1
    }
}

pub fn load_op(v: u32, clear: Color) -> LoadOp<Color> {
    match v {
        1 => LoadOp::Load,
        _ => LoadOp::Clear(clear), // 0/2 → Clear (C passed enum raw; Undefined behaved as Clear)
    }
}

pub fn depth_load_op(v: u32, clear: f32) -> LoadOp<f32> {
    match v {
        1 => LoadOp::Load,
        _ => LoadOp::Clear(clear),
    }
}

pub fn stencil_load_op(v: u32, clear: u32) -> LoadOp<u32> {
    match v {
        1 => LoadOp::Load,
        _ => LoadOp::Clear(clear),
    }
}

pub fn store_op(v: u32) -> StoreOp {
    match v {
        2 => StoreOp::Discard,
        _ => StoreOp::Store, // 0/1 → Store
    }
}

pub fn buffer_binding_type(v: u32) -> BufferBindingType {
    match v {
        3 => BufferBindingType::Storage { read_only: false },
        4 => BufferBindingType::Storage { read_only: true },
        _ => BufferBindingType::Uniform, // 2
    }
}

pub fn sampler_binding_type(v: u32) -> SamplerBindingType {
    match v {
        3 => SamplerBindingType::NonFiltering,
        4 => SamplerBindingType::Comparison,
        _ => SamplerBindingType::Filtering, // 2
    }
}

pub fn texture_sample_type(v: u32) -> TextureSampleType {
    match v {
        3 => TextureSampleType::Float { filterable: false },
        4 => TextureSampleType::Depth,
        5 => TextureSampleType::Sint,
        6 => TextureSampleType::Uint,
        _ => TextureSampleType::Float { filterable: true }, // 2
    }
}

pub fn storage_texture_access(v: u32) -> StorageTextureAccess {
    match v {
        3 => StorageTextureAccess::ReadOnly,
        4 => StorageTextureAccess::ReadWrite,
        _ => StorageTextureAccess::WriteOnly, // 2
    }
}

pub fn address_mode(v: u32) -> AddressMode {
    match v {
        2 => AddressMode::Repeat,
        3 => AddressMode::MirrorRepeat,
        _ => AddressMode::ClampToEdge, // 0/1
    }
}

pub fn filter_mode(v: u32) -> FilterMode {
    match v {
        2 => FilterMode::Linear,
        _ => FilterMode::Nearest, // 0/1
    }
}

pub fn mipmap_filter_mode(v: u32) -> MipmapFilterMode {
    match v {
        2 => MipmapFilterMode::Linear,
        _ => MipmapFilterMode::Nearest,
    }
}

pub fn compare_function(v: u32) -> CompareFunction {
    match v {
        1 => CompareFunction::Never,
        2 => CompareFunction::Less,
        3 => CompareFunction::Equal,
        4 => CompareFunction::LessEqual,
        5 => CompareFunction::Greater,
        6 => CompareFunction::NotEqual,
        7 => CompareFunction::GreaterEqual,
        _ => CompareFunction::Always, // 8
    }
}

/// Sampler compare: 0 = Undefined → no comparison function.
pub fn sampler_compare(v: u32) -> Option<CompareFunction> {
    if v == 0 {
        None
    } else {
        Some(compare_function(v))
    }
}

pub fn primitive_topology(v: u32) -> PrimitiveTopology {
    match v {
        1 => PrimitiveTopology::PointList,
        2 => PrimitiveTopology::LineList,
        3 => PrimitiveTopology::LineStrip,
        5 => PrimitiveTopology::TriangleStrip,
        _ => PrimitiveTopology::TriangleList, // 0/4
    }
}

/// Strip index format — only valid for strip topologies; 0/Undefined → None.
pub fn strip_index_format(v: u32) -> Option<IndexFormat> {
    match v {
        1 => Some(IndexFormat::Uint16),
        2 => Some(IndexFormat::Uint32),
        _ => None,
    }
}

pub fn front_face(v: u32) -> FrontFace {
    match v {
        2 => FrontFace::Cw,
        _ => FrontFace::Ccw, // 0/1
    }
}

pub fn cull_mode(v: u32) -> Option<Face> {
    match v {
        2 => Some(Face::Front),
        3 => Some(Face::Back),
        _ => None, // 0/1 = None
    }
}

pub fn vertex_format(v: u32) -> VertexFormat {
    use VertexFormat as V;
    match v {
        1 => V::Uint8,
        2 => V::Uint8x2,
        3 => V::Uint8x4,
        4 => V::Sint8,
        5 => V::Sint8x2,
        6 => V::Sint8x4,
        7 => V::Unorm8,
        8 => V::Unorm8x2,
        9 => V::Unorm8x4,
        10 => V::Snorm8,
        11 => V::Snorm8x2,
        12 => V::Snorm8x4,
        13 => V::Uint16,
        14 => V::Uint16x2,
        15 => V::Uint16x4,
        16 => V::Sint16,
        17 => V::Sint16x2,
        18 => V::Sint16x4,
        19 => V::Unorm16,
        20 => V::Unorm16x2,
        21 => V::Unorm16x4,
        22 => V::Snorm16,
        23 => V::Snorm16x2,
        24 => V::Snorm16x4,
        25 => V::Float16,
        26 => V::Float16x2,
        27 => V::Float16x4,
        28 => V::Float32,
        29 => V::Float32x2,
        30 => V::Float32x3,
        31 => V::Float32x4,
        32 => V::Uint32,
        33 => V::Uint32x2,
        34 => V::Uint32x3,
        35 => V::Uint32x4,
        36 => V::Sint32,
        37 => V::Sint32x2,
        38 => V::Sint32x3,
        39 => V::Sint32x4,
        40 => V::Unorm10_10_10_2,
        41 => V::Unorm8x4Bgra,
        _ => V::Float32, // unknown → float32 (C passed raw; wgpu would validate)
    }
}

pub fn blend_factor(v: u32) -> BlendFactor {
    use BlendFactor as B;
    match v {
        1 => B::Zero,
        2 => B::One,
        3 => B::Src,
        4 => B::OneMinusSrc,
        5 => B::SrcAlpha,
        6 => B::OneMinusSrcAlpha,
        7 => B::Dst,
        8 => B::OneMinusDst,
        9 => B::DstAlpha,
        10 => B::OneMinusDstAlpha,
        11 => B::SrcAlphaSaturated,
        12 => B::Constant,
        13 => B::OneMinusConstant,
        14 => B::Src1,
        15 => B::OneMinusSrc1,
        16 => B::Src1Alpha,
        17 => B::OneMinusSrc1Alpha,
        _ => B::One,
    }
}

pub fn blend_operation(v: u32) -> BlendOperation {
    use BlendOperation as B;
    match v {
        2 => B::Subtract,
        3 => B::ReverseSubtract,
        4 => B::Min,
        5 => B::Max,
        _ => B::Add, // 0/1
    }
}

pub fn stencil_operation(v: u32) -> StencilOperation {
    use StencilOperation as S;
    match v {
        2 => S::Zero,
        3 => S::Replace,
        4 => S::Invert,
        5 => S::IncrementClamp,
        6 => S::DecrementClamp,
        7 => S::IncrementWrap,
        8 => S::DecrementWrap,
        _ => S::Keep, // 0/1
    }
}

pub fn present_mode(v: u32) -> PresentMode {
    match v {
        2 => PresentMode::FifoRelaxed,
        3 => PresentMode::Immediate,
        4 => PresentMode::Mailbox,
        _ => PresentMode::Fifo, // 0/1
    }
}

pub fn query_type(v: u32) -> QueryType {
    match v {
        1 => QueryType::Occlusion,
        _ => QueryType::Timestamp, // 2
    }
}

pub fn error_filter(v: u32) -> ErrorFilter {
    match v {
        2 => ErrorFilter::OutOfMemory,
        3 => ErrorFilter::Internal,
        _ => ErrorFilter::Validation, // 1
    }
}

/// wgpu::Error → WGPUErrorType wire value (NoError=1, Validation=2,
/// OutOfMemory=3, Internal=4, Unknown=5).
pub fn error_type(e: &Error) -> u32 {
    match e {
        Error::OutOfMemory { .. } => 3,
        Error::Validation { .. } => 2,
        _ => 5,
    }
}

pub fn device_lost_reason(r: DeviceLostReason) -> u32 {
    match r {
        DeviceLostReason::Destroyed => 2,
        _ => 1, // Unknown / FailedCreation → 1 (C only ever saw 1/2 in practice)
    }
}

/// WGPUMapMode wire → MapMode.
pub fn map_mode(v: u32) -> MapMode {
    match v {
        2 => MapMode::Write,
        _ => MapMode::Read, // 1
    }
}

/// Serialize wgpu::Limits into the raw WGPULimits byte layout the TS side
/// reads: 8-byte nextInChain, then u32 slots in declaration order (u64 fields
/// occupy two slots). Index map mirrors limits.ts LIMIT_READ_ORDER.
pub fn write_limits(l: &Limits, out: &mut [u8]) {
    // out[0..8] stays zeroed (nextInChain).
    let mut u32s = [0u32; 36];
    let put64 = |slots: &mut [u32; 36], i: usize, v: u64| {
        slots[i] = (v & 0xFFFF_FFFF) as u32;
        slots[i + 1] = (v >> 32) as u32;
    };
    u32s[0] = l.max_texture_dimension_1d;
    u32s[1] = l.max_texture_dimension_2d;
    u32s[2] = l.max_texture_dimension_3d;
    u32s[3] = l.max_texture_array_layers;
    u32s[4] = l.max_bind_groups;
    // maxBindGroupsPlusVertexBuffers was removed from wgpu's Limits; report
    // max_bind_groups — the combined limit is equivalent in practice.
    u32s[5] = l.max_bind_groups;
    u32s[6] = l.max_bindings_per_bind_group;
    u32s[7] = l.max_dynamic_uniform_buffers_per_pipeline_layout;
    u32s[8] = l.max_dynamic_storage_buffers_per_pipeline_layout;
    u32s[9] = l.max_sampled_textures_per_shader_stage;
    u32s[10] = l.max_samplers_per_shader_stage;
    u32s[11] = l.max_storage_buffers_per_shader_stage;
    u32s[12] = l.max_storage_textures_per_shader_stage;
    u32s[13] = l.max_uniform_buffers_per_shader_stage;
    put64(&mut u32s, 14, l.max_uniform_buffer_binding_size);
    put64(&mut u32s, 16, l.max_storage_buffer_binding_size);
    u32s[18] = l.min_uniform_buffer_offset_alignment;
    u32s[19] = l.min_storage_buffer_offset_alignment;
    u32s[20] = l.max_vertex_buffers;
    // u32s[21] = padding before u64 maxBufferSize
    put64(&mut u32s, 22, l.max_buffer_size);
    u32s[24] = l.max_vertex_attributes;
    u32s[25] = l.max_vertex_buffer_array_stride;
    u32s[26] = l.max_inter_stage_shader_variables;
    u32s[27] = l.max_color_attachments;
    u32s[28] = l.max_color_attachment_bytes_per_sample;
    u32s[29] = l.max_compute_workgroup_storage_size;
    u32s[30] = l.max_compute_invocations_per_workgroup;
    u32s[31] = l.max_compute_workgroup_size_x;
    u32s[32] = l.max_compute_workgroup_size_y;
    u32s[33] = l.max_compute_workgroup_size_z;
    u32s[34] = l.max_compute_workgroups_per_dimension;
    u32s[35] = l.max_immediate_size;

    // Native-endian u32 slots after the 8-byte nextInChain — the same bytes a
    // memcpy of WGPULimits produced under the C shim.
    for (i, v) in u32s.iter().enumerate() {
        let dst = 8 + i * 4;
        if dst + 4 <= out.len() {
            out[dst..dst + 4].copy_from_slice(&v.to_ne_bytes());
        }
    }
}
