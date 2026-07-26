struct CameraUniforms {
    view_proj: mat4x4<f32>,
};

struct ModelUniforms {
    model: mat4x4<f32>,
    color: vec4<f32>,
};

struct SceneUniforms {
    fog_color: vec3<f32>,       // offset 0
    fog_density: f32,            // offset 12
    light_intensity: f32,        // offset 16
    shadows_enabled: f32,        // offset 20
    bloom_enabled: f32,          // offset 24
    _pad0: f32,                  // offset 28
    camera_pos: vec3<f32>,      // offset 32 (16-aligned)
    _pad1: f32,                  // offset 44
    sky_color: vec3<f32>,       // offset 48 (16-aligned)
    _pad2: f32,                  // offset 60
};

@group(0) @binding(0)
var<uniform> camera: CameraUniforms;

@group(0) @binding(1)
var<uniform> scene: SceneUniforms;

@group(1) @binding(0)
var<uniform> model: ModelUniforms;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) color: vec3<f32>,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) @interpolate(flat) color: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) view_dist: f32,
    @location(3) world_pos: vec3<f32>,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    let world_pos = model.model * vec4<f32>(in.position, 1.0);
    out.clip_position = camera.view_proj * world_pos;
    out.color = in.color * model.color.rgb;
    out.normal = in.normal;
    out.view_dist = out.clip_position.w; // view-space distance for fog
    out.world_pos = world_pos.xyz;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let normal = normalize(in.normal);
    let light_dir = normalize(vec3<f32>(0.5, 0.8, 0.3));
    let diffuse = select(1.0, max(dot(normal, light_dir), 0.0) * 0.7 + 0.3, scene.shadows_enabled > 0.5);
    var lit_color = in.color * diffuse * scene.light_intensity;

    // Bloom: add emissive boost to bright colors
    if (scene.bloom_enabled > 0.5) {
        let luminance = dot(lit_color, vec3<f32>(0.299, 0.587, 0.114));
        if (luminance > 0.6) {
            lit_color += lit_color * 0.3;
        }
    }

    // Distance-based exponential fog
    let fog_factor = 1.0 - exp(-in.view_dist * scene.fog_density);
    let final_color = mix(lit_color, scene.fog_color, clamp(fog_factor, 0.0, 1.0));

    return vec4<f32>(final_color, 1.0);
}

// ─── Water shader (low-poly flat-shaded with Fresnel sky reflection) ───

struct WaterVertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) color: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) world_pos: vec3<f32>,
    @location(3) view_dist: f32,
};

@vertex
fn vs_water(in: VertexInput) -> WaterVertexOutput {
    var out: WaterVertexOutput;
    let world_pos = model.model * vec4<f32>(in.position, 1.0);
    out.clip_position = camera.view_proj * world_pos;
    out.color = in.color * model.color.rgb;
    out.normal = in.normal;
    out.world_pos = world_pos.xyz;
    out.view_dist = out.clip_position.w;
    return out;
}

@fragment
fn fs_water(in: WaterVertexOutput) -> @location(0) vec4<f32> {
    let normal = normalize(in.normal);
    let view_dir = normalize(scene.camera_pos - in.world_pos);

    // Fresnel: more sky reflection at grazing angles
    let ndotv = max(dot(view_dir, normal), 0.0);
    let fresnel = pow(1.0 - ndotv, 5.0);

    // Sun direction
    let sun_dir = normalize(vec3<f32>(0.5, 0.8, 0.3));

    // Cel-shaded diffuse: quantize into discrete bands for stark low-poly facets
    let raw_diffuse = max(dot(normal, sun_dir), 0.0);
    var diffuse: f32;
    if (raw_diffuse > 0.75) {
        diffuse = 1.0;
    } else if (raw_diffuse > 0.45) {
        diffuse = 0.75;
    } else if (raw_diffuse > 0.2) {
        diffuse = 0.55;
    } else {
        diffuse = 0.4;
    }

    // Brighten the base water color so facets are visible
    let water_base = in.color * 2.5;

    // Sun specular highlight (Blinn-Phong) — tight sparkle on wave crests
    let half_dir = normalize(view_dir + sun_dir);
    var spec = pow(max(dot(normal, half_dir), 0.0), 100.0);
    if (scene.bloom_enabled > 0.5) {
        spec *= 2.5;
    }

    // Combine: cel-shaded diffuse + ambient + Fresnel sky reflection + specular
    let lit = water_base * diffuse * scene.light_intensity;
    let reflected = mix(lit, scene.sky_color, fresnel * 0.5);
    let final_lit = reflected + spec * scene.light_intensity * 2.0;

    // Distance-based exponential fog (reduced for water so facets stay visible)
    let fog_factor = 1.0 - exp(-in.view_dist * scene.fog_density * 0.7);
    let final_color = mix(final_lit, scene.fog_color, clamp(fog_factor, 0.0, 1.0));

    return vec4<f32>(final_color, 1.0);
}

// UI overlay quad shader
struct UIVertexInput {
    @location(0) position: vec2<f32>,
    @location(1) tex_coord: vec2<f32>,
};

struct UIVertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) tex_coord: vec2<f32>,
};

@group(0) @binding(0)
var ui_texture: texture_2d<f32>;

@group(0) @binding(1)
var ui_sampler: sampler;

@vertex
fn vs_ui(in: UIVertexInput) -> UIVertexOutput {
    var out: UIVertexOutput;
    out.clip_position = vec4<f32>(in.position, 0.0, 1.0);
    out.tex_coord = in.tex_coord;
    return out;
}

@fragment
fn fs_ui(in: UIVertexOutput) -> @location(0) vec4<f32> {
    let color = textureSample(ui_texture, ui_sampler, in.tex_coord);
    return color;
}

// ─── Debug visualization shaders ───

@fragment
fn fs_normals(in: VertexOutput) -> @location(0) vec4<f32> {
    let n = normalize(in.normal);
    let viz = (n + vec3<f32>(1.0)) * 0.5;
    return vec4<f32>(viz, 1.0);
}

@fragment
fn fs_depth(in: VertexOutput) -> @location(0) vec4<f32> {
    let d = in.view_dist / 100.0;
    let v = clamp(1.0 - d, 0.0, 1.0);
    return vec4<f32>(v, v, v, 1.0);
}

@fragment
fn fs_hitbox(in: VertexOutput) -> @location(0) vec4<f32> {
    return vec4<f32>(0.0, 1.0, 0.5, 1.0);
}
