mod ui_overlay;
mod ipc;

use bytemuck::{Pod, Zeroable};
use std::sync::Arc;
use wgpu::util::DeviceExt;
use winit::{
    application::ApplicationHandler,
    event::WindowEvent,
    event_loop::{ActiveEventLoop, EventLoop},
    window::{Window, WindowId},
};

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Vertex {
    position: [f32; 3],
    normal: [f32; 3],
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
const MAX_MODEL_SLOTS: u64 = 64;

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
            vertices.push(Vertex { position: *pos, normal: *normal });
        }
        indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }
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

struct Renderer {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    size: winit::dpi::PhysicalSize<u32>,
    render_pipeline: wgpu::RenderPipeline,
    ui_pipeline: wgpu::RenderPipeline,
    ui_vertex_buffer: wgpu::Buffer,
    camera_buffer: wgpu::Buffer,
    camera_bind_group: wgpu::BindGroup,
    model_buffer: wgpu::Buffer,
    model_bind_group: wgpu::BindGroup,
    model_bind_group_layout: wgpu::BindGroupLayout,
    cube_mesh: MeshBuffers,
    sphere_mesh: MeshBuffers,
    plane_mesh: MeshBuffers,
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
    last_limit_time: std::time::Instant,
    frame_count: u32,
    fps: u32,
    ui: ui_overlay::UIOverlay,
    shm: Option<ipc::SharedMemory>,
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
                required_features: wgpu::Features::empty(),
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
            present_mode: wgpu::PresentMode::Immediate,
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

        let cube_mesh = create_mesh(&cube_verts, &cube_indices);
        let sphere_mesh = create_mesh(&sphere_verts, &sphere_indices);
        let plane_mesh = create_mesh(&plane_verts, &plane_indices);

        // Camera uniform buffer (view_proj matrix)
        let camera_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Camera Buffer"),
            size: std::mem::size_of::<CameraUniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let camera_bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Camera Bind Group Layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });

        let camera_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Camera Bind Group"),
            layout: &camera_bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: camera_buffer.as_entire_binding(),
            }],
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
            ui_pipeline,
            ui_vertex_buffer,
            camera_buffer,
            camera_bind_group,
            model_buffer,
            model_bind_group,
            model_bind_group_layout,
            cube_mesh,
            sphere_mesh,
            plane_mesh,
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
            last_limit_time: std::time::Instant::now(),
            frame_count: 0,
            fps: 0,
            ui,
            shm,
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

    fn render(&mut self) -> Result<(), wgpu::SurfaceError> {
        // Frame limiter: target 360fps (~2.78ms)
        let target_frame_time = std::time::Duration::from_micros(2778);
        let now = std::time::Instant::now();
        let elapsed_since_limit = now.duration_since(self.last_limit_time);
        if elapsed_since_limit < target_frame_time {
            std::thread::sleep(target_frame_time - elapsed_since_limit);
        }
        self.last_limit_time = std::time::Instant::now();

        // FPS counter (update every 500ms)
        self.frame_count += 1;
        let fps_elapsed = self.last_frame_time.elapsed();
        if fps_elapsed.as_millis() >= 500 {
            self.fps = (self.frame_count as u64 * 1000 / fps_elapsed.as_millis() as u64) as u32;
            self.frame_count = 0;
            self.last_frame_time = std::time::Instant::now();
            self.ui.update_fps(self.fps);
        }

        // Read render data from shared memory
        let render_data = if let Some(ref shm) = self.shm {
            shm.read_render_data()
        } else {
            None
        };

        // Determine camera position — use render data if available, else default
        let (cam_pos, cam_target) = match &render_data {
            Some(rd) => (rd.camera_pos, rd.camera_target),
            None => ([0.0, 15.0, 15.0], [0.0, 0.0, 0.0]),
        };

        let aspect = self.config.width as f32 / self.config.height as f32;
        let view = look_at(cam_pos, cam_target, [0.0, 1.0, 0.0]);
        let proj = perspective(60.0_f32.to_radians(), aspect, 0.1, 1000.0);
        let view_proj = multiply_mat4(view, proj);

        let camera_uniforms = CameraUniforms { view_proj };
        self.queue.write_buffer(&self.camera_buffer, 0, bytemuck::cast_slice(&[camera_uniforms]));

        // Write telemetry to shared memory
        if let Some(ref mut shm) = self.shm {
            let frame_time_us = (target_frame_time.as_micros() as u32).min(100000);
            let entity_count = render_data.as_ref().map(|rd| rd.entities.len() as u32).unwrap_or(0);
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

        // Slot 0: water plane
        {
            let model_uniforms = ModelUniforms {
                model: translation_matrix(0.0, 0.0, 0.0),
                color: [0.1, 0.3, 0.6, 1.0],
                _padding: [0.0; 48],
            };
            self.queue.write_buffer(&self.model_buffer, 0, bytemuck::cast_slice(&[model_uniforms]));
            draw_calls.push((&self.plane_mesh, 0));
        }

        // Entity slots 1..N
        if let Some(ref rd) = render_data {
            for (i, entity) in rd.entities.iter().enumerate() {
                if i >= (MAX_MODEL_SLOTS as usize - 1) {
                    break;
                }

                let (mesh, scale) = match entity.entity_type {
                    0 => (&self.cube_mesh, 1.0),    // Player
                    1 => (&self.cube_mesh, 2.0),    // Ship
                    2 => (&self.sphere_mesh, 1.6),  // Shark
                    3 => (&self.sphere_mesh, 0.6),  // Fish
                    4 => (&self.cube_mesh, 0.4),    // Debris
                    5 => continue,                   // Water (already drawn as plane)
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

                let offset = (i as u64 + 1) * MODEL_UNIFORM_SIZE;
                self.queue.write_buffer(&self.model_buffer, offset, bytemuck::cast_slice(&[model_uniforms]));
                draw_calls.push((mesh, offset as u32));
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
                            r: 0.1,
                            g: 0.3,
                            b: 0.5,
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

            for (mesh, offset) in &draw_calls {
                render_pass.set_bind_group(1, &self.model_bind_group, &[*offset]);
                render_pass.set_vertex_buffer(0, mesh.vertex_buffer.slice(..));
                render_pass.set_index_buffer(mesh.index_buffer.slice(..), wgpu::IndexFormat::Uint16);
                render_pass.draw_indexed(0..mesh.index_count, 0, 0..1);
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
}

impl App {
    fn new() -> Self {
        Self {
            window: None,
            renderer: None,
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
                event_loop.exit();
            }
            WindowEvent::Resized(physical_size) => {
                if let Some(renderer) = &mut self.renderer {
                    renderer.resize(physical_size);
                }
            }
            WindowEvent::RedrawRequested => {
                if let Some(renderer) = &mut self.renderer {
                    match renderer.render() {
                        Ok(_) => {}
                        Err(wgpu::SurfaceError::Lost) => {
                            renderer.resize(renderer.size);
                        }
                        Err(wgpu::SurfaceError::OutOfMemory) => {
                            eprintln!("[renderer] Out of memory, exiting");
                            event_loop.exit();
                        }
                        Err(e) => {
                            eprintln!("[renderer] Render error: {:?}", e);
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
}

fn main() {
    println!("[renderer] DownDraft native renderer starting...");
    let event_loop = EventLoop::new().unwrap();
    event_loop.set_control_flow(winit::event_loop::ControlFlow::Poll);
    let mut app = App::new();
    event_loop.run_app(&mut app).unwrap();
}
