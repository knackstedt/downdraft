mod ui_overlay;
mod ipc;

use bytemuck::{Pod, Zeroable};
use std::sync::Arc;
use ul_next::event::MouseButton;
use wgpu::util::DeviceExt;
use winit::{
    application::ApplicationHandler,
    event::WindowEvent,
    event_loop::{ActiveEventLoop, EventLoop},
    window::{CursorGrabMode, Window, WindowId},
};

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Vertex {
    position: [f32; 3],
    normal: [f32; 3],
    color: [f32; 3],
    material: f32,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct CameraUniforms {
    view_proj: [[f32; 4]; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct ModelUniforms {
    model: [[f32; 4]; 4],
    color: [f32; 4],
    _padding: [f32; 48], // pad to 256 bytes for dynamic offset alignment
}

const MODEL_UNIFORM_SIZE: u64 = 256;
const MAX_MODEL_SLOTS: u64 = 128;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct SceneUniforms {
    fog_color: [f32; 3],
    fog_density: f32,
    light_intensity: f32,
    shadows_enabled: f32,
    bloom_enabled: f32,
    _pad0: f32,           // padding to align camera_pos at offset 32
    camera_pos: [f32; 3],
    _pad1: f32,
    sky_color: [f32; 3],
    _pad2: f32,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct UIVertex {
    position: [f32; 2],
    tex_coord: [f32; 2],
}

const UI_VERTICES: &[UIVertex] = &[
    UIVertex { position: [-1.0, -1.0], tex_coord: [0.0, 1.0] },
    UIVertex { position: [ 1.0, -1.0], tex_coord: [1.0, 1.0] },
    UIVertex { position: [-1.0,  1.0], tex_coord: [0.0, 0.0] },
    UIVertex { position: [ 1.0, -1.0], tex_coord: [1.0, 1.0] },
    UIVertex { position: [ 1.0,  1.0], tex_coord: [1.0, 0.0] },
    UIVertex { position: [-1.0,  1.0], tex_coord: [0.0, 0.0] },
];

fn generate_cube(size: f32) -> (Vec<Vertex>, Vec<u16>) {
    let s = size / 2.0;
    let faces: [([f32; 3], [[f32; 3]; 4]); 6] = [
        ([0.0, 1.0, 0.0], [[-s, s, -s], [s, s, -s], [s, s, s], [-s, s, s]]),
        ([0.0, -1.0, 0.0], [[-s, -s, -s], [-s, -s, s], [s, -s, s], [s, -s, -s]]),
        ([1.0, 0.0, 0.0], [[s, -s, -s], [s, -s, s], [s, s, s], [s, s, -s]]),
        ([-1.0, 0.0, 0.0], [[-s, -s, -s], [-s, s, -s], [-s, s, s], [-s, -s, s]]),
        ([0.0, 0.0, 1.0], [[-s, -s, s], [-s, s, s], [s, s, s], [s, -s, s]]),
        ([0.0, 0.0, -1.0], [[-s, -s, -s], [s, -s, -s], [s, s, -s], [-s, s, -s]]),
    ];
    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    for (normal, positions) in faces.iter() {
        let base = vertices.len() as u16;
        for pos in positions.iter() {
            vertices.push(Vertex { position: *pos, normal: *normal, color: [1.0, 1.0, 1.0], material: 0.0 });
        }
        indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }
    (vertices, indices)
}

fn add_box(
    vertices: &mut Vec<Vertex>,
    indices: &mut Vec<u16>,
    min: [f32; 3],
    max: [f32; 3],
) {
    let faces: [([f32; 3], [[f32; 3]; 4]); 6] = [
        // top
        ([0.0, 1.0, 0.0], [[min[0], max[1], min[2]], [max[0], max[1], min[2]], [max[0], max[1], max[2]], [min[0], max[1], max[2]]]),
        // bottom
        ([0.0, -1.0, 0.0], [[min[0], min[1], min[2]], [min[0], min[1], max[2]], [max[0], min[1], max[2]], [max[0], min[1], min[2]]]),
        // +x
        ([1.0, 0.0, 0.0], [[max[0], min[1], min[2]], [max[0], min[1], max[2]], [max[0], max[1], max[2]], [max[0], max[1], min[2]]]),
        // -x
        ([-1.0, 0.0, 0.0], [[min[0], min[1], min[2]], [min[0], max[1], min[2]], [min[0], max[1], max[2]], [min[0], min[1], max[2]]]),
        // +z
        ([0.0, 0.0, 1.0], [[min[0], min[1], max[2]], [min[0], max[1], max[2]], [max[0], max[1], max[2]], [max[0], min[1], max[2]]]),
        // -z
        ([0.0, 0.0, -1.0], [[min[0], min[1], min[2]], [max[0], min[1], min[2]], [max[0], max[1], min[2]], [min[0], max[1], min[2]]]),
    ];
    for (normal, positions) in faces.iter() {
        let base = vertices.len() as u16;
        for pos in positions.iter() {
            vertices.push(Vertex { position: *pos, normal: *normal, color: [1.0, 1.0, 1.0], material: 0.0 });
        }
        indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }
}

fn generate_humanoid() -> (Vec<Vertex>, Vec<u16>) {
    let mut vertices = Vec::new();
    let mut indices = Vec::new();

    // Legs (y: 0.0 to 0.8)
    add_box(&mut vertices, &mut indices, [-0.22, 0.0, -0.13], [0.0, 0.8, 0.13]);  // left leg
    add_box(&mut vertices, &mut indices, [0.0, 0.0, -0.13], [0.22, 0.8, 0.13]);   // right leg

    // Torso (y: 0.8 to 1.4)
    add_box(&mut vertices, &mut indices, [-0.25, 0.8, -0.15], [0.25, 1.4, 0.15]);

    // Arms (y: 0.85 to 1.4, beside torso)
    add_box(&mut vertices, &mut indices, [-0.43, 0.85, -0.1], [-0.25, 1.4, 0.1]);  // left arm
    add_box(&mut vertices, &mut indices, [0.25, 0.85, -0.1], [0.43, 1.4, 0.1]);    // right arm

    // Head (y: 1.4 to 1.75)
    add_box(&mut vertices, &mut indices, [-0.14, 1.4, -0.14], [0.14, 1.75, 0.14]);

    (vertices, indices)
}

fn generate_sphere(radius: f32, segments: usize, rings: usize) -> (Vec<Vertex>, Vec<u16>) {
    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    for y in 0..=rings {
        let phi = (y as f32 / rings as f32) * std::f32::consts::PI;
        for x in 0..=segments {
            let theta = (x as f32 / segments as f32) * std::f32::consts::TAU;
            let sin_phi = phi.sin();
            let px = radius * sin_phi * theta.cos();
            let py = radius * phi.cos();
            let pz = radius * sin_phi * theta.sin();
            vertices.push(Vertex {
                position: [px, py, pz],
                normal: [px / radius, py / radius, pz / radius],
                color: [1.0, 1.0, 1.0],
                material: 0.0,
            });
        }
    }
    for y in 0..rings {
        for x in 0..segments {
            let a = (y * (segments + 1) + x) as u16;
            let b = a + 1;
            let c = a + (segments + 1) as u16;
            let d = c + 1;
            indices.extend_from_slice(&[a, b, d, a, d, c]);
        }
    }
    (vertices, indices)
}

fn generate_plane(width: f32, depth: f32, segments: usize) -> (Vec<Vertex>, Vec<u16>) {
    let hw = width / 2.0;
    let hd = depth / 2.0;
    let sw = width / segments as f32;
    let sd = depth / segments as f32;
    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    for z in 0..=segments {
        for x in 0..=segments {
            let px = -hw + x as f32 * sw;
            let pz = -hd + z as f32 * sd;
            vertices.push(Vertex {
                position: [px, 0.0, pz],
                normal: [0.0, 1.0, 0.0],
                color: [1.0, 1.0, 1.0],
                material: 0.0,
            });
        }
    }
    for z in 0..segments {
        for x in 0..segments {
            let a = (z * (segments + 1) + x) as u16;
            let b = a + 1;
            let c = a + (segments + 1) as u16;
            let d = c + 1;
            indices.extend_from_slice(&[a, b, d, a, d, c]);
        }
    }
    (vertices, indices)
}

fn look_at(eye: [f32; 3], target: [f32; 3], up: [f32; 3]) -> [[f32; 4]; 4] {
    let f = normalize([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
    let s = normalize(cross(f, up));
    let u = cross(s, f);
    [
        [s[0], u[0], -f[0], 0.0],
        [s[1], u[1], -f[1], 0.0],
        [s[2], u[2], -f[2], 0.0],
        [-dot(s, eye), -dot(u, eye), dot(f, eye), 1.0],
    ]
}

fn perspective(fov_rad: f32, aspect: f32, near: f32, far: f32) -> [[f32; 4]; 4] {
    let f = 1.0 / (fov_rad / 2.0).tan();
    [
        [f / aspect, 0.0, 0.0, 0.0],
        [0.0, f, 0.0, 0.0],
        [0.0, 0.0, (far + near) / (near - far), -1.0],
        [0.0, 0.0, (2.0 * far * near) / (near - far), 0.0],
    ]
}

fn multiply_mat4(a: [[f32; 4]; 4], b: [[f32; 4]; 4]) -> [[f32; 4]; 4] {
    let mut result = [[0.0f32; 4]; 4];
    for i in 0..4 {
        for j in 0..4 {
            for k in 0..4 {
                result[i][j] += a[i][k] * b[k][j];
            }
        }
    }
    result
}

fn translation_matrix(x: f32, y: f32, z: f32) -> [[f32; 4]; 4] {
    [
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [x, y, z, 1.0],
    ]
}

fn scale_matrix(s: f32) -> [[f32; 4]; 4] {
    [
        [s, 0.0, 0.0, 0.0],
        [0.0, s, 0.0, 0.0],
        [0.0, 0.0, s, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ]
}

fn normalize(v: [f32; 3]) -> [f32; 3] {
    let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if len > 0.0 { [v[0] / len, v[1] / len, v[2] / len] } else { v }
}

fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

struct MeshBuffers {
    vertex_buffer: wgpu::Buffer,
    index_buffer: wgpu::Buffer,
    index_count: u32,
}

struct IslandMeshBuffer {
    vertex_buffer: wgpu::Buffer,
    index_buffer: wgpu::Buffer,
    index_count: u32,
    pos_x: f32,
    pos_z: f32,
}

struct IslandLODLevel {
    buffer: IslandMeshBuffer,
    lod_distance: f32,
}

struct IslandLODGroup {
    lod_levels: Vec<IslandLODLevel>, // sorted by lod_distance ascending
    pos_x: f32,
    pos_z: f32,
    mesh_type: u32, // 0 = terrain, 1 = water
}

struct Renderer {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    size: winit::dpi::PhysicalSize<u32>,
    render_pipeline: wgpu::RenderPipeline,
    water_pipeline: wgpu::RenderPipeline,
    wireframe_pipeline: wgpu::RenderPipeline,
    normals_pipeline: wgpu::RenderPipeline,
    depth_pipeline: wgpu::RenderPipeline,
    hitbox_pipeline: wgpu::RenderPipeline,
    ui_pipeline: wgpu::RenderPipeline,
    ui_vertex_buffer: wgpu::Buffer,
    camera_buffer: wgpu::Buffer,
    camera_bind_group: wgpu::BindGroup,
    scene_buffer: wgpu::Buffer,
    model_buffer: wgpu::Buffer,
    model_bind_group: wgpu::BindGroup,
    model_bind_group_layout: wgpu::BindGroupLayout,
    cube_mesh: MeshBuffers,
    sphere_mesh: MeshBuffers,
    plane_mesh: MeshBuffers,
    humanoid_mesh: MeshBuffers,
    water_vertex_buffer: wgpu::Buffer,
    water_vertex_count: u32,
    water_seqlock_misses: u32,
    island_lod_groups: Vec<IslandLODGroup>,
    depth_texture: wgpu::Texture,
    depth_texture_view: wgpu::TextureView,
    ui_texture: wgpu::Texture,
    ui_texture_view: wgpu::TextureView,
    ui_sampler: wgpu::Sampler,
    ui_bind_group: wgpu::BindGroup,
    ui_bind_group_layout: wgpu::BindGroupLayout,
    has_ui_content: bool,
    start_time: std::time::Instant,
    last_frame_time: std::time::Instant,
    frame_count: u32,
    fps: u32,
    ui: ui_overlay::UIOverlay,
    shm: Option<ipc::SharedMemory>,
    // Frame interpolation: store prev + current render data for smooth 360fps
    prev_render_data: Option<ipc::RenderData>,
    curr_render_data: Option<ipc::RenderData>,
    last_sim_update: std::time::Instant,
    sim_dt: std::time::Duration,
    last_render_seq: u32,
    last_water_seq: u32,
    ui_update_counter: u32,
    cached_debug_toggles: ui_overlay::DebugToggles,
}

impl Renderer {
    async fn new(window: Arc<Window>) -> Self {
        let size = window.inner_size();

        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends: wgpu::Backends::VULKAN,
            backend_options: wgpu::BackendOptions::default(),
            flags: wgpu::InstanceFlags::default(),
        });

        let surface = instance
            .create_surface(window.clone())
            .expect("Failed to create surface");

        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: Some(&surface),
                force_fallback_adapter: false,
            })
            .await
            .expect("Failed to find GPU adapter");

        println!("[renderer] Adapter: {}", adapter.get_info().name);

        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: None,
                required_features: wgpu::Features::POLYGON_MODE_LINE,
                required_limits: wgpu::Limits::default(),
                memory_hints: wgpu::MemoryHints::default(),
            }, None)
            .await
            .expect("Failed to request device");

        let surface_caps = surface.get_capabilities(&adapter);
        let surface_format = surface_caps
            .formats
            .iter()
            .copied()
            .find(|f| f.is_srgb())
            .unwrap_or(surface_caps.formats[0]);

        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format: surface_format,
            width: size.width.max(1),
            height: size.height.max(1),
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 2,
            alpha_mode: wgpu::CompositeAlphaMode::Opaque,
            view_formats: vec![],
        };
        surface.configure(&device, &config);

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shader.wgsl").into()),
        });

        // Generate meshes
        let (cube_verts, cube_indices) = generate_cube(1.0);
        let (sphere_verts, sphere_indices) = generate_sphere(1.0, 12, 8);
        let (plane_verts, plane_indices) = generate_plane(200.0, 200.0, 1);

        let create_mesh = |vertices: &[Vertex], indices: &[u16]| -> MeshBuffers {
            let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Vertex Buffer"),
                contents: bytemuck::cast_slice(vertices),
                usage: wgpu::BufferUsages::VERTEX,
            });
            let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Index Buffer"),
                contents: bytemuck::cast_slice(indices),
                usage: wgpu::BufferUsages::INDEX,
            });
            MeshBuffers {
                vertex_buffer,
                index_buffer,
                index_count: indices.len() as u32,
            }
        };

        let (humanoid_verts, humanoid_indices) = generate_humanoid();

        let cube_mesh = create_mesh(&cube_verts, &cube_indices);
        let sphere_mesh = create_mesh(&sphere_verts, &sphere_indices);
        let plane_mesh = create_mesh(&plane_verts, &plane_indices);
        let humanoid_mesh = create_mesh(&humanoid_verts, &humanoid_indices);

        // Dynamic water vertex buffer for chunked water mesh
        // 25 chunks, step=2, subdiv=3: 34*34 cells * 9 sub-quads * 6 verts = 62K per chunk
        // 25 * 62K = 1.56M, buffer = 1.75M * 36 bytes = 63MB
        let water_max_vertices = 1_750_000u32;
        let water_vertex_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Water Vertex Buffer"),
            size: (water_max_vertices * std::mem::size_of::<Vertex>() as u32) as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        // Camera uniform buffer (view_proj matrix)
        let camera_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Camera Buffer"),
            size: std::mem::size_of::<CameraUniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let camera_bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Camera Bind Group Layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });

        // Scene uniform buffer (fog color, fog density, light intensity)
        let scene_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Scene Buffer"),
            size: std::mem::size_of::<SceneUniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let camera_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Camera Bind Group"),
            layout: &camera_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: camera_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: scene_buffer.as_entire_binding(),
                },
            ],
        });

        // Model uniform buffer (per-entity model matrix + color, dynamic offset)
        let model_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Model Buffer"),
            size: MODEL_UNIFORM_SIZE * MAX_MODEL_SLOTS,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let model_bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Model Bind Group Layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: true,
                    min_binding_size: Some(std::num::NonZeroU64::new(std::mem::size_of::<ModelUniforms>() as u64).unwrap()),
                },
                count: None,
            }],
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Pipeline Layout"),
            bind_group_layouts: &[&camera_bind_group_layout, &model_bind_group_layout],
            push_constant_ranges: &[],
        });

        let model_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Model Bind Group"),
            layout: &model_bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                    buffer: &model_buffer,
                    offset: 0,
                    size: Some(std::num::NonZeroU64::new(std::mem::size_of::<ModelUniforms>() as u64).unwrap()),
                }),
            }],
        });

        let render_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Render Pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: std::mem::size_of::<Vertex>() as wgpu::BufferAddress,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &[
                        wgpu::VertexAttribute {
                            format: wgpu::VertexFormat::Float32x3,
                            offset: 0,
                            shader_location: 0,
                        },
                        wgpu::VertexAttribute {
                            format: wgpu::VertexFormat::Float32x3,
                            offset: std::mem::size_of::<[f32; 3]>() as wgpu::BufferAddress,
                            shader_location: 1,
                        },
                        wgpu::VertexAttribute {
                            format: wgpu::VertexFormat::Float32x3,
                            offset: std::mem::size_of::<[f32; 6]>() as wgpu::BufferAddress,
                            shader_location: 2,
                        },
                        wgpu::VertexAttribute {
                            format: wgpu::VertexFormat::Float32,
                            offset: std::mem::size_of::<[f32; 9]>() as wgpu::BufferAddress,
                            shader_location: 3,
                        },
                    ],
                }],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: surface_format,
                    blend: Some(wgpu::BlendState::REPLACE),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: None,
                unclipped_depth: false,
                polygon_mode: wgpu::PolygonMode::Fill,
                conservative: false,
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: wgpu::TextureFormat::Depth32Float,
                depth_write_enabled: true,
                depth_compare: wgpu::CompareFunction::Less,
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState::default(),
            }),
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        // Water pipeline: same layout + vertex format, uses vs_water/fs_water for Fresnel reflections
        let water_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Water Pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_water"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: std::mem::size_of::<Vertex>() as wgpu::BufferAddress,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &[
                        wgpu::VertexAttribute {
                            format: wgpu::VertexFormat::Float32x3,
                            offset: 0,
                            shader_location: 0,
                        },
                        wgpu::VertexAttribute {
                            format: wgpu::VertexFormat::Float32x3,
                            offset: std::mem::size_of::<[f32; 3]>() as wgpu::BufferAddress,
                            shader_location: 1,
                        },
                        wgpu::VertexAttribute {
                            format: wgpu::VertexFormat::Float32x3,
                            offset: std::mem::size_of::<[f32; 6]>() as wgpu::BufferAddress,
                            shader_location: 2,
                        },
                        wgpu::VertexAttribute {
                            format: wgpu::VertexFormat::Float32,
                            offset: std::mem::size_of::<[f32; 9]>() as wgpu::BufferAddress,
                            shader_location: 3,
                        },
                    ],
                }],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_water"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: surface_format,
                    blend: Some(wgpu::BlendState::REPLACE),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: None,
                unclipped_depth: false,
                polygon_mode: wgpu::PolygonMode::Fill,
                conservative: false,
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: wgpu::TextureFormat::Depth32Float,
                depth_write_enabled: true,
                depth_compare: wgpu::CompareFunction::Less,
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState::default(),
            }),
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        // Wireframe pipeline: same vertex layout, line topology, no lighting
        let wireframe_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Wireframe Pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: std::mem::size_of::<Vertex>() as wgpu::BufferAddress,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &[
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: 0, shader_location: 0 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: std::mem::size_of::<[f32; 3]>() as wgpu::BufferAddress, shader_location: 1 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: std::mem::size_of::<[f32; 6]>() as wgpu::BufferAddress, shader_location: 2 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32, offset: std::mem::size_of::<[f32; 9]>() as wgpu::BufferAddress, shader_location: 3 },
                    ],
                }],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: surface_format,
                    blend: Some(wgpu::BlendState::REPLACE),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: None,
                unclipped_depth: false,
                polygon_mode: wgpu::PolygonMode::Line,
                conservative: false,
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: wgpu::TextureFormat::Depth32Float,
                depth_write_enabled: true,
                depth_compare: wgpu::CompareFunction::Less,
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState::default(),
            }),
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        // Normals debug pipeline: visualizes normals as RGB
        let normals_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Normals Debug Pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: std::mem::size_of::<Vertex>() as wgpu::BufferAddress,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &[
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: 0, shader_location: 0 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: std::mem::size_of::<[f32; 3]>() as wgpu::BufferAddress, shader_location: 1 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: std::mem::size_of::<[f32; 6]>() as wgpu::BufferAddress, shader_location: 2 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32, offset: std::mem::size_of::<[f32; 9]>() as wgpu::BufferAddress, shader_location: 3 },
                    ],
                }],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_normals"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: surface_format,
                    blend: Some(wgpu::BlendState::REPLACE),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: None,
                unclipped_depth: false,
                polygon_mode: wgpu::PolygonMode::Fill,
                conservative: false,
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: wgpu::TextureFormat::Depth32Float,
                depth_write_enabled: true,
                depth_compare: wgpu::CompareFunction::Less,
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState::default(),
            }),
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        // Depth debug pipeline: visualizes depth as grayscale
        let depth_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Depth Debug Pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: std::mem::size_of::<Vertex>() as wgpu::BufferAddress,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &[
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: 0, shader_location: 0 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: std::mem::size_of::<[f32; 3]>() as wgpu::BufferAddress, shader_location: 1 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: std::mem::size_of::<[f32; 6]>() as wgpu::BufferAddress, shader_location: 2 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32, offset: std::mem::size_of::<[f32; 9]>() as wgpu::BufferAddress, shader_location: 3 },
                    ],
                }],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_depth"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: surface_format,
                    blend: Some(wgpu::BlendState::REPLACE),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: None,
                unclipped_depth: false,
                polygon_mode: wgpu::PolygonMode::Fill,
                conservative: false,
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: wgpu::TextureFormat::Depth32Float,
                depth_write_enabled: true,
                depth_compare: wgpu::CompareFunction::Less,
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState::default(),
            }),
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        // Hitbox overlay pipeline: wireframe with bright color, depth test LessEqual, no depth write
        let hitbox_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Hitbox Pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: std::mem::size_of::<Vertex>() as wgpu::BufferAddress,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &[
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: 0, shader_location: 0 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: std::mem::size_of::<[f32; 3]>() as wgpu::BufferAddress, shader_location: 1 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: std::mem::size_of::<[f32; 6]>() as wgpu::BufferAddress, shader_location: 2 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32, offset: std::mem::size_of::<[f32; 9]>() as wgpu::BufferAddress, shader_location: 3 },
                    ],
                }],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_hitbox"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: surface_format,
                    blend: Some(wgpu::BlendState::REPLACE),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: None,
                unclipped_depth: false,
                polygon_mode: wgpu::PolygonMode::Line,
                conservative: false,
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: wgpu::TextureFormat::Depth32Float,
                depth_write_enabled: false,
                depth_compare: wgpu::CompareFunction::Always,
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState::default(),
            }),
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        // Depth texture
        let depth_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Depth Texture"),
            size: wgpu::Extent3d { width: size.width.max(1), height: size.height.max(1), depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Depth32Float,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let depth_texture_view = depth_texture.create_view(&wgpu::TextureViewDescriptor::default());

        // UI overlay pipeline
        let ui_vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("UI Vertex Buffer"),
            contents: bytemuck::cast_slice(UI_VERTICES),
            usage: wgpu::BufferUsages::VERTEX,
        });

        let ui_bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("UI Bind Group Layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });

        let ui_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("UI Pipeline Layout"),
            bind_group_layouts: &[&ui_bind_group_layout],
            push_constant_ranges: &[],
        });

        let ui_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("UI Pipeline"),
            layout: Some(&ui_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_ui"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: std::mem::size_of::<UIVertex>() as wgpu::BufferAddress,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &[
                        wgpu::VertexAttribute {
                            format: wgpu::VertexFormat::Float32x2,
                            offset: 0,
                            shader_location: 0,
                        },
                        wgpu::VertexAttribute {
                            format: wgpu::VertexFormat::Float32x2,
                            offset: std::mem::size_of::<[f32; 2]>() as wgpu::BufferAddress,
                            shader_location: 1,
                        },
                    ],
                }],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_ui"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: surface_format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        let ui_width = size.width.max(1);
        let ui_height = size.height.max(1);
        let ui_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("UI Texture"),
            size: wgpu::Extent3d { width: ui_width, height: ui_height, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });

        let ui_texture_view = ui_texture.create_view(&wgpu::TextureViewDescriptor::default());

        let ui_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("UI Sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        let ui_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("UI Bind Group"),
            layout: &ui_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&ui_texture_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&ui_sampler),
                },
            ],
        });

        let ui = ui_overlay::UIOverlay::new(ui_width, ui_height)
            .expect("Failed to initialize UI overlay");

        // Create shared memory for IPC with Bun
        let shm = match ipc::SharedMemory::create() {
            Ok(s) => {
                s.print_path();
                Some(s)
            }
            Err(e) => {
                eprintln!("[renderer] Failed to create shared memory: {}", e);
                None
            }
        };

        // Clear UI texture to transparent
        let transparent = vec![0u8; (ui_width * ui_height * 4) as usize];
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &ui_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &transparent,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(ui_width * 4),
                rows_per_image: Some(ui_height),
            },
            wgpu::Extent3d { width: ui_width, height: ui_height, depth_or_array_layers: 1 },
        );

        Self {
            surface,
            device,
            queue,
            config,
            size,
            render_pipeline,
            water_pipeline,
            wireframe_pipeline,
            normals_pipeline,
            depth_pipeline,
            hitbox_pipeline,
            ui_pipeline,
            ui_vertex_buffer,
            camera_buffer,
            camera_bind_group,
            scene_buffer,
            model_buffer,
            model_bind_group,
            model_bind_group_layout,
            cube_mesh,
            sphere_mesh,
            plane_mesh,
            humanoid_mesh,
            water_vertex_buffer,
            water_vertex_count: 0,
            water_seqlock_misses: 0,
            island_lod_groups: Vec::new(),
            depth_texture,
            depth_texture_view,
            ui_texture,
            ui_texture_view,
            ui_sampler,
            ui_bind_group,
            ui_bind_group_layout,
            has_ui_content: false,
            start_time: std::time::Instant::now(),
            last_frame_time: std::time::Instant::now(),
            frame_count: 0,
            fps: 0,
            ui,
            shm,
            prev_render_data: None,
            curr_render_data: None,
            last_sim_update: std::time::Instant::now(),
            sim_dt: std::time::Duration::from_millis(16),
            last_render_seq: 0,
            last_water_seq: 0,
            ui_update_counter: 0,
            cached_debug_toggles: ui_overlay::DebugToggles {
                shadows: true,
                bloom: true,
                ..Default::default()
            },
        }
    }

    fn resize(&mut self, new_size: winit::dpi::PhysicalSize<u32>) {
        if new_size.width > 0 && new_size.height > 0 {
            self.size = new_size;
            self.config.width = new_size.width;
            self.config.height = new_size.height;
            self.surface.configure(&self.device, &self.config);

            // Recreate depth texture
            self.depth_texture = self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("Depth Texture"),
                size: wgpu::Extent3d { width: new_size.width, height: new_size.height, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Depth32Float,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                view_formats: &[],
            });
            self.depth_texture_view = self.depth_texture.create_view(&wgpu::TextureViewDescriptor::default());

            let ui_width = new_size.width;
            let ui_height = new_size.height;
            self.ui_texture = self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("UI Texture"),
                size: wgpu::Extent3d { width: ui_width, height: ui_height, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8UnormSrgb,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });
            self.ui_texture_view = self.ui_texture.create_view(&wgpu::TextureViewDescriptor::default());

            let ui_bind_group_layout = &self.ui_bind_group_layout;
            self.ui_bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("UI Bind Group"),
                layout: ui_bind_group_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&self.ui_texture_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(&self.ui_sampler),
                    },
                ],
            });

            self.ui.resize(ui_width, ui_height);
            println!("[renderer] UI resized to {}x{}", ui_width, ui_height);
            self.has_ui_content = false;

            // Clear new UI texture to transparent
            let transparent = vec![0u8; (ui_width * ui_height * 4) as usize];
            self.queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &self.ui_texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                &transparent,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(ui_width * 4),
                    rows_per_image: Some(ui_height),
                },
                wgpu::Extent3d { width: ui_width, height: ui_height, depth_or_array_layers: 1 },
            );
        }
    }

    /// Load island mesh data from shared memory into GPU buffers (called once after SHM connect)
    fn load_island_meshes(&mut self) {
        let meshes = if let Some(ref shm) = self.shm {
            shm.read_mesh_data()
        } else {
            Vec::new()
        };

        if meshes.is_empty() {
            return;
        }

        println!("[renderer] Loading {} island meshes from SHM", meshes.len());

        // Group meshes by (pos_x, pos_z, mesh_type) — meshes with the same position and type are LODs of the same island
        use std::collections::HashMap;
        let mut groups: HashMap<(u32, u32, u32), Vec<&ipc::IslandMesh>> = HashMap::new();
        for mesh in &meshes {
            // Quantize position to group LODs of the same island (they share exact pos)
            let key = (mesh.pos_x.to_bits(), mesh.pos_z.to_bits(), mesh.mesh_type);
            groups.entry(key).or_default().push(mesh);
        }

        for (_, group_meshes) in &groups {
            let pos_x = group_meshes[0].pos_x;
            let pos_z = group_meshes[0].pos_z;
            let mesh_type = group_meshes[0].mesh_type;

            let mut lod_levels = Vec::new();
            for mesh in group_meshes {
                // Convert flat f32 array to Vertex array
                let mut vertices = Vec::with_capacity(mesh.vertex_count as usize);
                for i in 0..(mesh.vertex_count as usize) {
                    let off = i * 10;
                    vertices.push(Vertex {
                        position: [mesh.vertices[off], mesh.vertices[off + 1], mesh.vertices[off + 2]],
                        normal: [mesh.vertices[off + 3], mesh.vertices[off + 4], mesh.vertices[off + 5]],
                        color: [mesh.vertices[off + 6], mesh.vertices[off + 7], mesh.vertices[off + 8]],
                        material: mesh.vertices[off + 9],
                    });
                }

                let vertex_buffer = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Island Vertex Buffer"),
                    contents: bytemuck::cast_slice(&vertices),
                    usage: wgpu::BufferUsages::VERTEX,
                });

                let index_buffer = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Island Index Buffer"),
                    contents: bytemuck::cast_slice(&mesh.indices),
                    usage: wgpu::BufferUsages::INDEX,
                });

                println!("[renderer] Island LOD {} mesh: {} verts, {} indices at ({:.1}, {:.1}) dist={:.0}",
                    mesh.lod_level, mesh.vertex_count, mesh.index_count, pos_x, pos_z, mesh.lod_distance);

                lod_levels.push(IslandLODLevel {
                    buffer: IslandMeshBuffer {
                        vertex_buffer,
                        index_buffer,
                        index_count: mesh.index_count,
                        pos_x,
                        pos_z,
                    },
                    lod_distance: mesh.lod_distance,
                });
            }

            // Sort by lod_distance ascending (closest detail first)
            lod_levels.sort_by(|a, b| a.lod_distance.partial_cmp(&b.lod_distance).unwrap_or(std::cmp::Ordering::Equal));

            self.island_lod_groups.push(IslandLODGroup {
                lod_levels,
                pos_x,
                pos_z,
                mesh_type,
            });
        }

        let total_verts: u32 = self.island_lod_groups.iter()
            .flat_map(|g| g.lod_levels.iter())
            .map(|l| l.buffer.index_count)
            .sum();
        println!("[renderer] {} island LOD groups loaded (total indices across all LODs: {})",
            self.island_lod_groups.len(), total_verts);
    }

    fn render(&mut self) -> Result<(), wgpu::SurfaceError> {
        // FPS counter (update every 500ms)
        self.frame_count += 1;
        let fps_elapsed = self.last_frame_time.elapsed();
        if fps_elapsed.as_millis() >= 500 {
            self.fps = (self.frame_count as u64 * 1000 / fps_elapsed.as_millis() as u64) as u32;
            self.frame_count = 0;
            self.last_frame_time = std::time::Instant::now();
            self.ui.update_fps(self.fps);
        }

        // Read render data from shared memory (with seqlock value)
        let (new_render_data, new_seq) = if let Some(ref shm) = self.shm {
            match shm.read_render_data_with_seq() {
                Some((data, seq)) => (Some(data), seq),
                None => (None, self.last_render_seq),
            }
        } else {
            (None, self.last_render_seq)
        };

        // Detect if Bun wrote a new sim frame by comparing seqlock values
        let sim_changed = new_seq != self.last_render_seq && new_render_data.is_some();

        if sim_changed {
            // Shift current -> previous, new -> current
            self.prev_render_data = self.curr_render_data.take();
            self.curr_render_data = new_render_data;
            self.last_sim_update = std::time::Instant::now();
            self.last_render_seq = new_seq;
        }

        // Compute interpolation alpha: how far between prev and curr we are
        let elapsed = self.last_sim_update.elapsed();
        let alpha = if self.prev_render_data.is_some() {
            (elapsed.as_secs_f32() / self.sim_dt.as_secs_f32()).min(1.0)
        } else {
            1.0 // No previous frame — snap to current
        };

        // Interpolate render data
        let interp_data = match (&self.prev_render_data, &self.curr_render_data) {
            (Some(prev), Some(curr)) => {
                let lerp = |a: f32, b: f32, t: f32| a + (b - a) * t;
                let lerp3 = |a: [f32; 3], b: [f32; 3], t: f32| [
                    lerp(a[0], b[0], t),
                    lerp(a[1], b[1], t),
                    lerp(a[2], b[2], t),
                ];

                // Interpolate camera
                let cam_pos = lerp3(prev.camera_pos, curr.camera_pos, alpha);
                let cam_target = lerp3(prev.camera_target, curr.camera_target, alpha);

                // Interpolate entities — match by index (entities are in same order each frame)
                let entities: Vec<ipc::RenderEntity> = curr.entities.iter().enumerate().map(|(i, c)| {
                    if let Some(p) = prev.entities.get(i) {
                        ipc::RenderEntity {
                            entity_type: c.entity_type,
                            x: lerp(p.x, c.x, alpha),
                            y: lerp(p.y, c.y, alpha),
                            z: lerp(p.z, c.z, alpha),
                            r: c.r, g: c.g, b: c.b,
                        }
                    } else {
                        *c
                    }
                }).collect();

                Some(ipc::RenderData { camera_pos: cam_pos, camera_target: cam_target, entities })
            }
            (None, Some(curr)) => Some(curr.clone()),
            _ => None,
        };

        // Determine camera position — use interpolated data if available, else default
        let (cam_pos, cam_target) = match &interp_data {
            Some(rd) => (rd.camera_pos, rd.camera_target),
            None => ([0.0, 15.0, 15.0], [0.0, 0.0, 0.0]),
        };
        let aspect = self.config.width as f32 / self.config.height as f32;
        let view = look_at(cam_pos, cam_target, [0.0, 1.0, 0.0]);
        let proj = perspective(60.0_f32.to_radians(), aspect, 0.1, 1000.0);
        let view_proj = multiply_mat4(view, proj);

        let camera_uniforms = CameraUniforms { view_proj };
        self.queue.write_buffer(&self.camera_buffer, 0, bytemuck::cast_slice(&[camera_uniforms]));

        // Poll debug toggles from UI (throttled — needed for scene uniforms and pipeline selection)
        self.ui_update_counter += 1;
        let should_update_ui = self.ui_update_counter >= 30;
        if should_update_ui {
            self.ui_update_counter = 0;
        }
        let debug_toggles = if should_update_ui {
            self.cached_debug_toggles = self.ui.poll_debug_toggles();
            self.cached_debug_toggles
        } else {
            self.cached_debug_toggles
        };

        // Read weather visual data from shared memory and write scene uniforms
        let weather = if let Some(ref shm) = self.shm {
            shm.read_weather_visual()
        } else {
            None
        };
        let (sky_color, water_color, fog_color, fog_density, light_intensity, weather_type, is_night) = match weather {
            Some(w) => (w.sky_color, w.water_color, w.fog_color, w.fog_density, w.light_intensity, w.weather_type, w.is_night),
            None => ([0.1, 0.3, 0.5], [0.1, 0.3, 0.6], [0.1, 0.3, 0.5], 0.002, 1.0, 0, false),
        };
        let scene_uniforms = SceneUniforms {
            fog_color,
            fog_density,
            light_intensity,
            shadows_enabled: if debug_toggles.shadows { 1.0 } else { 0.0 },
            bloom_enabled: if debug_toggles.bloom { 1.0 } else { 0.0 },
            _pad0: 0.0,
            camera_pos: [cam_pos[0], cam_pos[1], cam_pos[2]],
            _pad1: 0.0,
            sky_color: [sky_color[0], sky_color[1], sky_color[2]],
            _pad2: 0.0,
        };
        self.queue.write_buffer(&self.scene_buffer, 0, bytemuck::cast_slice(&[scene_uniforms]));

        // Update weather indicator overlay (throttled)
        if should_update_ui {
            let weather_name = match weather_type {
                0 => "Clear", 1 => "PartlyCloudy", 2 => "Overcast", 3 => "Rain",
                4 => "Storm", 5 => "Fog", 6 => "Eclipse", 7 => "FullMoon",
                8 => "HellStorm", 9 => "Snow", _ => "Unknown",
            };
            self.ui.update_weather(weather_name, sky_color[0], sky_color[1], sky_color[2], fog_density, light_intensity, is_night);
        }

        // Write telemetry to shared memory
        if let Some(ref mut shm) = self.shm {
            let frame_time_us = ((1000000.0 / self.fps.max(1) as f64) as u32).min(100000);
            let entity_count = interp_data.as_ref().map(|rd| rd.entities.len() as u32).unwrap_or(0);
            shm.write_telemetry(self.fps, frame_time_us, entity_count, 1);
        }

        // Poll for commands from Bun
        if let Some(ref mut shm) = self.shm {
            if let Some((cmd, payload)) = shm.read_command() {
                match cmd {
                    ipc::CommandType::Quit => {
                        println!("[renderer] Quit command received");
                        return Err(wgpu::SurfaceError::Lost);
                    }
                    ipc::CommandType::Pause => {
                        println!("[renderer] Pause command received");
                    }
                    ipc::CommandType::Resume => {
                        println!("[renderer] Resume command received");
                    }
                    ipc::CommandType::SetTimeScale => {
                        if payload.len() >= 4 {
                            let scale = f32::from_le_bytes(payload[0..4].try_into().unwrap());
                            println!("[renderer] SetTimeScale: {}", scale);
                        }
                    }
                    ipc::CommandType::Resize => {
                        if payload.len() >= 8 {
                            let w = u32::from_le_bytes(payload[0..4].try_into().unwrap());
                            let h = u32::from_le_bytes(payload[4..8].try_into().unwrap());
                            println!("[renderer] Resize: {}x{}", w, h);
                        }
                    }
                    ipc::CommandType::LoadScene => {
                        let scene = String::from_utf8_lossy(&payload);
                        println!("[renderer] LoadScene: {}", scene);
                    }
                    ipc::CommandType::None => {}
                }
            }
        }

        // Read game state from Bun and update death overlay UI (throttled)
        if should_update_ui {
            let (is_dead, cause, biome) = if let Some(ref shm) = self.shm {
                shm.read_game_state()
            } else {
                (false, String::new(), 0)
            };
            self.ui.update_game_state(is_dead, &cause);
            self.ui.update_status(biome);

            // Read inventory data from Bun and update inventory panel
            if let Some(ref shm) = self.shm {
                if let Some(inv_json) = shm.read_inventory() {
                    self.ui.update_inventory(&inv_json);
                }
            }
        }

        // Poll for respawn request from UI button click
        if self.ui.poll_respawn_request() {
            if let Some(ref mut shm) = self.shm {
                shm.write_respawn_request();
                println!("[renderer] Respawn request forwarded to Bun");
            }
        }

        // Poll for craft request from UI recipe click
        if let Some(recipe_id) = self.ui.poll_craft_request() {
            if let Some(ref mut shm) = self.shm {
                shm.write_craft_request(&recipe_id);
                println!("[renderer] Craft request forwarded to Bun: {}", recipe_id);
            }
        }

        // Update UI overlay
        if let Some((pixels, row_bytes, ui_height)) = self.ui.render() {
            self.has_ui_content = true;
            self.queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &self.ui_texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                &pixels,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(row_bytes),
                    rows_per_image: Some(ui_height),
                },
                wgpu::Extent3d {
                    width: self.ui.width(),
                    height: self.ui.height(),
                    depth_or_array_layers: 1,
                },
            );
        }

        let output = self.surface.get_current_texture()?;
        let view = output
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());

        // Write all model uniform data BEFORE encoding the render pass
        // (queue.write_buffer is async — data must be written before submit)
        let mut draw_calls: Vec<(&MeshBuffers, u32)> = Vec::new();

        // Slot 0: dynamic low-poly water mesh from heightfield
        {
            let model_uniforms = ModelUniforms {
                model: translation_matrix(0.0, 0.0, 0.0),
                color: [water_color[0], water_color[1], water_color[2], 1.0],
                _padding: [0.0; 48],
            };
            self.queue.write_buffer(&self.model_buffer, 0, bytemuck::cast_slice(&[model_uniforms]));

            // Read water heightfield from shared memory — only rebuild mesh when data changed
            let water_data = if let Some(ref shm) = self.shm {
                let current_seq = shm.read_water_seq();
                if current_seq == self.last_water_seq {
                    None // Data unchanged — skip rebuild, reuse existing GPU buffer
                } else if current_seq & 1 != 0 {
                    None // Write in progress — skip this frame
                } else {
                    let wd = shm.read_water_data();
                    if wd.is_some() {
                        self.last_water_seq = current_seq;
                    }
                    wd
                }
            } else {
                None
            };

            if let Some(wd) = water_data {
                let step = 2usize;
                let ps = wd.patch_size;
                let height_amp = 1.5_f32;
                let subdiv = 3usize; // 3x3 sub-quads per cell ≈ 10x triangle density

                // Build mesh from all active chunks. Each chunk has its own
                // fixed origin — vertices are placed at world coordinates so
                // chunks never move and the mesh never twitches.
                // Each physics grid cell is subdivided into subdiv×subdiv sub-quads
                // with bilinear interpolation for 10x rendering density.
                let mut water_verts: Vec<Vertex> = Vec::with_capacity(25 * 64 * 64 * subdiv * subdiv * 6);

                for chunk in &wd.chunks {
                    let grid = chunk.grid_size;
                    let ox = chunk.origin_x as f32;
                    let oz = chunk.origin_z as f32;
                    let heights = &chunk.heights;

                    let sample_h = |gx: usize, gz: usize| -> f32 {
                        let idx = gz * grid + gx;
                        if idx < heights.len() { heights[idx] } else { 0.0 }
                    };

                    for gz in (0..grid.saturating_sub(step)).step_by(step) {
                        for gx in (0..grid.saturating_sub(step)).step_by(step) {
                            let h00 = sample_h(gx, gz);
                            let h10 = sample_h(gx + step, gz);
                            let h01 = sample_h(gx, gz + step);
                            let h11 = sample_h(gx + step, gz + step);

                            // Skip quads where any corner is cut out (< -100)
                            if h00 < -100.0 || h10 < -100.0 || h01 < -100.0 || h11 < -100.0 {
                                continue;
                            }

                            let base_x = ox + gx as f32 * ps;
                            let base_z = oz + gz as f32 * ps;

                            // Bilinear interpolation for height at sub-grid positions
                            let interp_h = |fx: f32, fz: f32| -> f32 {
                                let h = h00 * (1.0 - fx) * (1.0 - fz)
                                      + h10 * fx * (1.0 - fz)
                                      + h01 * (1.0 - fx) * fz
                                      + h11 * fx * fz;
                                if h < -100.0 { -100.0 } else { h * height_amp }
                            };

                            let cell_size = ps * step as f32;

                            for sz in 0..subdiv {
                                for sx in 0..subdiv {
                                    let fx0 = sx as f32 / subdiv as f32;
                                    let fx1 = (sx + 1) as f32 / subdiv as f32;
                                    let fz0 = sz as f32 / subdiv as f32;
                                    let fz1 = (sz + 1) as f32 / subdiv as f32;

                                    let p00 = [base_x + fx0 * cell_size, interp_h(fx0, fz0), base_z + fz0 * cell_size];
                                    let p10 = [base_x + fx1 * cell_size, interp_h(fx1, fz0), base_z + fz0 * cell_size];
                                    let p01 = [base_x + fx0 * cell_size, interp_h(fx0, fz1), base_z + fz1 * cell_size];
                                    let p11 = [base_x + fx1 * cell_size, interp_h(fx1, fz1), base_z + fz1 * cell_size];

                                    // Triangle 1: p00, p10, p11
                                    let e1 = [p10[0] - p00[0], p10[1] - p00[1], p10[2] - p00[2]];
                                    let e2 = [p11[0] - p00[0], p11[1] - p00[1], p11[2] - p00[2]];
                                    let n1 = normalize(cross(e2, e1));
                                    water_verts.push(Vertex { position: p00, normal: n1, color: [1.0, 1.0, 1.0], material: 100.0 });
                                    water_verts.push(Vertex { position: p10, normal: n1, color: [1.0, 1.0, 1.0], material: 100.0 });
                                    water_verts.push(Vertex { position: p11, normal: n1, color: [1.0, 1.0, 1.0], material: 100.0 });

                                    // Triangle 2: p00, p11, p01
                                    let e3 = [p11[0] - p00[0], p11[1] - p00[1], p11[2] - p00[2]];
                                    let e4 = [p01[0] - p00[0], p01[1] - p00[1], p01[2] - p00[2]];
                                    let n2 = normalize(cross(e4, e3));
                                    water_verts.push(Vertex { position: p00, normal: n2, color: [1.0, 1.0, 1.0], material: 100.0 });
                                    water_verts.push(Vertex { position: p11, normal: n2, color: [1.0, 1.0, 1.0], material: 100.0 });
                                    water_verts.push(Vertex { position: p01, normal: n2, color: [1.0, 1.0, 1.0], material: 100.0 });
                                }
                            }
                        }
                    }
                }

                self.water_vertex_count = water_verts.len() as u32;
                if !water_verts.is_empty() {
                    let max_verts = 1_750_000usize;
                    if water_verts.len() > max_verts {
                        eprintln!("[water] BUFFER OVERFLOW! {} verts > {} max, truncating", water_verts.len(), max_verts);
                        self.queue.write_buffer(&self.water_vertex_buffer, 0, bytemuck::cast_slice(&water_verts[..max_verts]));
                        self.water_vertex_count = max_verts as u32;
                    } else {
                        self.queue.write_buffer(&self.water_vertex_buffer, 0, bytemuck::cast_slice(&water_verts));
                    }
                }
            }
        }

        // Entity slots 1..N
        let mut entity_slot_count: u64 = 1; // slot 0 = water plane
        if let Some(ref rd) = interp_data {
            for entity in rd.entities.iter() {
                if entity_slot_count >= MAX_MODEL_SLOTS {
                    break;
                }

                let (mesh, scale) = match entity.entity_type {
                    0 => (&self.humanoid_mesh, 1.0), // Player (humanoid)
                    1 => (&self.cube_mesh, 2.0),    // Ship
                    2 => (&self.sphere_mesh, 1.6),  // Shark
                    3 => (&self.sphere_mesh, 0.6),  // Fish
                    4 => (&self.cube_mesh, 0.4),    // Debris
                    5 => continue,                   // Water (already drawn as plane)
                    6 => continue,                   // Island (drawn as custom mesh below)
                    7 => (&self.cube_mesh, 0.5),    // Buildable (campfire, etc.)
                    8 => (&self.cube_mesh, 1.8),    // Pirate ship
                    9 => (&self.cube_mesh, 1.0),    // Port (marker)
                    10 => (&self.sphere_mesh, 0.5), // Animal
                    11 => (&self.sphere_mesh, 0.3), // Plant
                    12 => (&self.sphere_mesh, 0.4), // Pet
                    _ => continue,
                };

                let model_matrix = multiply_mat4(
                    scale_matrix(scale),
                    translation_matrix(entity.x, entity.y, entity.z),
                );
                let model_uniforms = ModelUniforms {
                    model: model_matrix,
                    color: [entity.r, entity.g, entity.b, 1.0],
                    _padding: [0.0; 48],
                };

                let offset = entity_slot_count * MODEL_UNIFORM_SIZE;
                self.queue.write_buffer(&self.model_buffer, offset, bytemuck::cast_slice(&[model_uniforms]));
                draw_calls.push((mesh, offset as u32));
                entity_slot_count += 1;
            }
        }

        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Render Encoder"),
        });

        // Pass 1: Render 3D scene (water plane + entities)
        {
            let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Render Pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: sky_color[0] as f64,
                            g: sky_color[1] as f64,
                            b: sky_color[2] as f64,
                            a: 1.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &self.depth_texture_view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.0),
                        store: wgpu::StoreOp::Store,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            render_pass.set_pipeline(&self.render_pipeline);
            render_pass.set_bind_group(0, &self.camera_bind_group, &[]);

            // Determine which pipeline to use for entities based on debug toggles
            let entity_pipeline = if debug_toggles.wireframe {
                &self.wireframe_pipeline
            } else if debug_toggles.normals {
                &self.normals_pipeline
            } else if debug_toggles.depth {
                &self.depth_pipeline
            } else {
                &self.render_pipeline
            };

            // Draw dynamic water mesh with dedicated water pipeline (Fresnel sky reflection)
            if self.water_vertex_count > 0 {
                if debug_toggles.wireframe {
                    render_pass.set_pipeline(&self.wireframe_pipeline);
                } else {
                    render_pass.set_pipeline(&self.water_pipeline);
                }
                render_pass.set_bind_group(1, &self.model_bind_group, &[0]);
                render_pass.set_vertex_buffer(0, self.water_vertex_buffer.slice(..));
                render_pass.draw(0..self.water_vertex_count, 0..1);
                render_pass.set_pipeline(entity_pipeline); // restore for entities
            }

            for (mesh, offset) in &draw_calls {
                render_pass.set_pipeline(entity_pipeline);
                render_pass.set_bind_group(1, &self.model_bind_group, &[*offset]);
                render_pass.set_vertex_buffer(0, mesh.vertex_buffer.slice(..));
                render_pass.set_index_buffer(mesh.index_buffer.slice(..), wgpu::IndexFormat::Uint16);
                render_pass.draw_indexed(0..mesh.index_count, 0, 0..1);
            }

            // Draw island meshes with distance-based LOD selection
            for (idx, group) in self.island_lod_groups.iter().enumerate() {
                // Compute horizontal distance from camera to island center
                let dx = cam_pos[0] - group.pos_x;
                let dz = cam_pos[2] - group.pos_z;
                let dist = (dx * dx + dz * dz).sqrt();

                // Select the highest-detail LOD whose distance threshold is met
                let selected = group.lod_levels.iter()
                    .rev()
                    .find(|lod| dist >= lod.lod_distance)
                    .unwrap_or(&group.lod_levels[0]);

                let slot = (entity_slot_count + idx as u64) * MODEL_UNIFORM_SIZE;
                let model_uniforms = ModelUniforms {
                    model: translation_matrix(group.pos_x, 0.0, group.pos_z),
                    color: if group.mesh_type == 1 {
                        [water_color[0], water_color[1], water_color[2], 1.0]
                    } else {
                        [1.0, 1.0, 1.0, 1.0]
                    },
                    _padding: [0.0; 48],
                };
                self.queue.write_buffer(&self.model_buffer, slot, bytemuck::cast_slice(&[model_uniforms]));

                render_pass.set_pipeline(if group.mesh_type == 1 {
                    &self.water_pipeline
                } else {
                    entity_pipeline
                });
                render_pass.set_bind_group(1, &self.model_bind_group, &[slot as u32]);
                render_pass.set_vertex_buffer(0, selected.buffer.vertex_buffer.slice(..));
                render_pass.set_index_buffer(selected.buffer.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
                render_pass.draw_indexed(0..selected.buffer.index_count, 0, 0..1);
            }
        }

        // Pass 1b: Hitbox overlay — wireframe outline of entity meshes on top of normal render
        if debug_toggles.hitboxes {
            let mut hitbox_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Hitbox Overlay Pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &self.depth_texture_view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Store,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            hitbox_pass.set_pipeline(&self.hitbox_pipeline);
            hitbox_pass.set_bind_group(0, &self.camera_bind_group, &[]);

            for (mesh, offset) in &draw_calls {
                hitbox_pass.set_bind_group(1, &self.model_bind_group, &[*offset]);
                hitbox_pass.set_vertex_buffer(0, mesh.vertex_buffer.slice(..));
                hitbox_pass.set_index_buffer(mesh.index_buffer.slice(..), wgpu::IndexFormat::Uint16);
                hitbox_pass.draw_indexed(0..mesh.index_count, 0, 0..1);
            }
        }

        // Pass 2: Render UI overlay on top (alpha blended)
        if self.has_ui_content {
            let mut ui_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("UI Pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            ui_pass.set_pipeline(&self.ui_pipeline);
            ui_pass.set_bind_group(0, &self.ui_bind_group, &[]);
            ui_pass.set_vertex_buffer(0, self.ui_vertex_buffer.slice(..));
            ui_pass.draw(0..6, 0..1);
        }

        self.queue.submit(std::iter::once(encoder.finish()));
        output.present();

        Ok(())
    }
}

struct App {
    window: Option<Arc<Window>>,
    renderer: Option<Renderer>,
    held_keys: u32,
    pressed_keys: u32,
    held_keys_ext: u32,
    pressed_keys_ext: u32,
    mouse_dx: f32,
    mouse_dy: f32,
    wheel: f32,
    cursor_pos: Option<(i32, i32)>,
    cursor_grabbed: bool,
    grab_locked: bool,
    warping: bool,
    frame_counter: u32,
}

impl App {
    fn new() -> Self {
        Self {
            window: None,
            renderer: None,
            held_keys: 0,
            pressed_keys: 0,
            held_keys_ext: 0,
            pressed_keys_ext: 0,
            mouse_dx: 0.0,
            mouse_dy: 0.0,
            wheel: 0.0,
            cursor_pos: None,
            cursor_grabbed: false,
            grab_locked: false,
            warping: false,
            frame_counter: 0,
        }
    }

    fn grab_cursor(&mut self) {
        if let Some(window) = &self.window {
            // Try Locked first (best for FPS — raw motion via DeviceEvent), then Confined
            let locked = window.set_cursor_grab(CursorGrabMode::Locked).is_ok();
            if !locked {
                let _ = window.set_cursor_grab(CursorGrabMode::Confined);
            }
            window.set_cursor_visible(false);
            self.cursor_grabbed = true;
            self.grab_locked = locked;
            self.warping = false;
            println!("[renderer] Cursor grabbed (locked={})", locked);
        }
    }

    fn release_cursor(&mut self) {
        if let Some(window) = &self.window {
            let _ = window.set_cursor_grab(CursorGrabMode::None);
            window.set_cursor_visible(true);
            self.cursor_grabbed = false;
            self.grab_locked = false;
            self.warping = false;
            println!("[renderer] Cursor released");
        }
    }

    fn cursor_center(&self) -> Option<(f64, f64)> {
        self.renderer.as_ref().map(|r| {
            (r.size.width as f64 / 2.0, r.size.height as f64 / 2.0)
        })
    }

    fn key_bit(key: &winit::keyboard::Key) -> Option<u32> {
        use winit::keyboard::Key;
        let s = match key {
            Key::Character(c) => c.to_lowercase(),
            Key::Named(named) => match named {
                winit::keyboard::NamedKey::Shift => "shift".to_string(),
                winit::keyboard::NamedKey::ArrowLeft => "arrowleft".to_string(),
                winit::keyboard::NamedKey::ArrowRight => "arrowright".to_string(),
                winit::keyboard::NamedKey::ArrowUp => "arrowup".to_string(),
                winit::keyboard::NamedKey::ArrowDown => "arrowdown".to_string(),
                winit::keyboard::NamedKey::Space => "space".to_string(),
                winit::keyboard::NamedKey::Control => "ctrl".to_string(),
                winit::keyboard::NamedKey::F5 => "f5".to_string(),
                _ => return None,
            },
            _ => return None,
        };
        match s.as_str() {
            "w" => Some(0), "a" => Some(1), "s" => Some(2), "d" => Some(3),
            "shift" => Some(4), "arrowleft" => Some(5), "arrowright" => Some(6),
            "arrowup" => Some(7), "arrowdown" => Some(8),
            "e" => Some(9), "q" => Some(10), "r" => Some(11),
            "f" => Some(12), "c" => Some(13), "b" => Some(14), "t" => Some(15),
            "g" => Some(16), "x" => Some(17), "v" => Some(18), "h" => Some(19),
            "j" => Some(20), "p" => Some(21), "y" => Some(22),
            "m" => Some(23), "space" => Some(24), "ctrl" => Some(25), "f5" => Some(26),
            "1" => Some(27), "2" => Some(28), "3" => Some(29), "4" => Some(30), "5" => Some(31),
            _ => None,
        }
    }

    fn key_bit_ext(physical_key: &winit::keyboard::PhysicalKey) -> Option<u32> {
        use winit::keyboard::KeyCode;
        let code = match physical_key {
            winit::keyboard::PhysicalKey::Code(c) => *c,
            _ => return None,
        };
        match code {
            KeyCode::Numpad0 => Some(0),
            KeyCode::Numpad1 => Some(1),
            KeyCode::Numpad2 => Some(2),
            KeyCode::Numpad3 => Some(3),
            KeyCode::Numpad4 => Some(4),
            KeyCode::Numpad5 => Some(5),
            KeyCode::Numpad6 => Some(6),
            KeyCode::Numpad7 => Some(7),
            KeyCode::Numpad8 => Some(8),
            KeyCode::Numpad9 => Some(9),
            KeyCode::NumpadDivide => Some(10),
            KeyCode::NumpadMultiply => Some(11),
            KeyCode::NumpadSubtract => Some(12),
            KeyCode::NumpadAdd => Some(13),
            KeyCode::KeyI => Some(14),
            _ => None,
        }
    }

    fn write_input_to_shm(&mut self) {
        if let Some(ref mut renderer) = self.renderer {
            if let Some(ref mut shm) = renderer.shm {
                let buf = shm.as_mut();
                let held_bytes = self.held_keys.to_le_bytes();
                buf[ipc::INPUT_OFFSET..ipc::INPUT_OFFSET+4].copy_from_slice(&held_bytes);
                // OR pressed key bits into SHM so they accumulate across renderer frames
                // until Bun reads and clears them. This prevents lost key presses when
                // the renderer runs faster than Bun (e.g. 144Hz vs 60Hz).
                let existing_pressed = u32::from_le_bytes(buf[ipc::INPUT_PRESSED_OFFSET..ipc::INPUT_PRESSED_OFFSET+4].try_into().unwrap());
                let pressed_bytes = (existing_pressed | self.pressed_keys).to_le_bytes();
                buf[ipc::INPUT_PRESSED_OFFSET..ipc::INPUT_PRESSED_OFFSET+4].copy_from_slice(&pressed_bytes);
                // Mouse data: ADD to existing SHM values so deltas accumulate
                // across multiple renderer frames until Bun reads and clears them.
                // This prevents lost deltas when renderer runs faster than Bun (e.g. 144Hz vs 60Hz).
                let existing_dx = f32::from_le_bytes(buf[ipc::INPUT_MOUSE_DX_OFFSET..ipc::INPUT_MOUSE_DX_OFFSET+4].try_into().unwrap());
                let existing_dy = f32::from_le_bytes(buf[ipc::INPUT_MOUSE_DY_OFFSET..ipc::INPUT_MOUSE_DY_OFFSET+4].try_into().unwrap());
                let existing_wheel = f32::from_le_bytes(buf[ipc::INPUT_WHEEL_OFFSET..ipc::INPUT_WHEEL_OFFSET+4].try_into().unwrap());
                let dx_bytes = (existing_dx + self.mouse_dx).to_le_bytes();
                let dy_bytes = (existing_dy + self.mouse_dy).to_le_bytes();
                let wheel_bytes = (existing_wheel + self.wheel).to_le_bytes();
                buf[ipc::INPUT_MOUSE_DX_OFFSET..ipc::INPUT_MOUSE_DX_OFFSET+4].copy_from_slice(&dx_bytes);
                buf[ipc::INPUT_MOUSE_DY_OFFSET..ipc::INPUT_MOUSE_DY_OFFSET+4].copy_from_slice(&dy_bytes);
                buf[ipc::INPUT_WHEEL_OFFSET..ipc::INPUT_WHEEL_OFFSET+4].copy_from_slice(&wheel_bytes);
                // Write extended key bits (numpad + inventory toggle)
                let held_ext_bytes = self.held_keys_ext.to_le_bytes();
                buf[ipc::INPUT_EXT_OFFSET..ipc::INPUT_EXT_OFFSET+4].copy_from_slice(&held_ext_bytes);
                let existing_pressed_ext = u32::from_le_bytes(buf[ipc::INPUT_PRESSED_EXT_OFFSET..ipc::INPUT_PRESSED_EXT_OFFSET+4].try_into().unwrap());
                let pressed_ext_bytes = (existing_pressed_ext | self.pressed_keys_ext).to_le_bytes();
                buf[ipc::INPUT_PRESSED_EXT_OFFSET..ipc::INPUT_PRESSED_EXT_OFFSET+4].copy_from_slice(&pressed_ext_bytes);
            }
        }
    }
}

impl ApplicationHandler for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        let window = Arc::new(
            event_loop
                .create_window(
                    Window::default_attributes()
                        .with_title("DownDraft Engine")
                        .with_inner_size(winit::dpi::PhysicalSize::new(1280, 720)),
                )
                .unwrap(),
        );
        self.window = Some(window.clone());

        let renderer = pollster::block_on(Renderer::new(window));
        self.renderer = Some(renderer);

        println!("[renderer] Window created and renderer initialized");
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        _window_id: WindowId,
        event: WindowEvent,
    ) {
        match event {
            WindowEvent::CloseRequested => {
                println!("[renderer] Close requested, exiting");
                self.release_cursor();
                event_loop.exit();
            }
            WindowEvent::Resized(physical_size) => {
                if let Some(renderer) = &mut self.renderer {
                    renderer.resize(physical_size);
                }
            }
            WindowEvent::KeyboardInput { event, .. } => {
                use winit::event::ElementState;
                // Release cursor on Escape
                if event.state == ElementState::Pressed {
                    if let winit::keyboard::Key::Named(winit::keyboard::NamedKey::Escape) = event.logical_key {
                        self.release_cursor();
                    }
                }
                // Check numpad (physical key) FIRST, then primary key map
                if let Some(bit) = Self::key_bit_ext(&event.physical_key) {
                    match event.state {
                        ElementState::Pressed => {
                            if (self.held_keys_ext & (1 << bit)) == 0 {
                                self.pressed_keys_ext |= 1 << bit;
                            }
                            self.held_keys_ext |= 1 << bit;
                        }
                        ElementState::Released => {
                            self.held_keys_ext &= !(1 << bit);
                        }
                    }
                } else if let Some(bit) = Self::key_bit(&event.logical_key) {
                    match event.state {
                        ElementState::Pressed => {
                            if (self.held_keys & (1 << bit)) == 0 {
                                self.pressed_keys |= 1 << bit;
                            }
                            self.held_keys |= 1 << bit;
                        }
                        ElementState::Released => {
                            self.held_keys &= !(1 << bit);
                        }
                    }
                }
            }
            WindowEvent::MouseWheel { delta, .. } => {
                use winit::event::MouseScrollDelta;
                let scroll_delta = match delta {
                    MouseScrollDelta::LineDelta(_, y) => y * 32.0,
                    MouseScrollDelta::PixelDelta(pos) => pos.y as f32,
                };
                self.wheel += scroll_delta;
                // Forward scroll to UI overlay for scrollable panels
                if let Some(renderer) = &self.renderer {
                    renderer.ui.fire_scroll_event(scroll_delta as i32);
                }
            }
            WindowEvent::Focused(focused) => {
                if !focused && self.cursor_grabbed {
                    self.release_cursor();
                }
            }
            WindowEvent::MouseInput { button: winit_btn, state, .. } => {
                use winit::event::{ElementState, MouseButton as WinitMouseButton};
                // Only handle left-click cursor grab when not already grabbed
                if state == ElementState::Pressed && winit_btn == WinitMouseButton::Left && !self.cursor_grabbed {
                    // Check if the click is over a UI element — if so, forward to UI instead of grabbing
                    if let (Some(renderer), Some(pos)) = (&self.renderer, self.cursor_pos) {
                        let over_ui = renderer.ui.is_point_over_ui(pos.0, pos.1);
                        if over_ui {
                            renderer.ui.fire_mouse_event(pos.0, pos.1, MouseButton::Left, true);
                            return;
                        }
                    }
                    // Not over UI — grab cursor for FPS mouse-look
                    self.grab_cursor();
                    return;
                }
                // Only forward mouse events to UI when cursor is not grabbed
                if !self.cursor_grabbed {
                    let button = match winit_btn {
                        WinitMouseButton::Left => MouseButton::Left,
                        WinitMouseButton::Middle => MouseButton::Middle,
                        WinitMouseButton::Right => MouseButton::Right,
                        _ => MouseButton::None,
                    };
                    let is_down = state == ElementState::Pressed;
                    if let (Some(renderer), Some(pos)) = (&self.renderer, self.cursor_pos) {
                        renderer.ui.fire_mouse_event(pos.0, pos.1, button, is_down);
                    }
                }
            }
            WindowEvent::CursorMoved { position, .. } => {
                // When cursor is grabbed in non-Locked mode (e.g. Wayland Confined),
                // compute mouse deltas from center and warp back for infinite movement
                if self.cursor_grabbed && !self.grab_locked {
                    if self.warping {
                        // Ignore synthetic CursorMoved from set_cursor_position
                        self.warping = false;
                        return;
                    }
                    if let Some((cx, cy)) = self.cursor_center() {
                        self.mouse_dx += (position.x - cx) as f32;
                        self.mouse_dy += (position.y - cy) as f32;
                        // Warp cursor back to center for infinite mouse movement
                        self.warping = true;
                        if let Some(window) = &self.window {
                            let _ = window.set_cursor_position(
                                winit::dpi::PhysicalPosition::new(cx, cy)
                            );
                        }
                    }
                    return;
                }
                // Normal cursor tracking for UI when not grabbed
                self.cursor_pos = Some((position.x as i32, position.y as i32));
                if let Some(renderer) = &self.renderer {
                    renderer.ui.fire_mouse_move(position.x as i32, position.y as i32);
                }
            }
            WindowEvent::RedrawRequested => {
                // Check if parent process (Bun) has exited — if so, shut down cleanly
                if !parent_process_alive() {
                    println!("[renderer] Parent process exited, shutting down");
                    self.release_cursor();
                    event_loop.exit();
                    return;
                }

                // Write accumulated input (keys + mouse deltas) to SHM for Bun to read,
                // then clear one-shot values for next frame
                self.write_input_to_shm();
                self.pressed_keys = 0;
                self.pressed_keys_ext = 0;
                self.mouse_dx = 0.0;
                self.mouse_dy = 0.0;
                self.wheel = 0.0;

                // Auto-release cursor when inventory panel is visible (throttled)
                self.frame_counter += 1;
                if self.cursor_grabbed && self.frame_counter % 30 == 0 {
                    if let Some(renderer) = &self.renderer {
                        if renderer.ui.is_inventory_visible() {
                            self.release_cursor();
                        }
                    }
                }

                if let Some(renderer) = &mut self.renderer {
                    // Try to load island meshes once (they're written by Bun after init)
                    if renderer.island_lod_groups.is_empty() {
                        renderer.load_island_meshes();
                    }

                    match renderer.render() {
                        Ok(_) => {}
                        Err(wgpu::SurfaceError::Lost) => {
                            eprintln!("[renderer] Surface lost, resizing...");
                            renderer.resize(renderer.size);
                        }
                        Err(wgpu::SurfaceError::OutOfMemory) => {
                            eprintln!("[renderer] Out of memory, exiting");
                            event_loop.exit();
                        }
                        Err(wgpu::SurfaceError::Timeout) => {
                            eprintln!("[renderer] Surface timeout (frame {})", renderer.frame_count);
                        }
                        Err(e) => {
                            eprintln!("[renderer] Render error: {:?} (frame {})", e, renderer.frame_count);
                        }
                    }
                }
                if let Some(window) = &self.window {
                    window.request_redraw();
                }
            }
            _ => {}
        }
    }

    fn device_event(&mut self, _event_loop: &ActiveEventLoop, _device_id: winit::event::DeviceId, event: winit::event::DeviceEvent) {
        // Raw mouse motion for FPS-style camera control (X11 with Locked grab)
        // On Wayland, DeviceEvent doesn't fire — CursorMoved handles deltas instead
        if self.cursor_grabbed && self.grab_locked {
            if let winit::event::DeviceEvent::MouseMotion { delta } = event {
                self.mouse_dx += delta.0 as f32;
                self.mouse_dy += delta.1 as f32;
            }
        }
    }
}

fn main() {
    println!("[renderer] DownDraft native renderer starting...");
    let event_loop = EventLoop::new().unwrap();
    event_loop.set_control_flow(winit::event_loop::ControlFlow::Wait);
    let mut app = App::new();
    event_loop.run_app(&mut app).unwrap();
}

/// Check if the parent process has exited (Linux: reparented to init PID 1).
/// This detects when Bun was killed (e.g. SIGKILL) without cleaning up the renderer.
fn parent_process_alive() -> bool {
    #[cfg(target_os = "linux")]
    {
        // Read /proc/self/stat to get ppid
        // Format: pid (comm) state ppid ...
        if let Ok(stat) = std::fs::read_to_string("/proc/self/stat") {
            if let Some(pos) = stat.rfind(')') {
                let rest = &stat[pos + 2..];
                let fields: Vec<&str> = rest.split_whitespace().collect();
                if fields.len() >= 2 {
                    let ppid: u32 = fields[1].parse().unwrap_or(0);
                    // ppid == 1 means reparented to init (parent died)
                    return ppid != 1;
                }
            }
        }
        // Can't determine — assume alive
        true
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}
