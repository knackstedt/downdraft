struct IslandUniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  time: f32,
  entityPos: vec3<f32>,
  entityScale: f32,
  entityRot: vec4<f32>,
  entityType: u32,
  entityFlags: u32,
  wetness: f32,
  _pad3: f32,
  sunDirIntensity: vec4<f32>,
  ambientParams: vec4<f32>,
  fogColor: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: IslandUniforms;

struct IslandVertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color: vec3<f32>,
};

struct IslandVertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color: vec3<f32>,
};

fn qrotate(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

@vertex
fn vs_main(input: IslandVertexInput) -> IslandVertexOutput {
  var output: IslandVertexOutput;
  let scaled = input.position * uniforms.entityScale;
  let rotated = qrotate(uniforms.entityRot, scaled);
  let worldPos = rotated + uniforms.entityPos;
  output.worldPos = worldPos;
  output.clipPos = uniforms.viewProj * vec4<f32>(worldPos, 1.0);
  output.normal = normalize(qrotate(uniforms.entityRot, input.normal));
  output.color = input.color;
  return output;
}

// --- Sand grain sparkle helpers ---
// 3D hash — wraps input to avoid float precision loss with large world positions.
// GPU sin() loses precision above ~10000, so we keep the dot product small.
fn hash23(p: vec3<f32>) -> f32 {
  let q = fract(p / 73.0) * 73.0;
  let h = dot(q, vec3<f32>(127.1, 311.7, 74.7)) +
          dot(q, vec3<f32>(269.5, 183.3, 246.1)) * 0.5 +
          dot(q, vec3<f32>(113.5, 271.9, 124.6)) * 0.25;
  return fract(sin(h) * 43758.5453);
}

// 3-component hash for per-cell jitter (breaks regular grid)
fn hash33(p: vec3<f32>) -> vec3<f32> {
  let q = fract(p / 73.0) * 73.0;
  return fract(sin(vec3<f32>(
    dot(q, vec3<f32>(127.1, 311.7, 74.7)),
    dot(q, vec3<f32>(269.5, 183.3, 246.1)),
    dot(q, vec3<f32>(113.5, 271.9, 124.6)),
  )) * vec3<f32>(43758.5453));
}

// Smooth trilinear-interpolated value noise — hashes 8 lattice corners and interpolates.
// Produces spatially coherent noise that stays stable under camera movement.
fn valueNoise3D(p: vec3<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);

  let c000 = hash23(i + vec3<f32>(0.0, 0.0, 0.0));
  let c100 = hash23(i + vec3<f32>(1.0, 0.0, 0.0));
  let c010 = hash23(i + vec3<f32>(0.0, 1.0, 0.0));
  let c110 = hash23(i + vec3<f32>(1.0, 1.0, 0.0));
  let c001 = hash23(i + vec3<f32>(0.0, 0.0, 1.0));
  let c101 = hash23(i + vec3<f32>(1.0, 0.0, 1.0));
  let c011 = hash23(i + vec3<f32>(0.0, 1.0, 1.0));
  let c111 = hash23(i + vec3<f32>(1.0, 1.0, 1.0));

  let x00 = mix(c000, c100, u.x);
  let x10 = mix(c010, c110, u.x);
  let x01 = mix(c001, c101, u.x);
  let x11 = mix(c011, c111, u.x);

  let y0 = mix(x00, x10, u.y);
  let y1 = mix(x01, x11, u.y);

  return mix(y0, y1, u.z);
}

// Fractal Brownian motion — sums multiple octaves of valueNoise3D for richer texture.
// Uses non-power-of-2 frequency lacunarity (2.3) to break up regular grid patterns.
fn fbm3D(p: vec3<f32>, octaves: u32) -> f32 {
  var value = 0.0;
  var amplitude = 0.5;
  var freq = 1.0;
  for (var i = 0u; i < octaves; i++) {
    value += amplitude * valueNoise3D(p * freq);
    freq *= 2.3;
    amplitude *= 0.5;
  }
  return value;
}

// Domain-warped fBm — distorts input coordinates with a low-frequency noise layer
// before sampling, creating irregular organic patterns that avoid uniform repetition.
fn fbm3DWarp(p: vec3<f32>, octaves: u32, warpScale: f32, warpStrength: f32) -> f32 {
  let warp = vec3<f32>(
    valueNoise3D(p * warpScale + vec3<f32>(0.0, 0.0, 0.0)),
    valueNoise3D(p * warpScale + vec3<f32>(11.3, 7.1, 3.7)),
    valueNoise3D(p * warpScale + vec3<f32>(5.9, 13.2, 21.7)),
  );
  return fbm3D(p + (warp - 0.5) * warpStrength, octaves);
}

// Perturb surface normal using gradient of smooth value noise.
// Samples noise at the fragment and at small offsets along tangent/bitangent,
// then tilts the normal based on the height gradient (proper bump mapping).
fn perturbNormal(N: vec3<f32>, worldPos: vec3<f32>, scale: f32, strength: f32) -> vec3<f32> {
  let up = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), abs(N.y) < 0.99);
  let T = normalize(cross(up, N));
  let B = normalize(cross(N, T));

  let eps = 0.5 / scale;
  let h0 = valueNoise3D(worldPos * scale);
  let hT = valueNoise3D((worldPos + T * eps) * scale);
  let hB = valueNoise3D((worldPos + B * eps) * scale);

  let gradT = (hT - h0) * strength;
  let gradB = (hB - h0) * strength;

  return normalize(N - T * gradT - B * gradB);
}

// Sand grain sparkle using smooth value noise for grain density.
// Multi-octave noise creates coherent bright/dark patches of sand grains,
// with a view-dependent specular glint modulated by the noise pattern.
fn sandSparkle(worldPos: vec3<f32>, N: vec3<f32>, V: vec3<f32>, L: vec3<f32>, sandMask: f32) -> vec3<f32> {
  let H = normalize(V + L);
  let NdotH = max(dot(N, H), 0.0);

  // Smooth grain density — domain-warped for irregular coherent patches
  let grainDensity = fbm3DWarp(worldPos * 40.0, 3u, 8.0, 2.0);

  // Sharp specular glint modulated by grain density (only bright grains glint)
  let glint = pow(NdotH, 120.0) * smoothstep(0.4, 0.7, grainDensity);

  // Broader soft sheen for finer grains
  let sheen = pow(NdotH, 20.0) * 0.15 * grainDensity;

  let sparkle = (glint * 0.6 + sheen) * sandMask;

  // Warm quartz-like tint
  return sparkle * vec3<f32>(1.0, 0.95, 0.85);
}

// PBR island lighting — derives metallic/roughness from vertex color material classification.
// Sand = rough matte with sparkle, vegetation = rough organic, rock = medium rough, shoreline = smooth/wet.
fn islandLighting(N: vec3<f32>, worldPos: vec3<f32>, baseColor: vec3<f32>) -> vec3<f32> {
  let sunDir = normalize(uniforms.sunDirIntensity.xyz);
  let sunIntensity = uniforms.sunDirIntensity.w;
  let ambientLevel = uniforms.ambientParams.x;

  // --- Classify material from vertex color ---
  let r = baseColor.r;
  let g = baseColor.g;
  let b = baseColor.b;

  let sandMask = smoothstep(0.60, 0.70, r);
  let vegMask = smoothstep(0.02, 0.08, g - r) * (1.0 - sandMask);
  let wetMask = (1.0 - sandMask) * (1.0 - vegMask) * smoothstep(0.05, 0.10, r - b);
  let rockMask = (1.0 - sandMask) * (1.0 - vegMask) * (1.0 - wetMask);

  // Wet sand zone — sand near waterline (worldPos.y ≈ 0) transitions to wet
  let wetSandZoneWidth = 0.02;
  let wetSandMask = sandMask * smoothstep(wetSandZoneWidth, 0.0, worldPos.y);

  // PBR material params from classification
  var roughness = mix(0.9, 0.75, sandMask);
  roughness = mix(roughness, 0.85, vegMask);
  roughness = mix(roughness, 0.15, wetMask);
  roughness = mix(roughness, 0.85, rockMask); // dry stone: rougher (less shiny)
  // Wet sand: lower roughness for specular reflection
  roughness = mix(roughness, 0.25, wetSandMask);
  // Rain wetness — stone becomes glossy when wet
  let wetness = uniforms.wetness;
  roughness = mix(roughness, 0.4, wetness * rockMask); // wet stone: glossy but not mirror-like
  // Rain wetness — grass becomes shinier when wet
  roughness = mix(roughness, 0.4, wetness * vegMask);

  var metallic = 0.0;
  metallic = mix(metallic, 0.0, sandMask);
  metallic = mix(metallic, 0.0, vegMask);
  metallic = mix(metallic, 0.1, wetMask); // slight metal for wet specular
  metallic = mix(metallic, 0.0, rockMask);
  metallic = mix(metallic, 0.15, wetSandMask); // wet sand slight metal
  // Rain wetness — slight metallic for wet stone specular
  metallic = mix(metallic, 0.1, wetness * rockMask);
  // Rain wetness — slight metallic for wet grass specular
  metallic = mix(metallic, 0.05, wetness * vegMask);

  // Albedo with wet sand darkening and subtle color variation
  var albedo = baseColor;
  // Wet sand darkening (~45% darker)
  albedo = mix(albedo, albedo * 0.55, wetSandMask);
  // Smooth per-pixel color variation for sand — domain-warped fBm for organic patches
  let sandFine = (fbm3DWarp(worldPos * 10.0, 3u, 2.0, 3.0) - 0.5) * 0.06;
  let sandBroad = (fbm3DWarp(worldPos * 3.0, 2u, 0.8, 4.0) - 0.5) * 0.04;
  albedo = albedo + vec3<f32>(sandFine + sandBroad * 0.8, sandFine * 0.9 + sandBroad * 0.7, sandFine * 0.7 + sandBroad * 0.5) * sandMask;
  // Rain wetness — darken sand slightly when wet
  albedo = mix(albedo, albedo * 0.8, wetness * sandMask);

  // Per-pixel color variation for grass — domain-warped fBm for irregular clumps
  let grassFine = (fbm3DWarp(worldPos * 8.0, 3u, 1.5, 2.5) - 0.5) * 0.10;
  let grassBroad = (fbm3DWarp(worldPos * 2.0, 2u, 0.5, 5.0) - 0.5) * 0.06;
  albedo = albedo + vec3<f32>(grassFine * 0.6, grassFine + grassBroad, grassFine * 0.3) * vegMask;

  // Per-pixel color variation for stone — domain-warped fBm for irregular mottling
  let stoneNoise = (fbm3DWarp(worldPos * 6.0, 3u, 1.2, 3.5) - 0.5) * 0.08;
  albedo = albedo + vec3<f32>(stoneNoise + stoneNoise * 0.3, stoneNoise * 0.9, stoneNoise * 0.7) * rockMask;
  // Rain wetness — darken stone albedo when wet (water film absorbs light)
  albedo = mix(albedo, albedo * 0.6, wetness * rockMask);

  // Perturb normals for sand (fine grain ripples), grass (blade-like bumps), stone (rocky relief)
  let sandN = perturbNormal(N, worldPos, 60.0, 0.08);
  let grassN = perturbNormal(N, worldPos, 80.0, 0.15);
  let stoneN = perturbNormal(N, worldPos, 30.0, 0.2);
  var perturbedN = mix(N, sandN, sandMask);
  perturbedN = mix(perturbedN, grassN, vegMask);
  perturbedN = mix(perturbedN, stoneN, rockMask);

  // Subtle non-uniform roughness for sand/grass/stone specular
  roughness = roughness + (fbm3DWarp(worldPos * 12.0, 2u, 3.0, 2.0) - 0.5) * 0.1 * (sandMask + vegMask + rockMask);

  let V = normalize(uniforms.cameraPos - worldPos);
  let NdotV = max(dot(perturbedN, V), 0.0);
  let F0 = mix(vec3<f32>(0.04), albedo, metallic);

  // Direct lighting (sun)
  let L = sunDir;
  let NdotL = max(dot(perturbedN, L), 0.0);
  let radiance = vec3<f32>(sunIntensity);
  let kD = (1.0 - metallic) * (1.0 / PI);
  let diffuse = albedo * kD * NdotL * radiance;
  let spec = cookTorranceSpecular(perturbedN, V, L, F0, roughness) * NdotL * radiance;
  var color = diffuse + spec;

  // IBL from captured environment
  let R = reflect(-V, perturbedN);
  let irradiance = getIBLDiffuse(perturbedN) * ambientLevel;
  let kD_ibl = (1.0 - metallic) * (1.0 / PI);
  color += albedo * kD_ibl * irradiance;

  let F_ibl = fresnelSchlickRoughness(NdotV, F0, roughness);
  let specIBL = getIBLSpecular(perturbedN, R, roughness) * F_ibl * ambientLevel;
  color += specIBL;

  // Fresnel sky reflection on wet surfaces (shoreline + wet sand)
  let skyTint = mix(vec3<f32>(0.8, 0.85, 0.9), vec3<f32>(0.25, 0.25, 0.30), wetness);
  let fresnel = pow(1.0 - NdotV, 5.0);
  color = mix(color, vec3<f32>(0.3, 0.5, 0.75), fresnel * wetMask * 0.3);
  // Wet sand sky reflection — blend toward sky tint at grazing angles
  color = mix(color, skyTint, fresnel * wetSandMask * 0.4);
  // Rain wetness — Fresnel sky reflection on wet stone
  color = mix(color, skyTint, fresnel * wetness * rockMask * 0.25);

  // Sand grain sparkle — smooth view-dependent glint modulated by grain density
  color += sandSparkle(worldPos, perturbedN, V, L, sandMask * (1.0 - wetSandMask));

  // Dynamic lights (PBR)
  color += applyPBRDynamicLights(perturbedN, worldPos, V, albedo, F0, roughness, metallic);

  let dist = length(uniforms.cameraPos - worldPos);
  let fogFactor = min(dist / 1000.0, 1.0);
  color = mix(color, uniforms.fogColor.xyz, fogFactor);

  return color;
}

@fragment
fn fs_main(input: IslandVertexOutput) -> @location(0) vec4<f32> {
  let N = normalize(input.normal);
  var color = islandLighting(N, input.worldPos, input.color);
  return vec4<f32>(color, 1.0);
}
