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
    @location(3) material: f32,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) @interpolate(flat) color: vec3<f32>,
    @location(1) @interpolate(flat) normal: vec3<f32>,
    @location(2) view_dist: f32,
    @location(3) world_pos: vec3<f32>,
    @location(4) @interpolate(flat) material: f32,
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
    out.material = in.material;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let normal = normalize(in.normal);
    let sun_dir = normalize(vec3<f32>(0.5, 0.8, 0.3));
    let sun_color = vec3<f32>(1.0, 0.95, 0.8);
    let view_dir = normalize(scene.camera_pos - in.world_pos);

    // Material-based reflectivity / specular properties
    // 0=DeepUnderwater 1=ShallowUnderwater 2=Shoreline 3=Sand 4=Grass 5=Forest 6=Stone 7=Rock 8=Snow 9=Ash
    let mat = in.material;
    var reflectivity: f32;
    var spec_intensity: f32;
    var spec_power: f32;
    if (mat < 0.5)       { reflectivity = 0.40; spec_intensity = 0.30; spec_power = 32.0; }
    else if (mat < 1.5)  { reflectivity = 0.55; spec_intensity = 0.50; spec_power = 64.0; }
    else if (mat < 2.5)  { reflectivity = 0.65; spec_intensity = 0.60; spec_power = 64.0; }
    else if (mat < 3.5)  { reflectivity = 0.40; spec_intensity = 0.40; spec_power = 48.0; }
    else if (mat < 4.5)  { reflectivity = 0.25; spec_intensity = 0.15; spec_power = 16.0; }
    else if (mat < 5.5)  { reflectivity = 0.25; spec_intensity = 0.15; spec_power = 16.0; }
    else if (mat < 6.5)  { reflectivity = 0.35; spec_intensity = 0.35; spec_power = 32.0; }
    else if (mat < 7.5)  { reflectivity = 0.45; spec_intensity = 0.40; spec_power = 32.0; }
    else if (mat < 8.5)  { reflectivity = 0.80; spec_intensity = 0.80; spec_power = 128.0; }
    else                  { reflectivity = 0.50; spec_intensity = 0.30; spec_power = 32.0; }

    // Wrap-lighting diffuse with sun color
    let raw_diffuse = max(dot(normal, sun_dir), 0.0);
    let wrap = (raw_diffuse + 0.3) / 1.3;
    let diffuse = wrap * 0.85 + 0.15;
    let sun_diffuse = sun_color * diffuse * scene.light_intensity;

    // Hemisphere lighting: sky color from above, ground color from below
    let up = vec3<f32>(0.0, 1.0, 0.0);
    let hemi = (dot(normal, up) * 0.5 + 0.5) * 0.25;
    let hemi_color = mix(vec3<f32>(0.15, 0.12, 0.08), scene.sky_color, hemi);

    let lit_color = in.color * (sun_diffuse + hemi_color * 0.4);

    // Fresnel reflection: mix of sun and sky for visible low-poly reflections
    let ndotv = max(dot(view_dir, normal), 0.0);
    let fresnel = (pow(1.0 - ndotv, 3.0) * 0.7 + 0.2) * reflectivity;
    // Reflect environment: sun highlight where reflection aligns with sun, sky elsewhere
    let refl_dir = reflect(-view_dir, normal);
    let sun_refl = max(dot(refl_dir, sun_dir), 0.0);
    let env_color = mix(scene.sky_color, sun_color, pow(sun_refl, 8.0) * 0.8);
    let reflection = env_color * fresnel * 1.5;

    // Blinn-Phong specular — bright sun highlight
    let half_dir = normalize(view_dir + sun_dir);
    let spec = pow(max(dot(normal, half_dir), 0.0), spec_power) * spec_intensity * sun_color;

    // Rim lighting for low-poly edge definition
    let rim = pow(1.0 - ndotv, 2.0) * 0.12;

    var final_lit = lit_color + reflection + spec * scene.light_intensity * 2.0 + rim * scene.sky_color;

    // Bloom: add emissive boost to bright colors
    if (scene.bloom_enabled > 0.5) {
        let luminance = dot(final_lit, vec3<f32>(0.299, 0.587, 0.114));
        if (luminance > 0.6) {
            final_lit += final_lit * 0.3;
        }
    }

    // Distance-based exponential fog
    let fog_factor = 1.0 - exp(-in.view_dist * scene.fog_density);
    let final_color = mix(final_lit, scene.fog_color, clamp(fog_factor, 0.0, 1.0));

    return vec4<f32>(final_color, 1.0);
}

// ─── Water shader (low-poly flat-shaded with Fresnel sky reflection) ───

struct WaterVertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) color: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) world_pos: vec3<f32>,
    @location(3) view_dist: f32,
    @location(4) @interpolate(flat) material: f32,
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
    out.material = in.material;
    return out;
}

@fragment
fn fs_water(in: WaterVertexOutput) -> @location(0) vec4<f32> {
    let normal = normalize(in.normal);
    let view_dir = normalize(scene.camera_pos - in.world_pos);
    let sun_dir = normalize(vec3<f32>(0.5, 0.8, 0.3));
    let sun_color = vec3<f32>(1.0, 0.95, 0.8);

    // Fresnel: more reflection at grazing angles
    let ndotv = max(dot(view_dir, normal), 0.0);
    let fresnel = pow(1.0 - ndotv, 5.0);

    // Smooth wrap-lighting diffuse for natural water shading
    let raw_diffuse = max(dot(normal, sun_dir), 0.0);
    let diffuse = (raw_diffuse + 0.3) / 1.3 * 0.8 + 0.2;

    // Moderate water base brightness
    let water_base = in.color * 1.4;

    // Environment reflection: sun highlight where reflection aligns with sun
    let refl_dir = reflect(-view_dir, normal);
    let sun_refl = max(dot(refl_dir, sun_dir), 0.0);
    let env_color = mix(scene.sky_color, sun_color, pow(sun_refl, 8.0) * 0.8);

    // Sun specular highlight (Blinn-Phong) — tight sparkle on wave crests
    let half_dir = normalize(view_dir + sun_dir);
    var spec = pow(max(dot(normal, half_dir), 0.0), 100.0) * sun_color;
    if (scene.bloom_enabled > 0.5) {
        spec *= 2.5;
    }

    // Combine: smooth diffuse + Fresnel environment reflection + specular
    let lit = water_base * diffuse * scene.light_intensity;
    let reflected = lit + env_color * fresnel * 0.6;
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
