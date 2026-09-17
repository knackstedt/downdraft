// wgsl-validate: prelude ./light-structs.wgsl
const PI: f32 = 3.14159265359;

// Per-entity-type PBR material parameters: (metallic, roughness)
fn getPBRParams(entityType: u32) -> vec2<f32> {
  switch (entityType) {
    case 0u: { return vec2<f32>(0.0, 0.6); }   // Player — skin/cloth, non-metal, medium rough
    case 1u: { return vec2<f32>(0.3, 0.5); }   // Ship — wood with metal fittings
    case 2u: { return vec2<f32>(0.2, 0.6); }   // SmallCraft — wood
    case 3u: { return vec2<f32>(0.0, 0.3); }   // Fish — wet/smooth organic
    case 4u: { return vec2<f32>(0.0, 0.25); }  // Shark — wet/smooth organic
    case 5u: { return vec2<f32>(0.0, 0.35); }  // Eel
    case 6u: { return vec2<f32>(0.0, 0.2); }   // Jellyfish — translucent/glossy
    case 7u: { return vec2<f32>(0.0, 0.4); }   // DevilShrimp
    case 8u: { return vec2<f32>(0.0, 0.3); }   // Whale
    case 9u: { return vec2<f32>(0.0, 0.25); }  // Dolphin
    case 10u: { return vec2<f32>(0.0, 0.5); }  // Turtle
    case 11u: { return vec2<f32>(0.1, 0.45); } // Crustacean — shell, slight metal
    case 12u: { return vec2<f32>(0.0, 0.4); }  // Coral — matte organic
    case 14u: { return vec2<f32>(0.0, 0.6); }  // Pirate
    case 15u: { return vec2<f32>(0.4, 0.55); } // PirateShip — weathered wood/metal
    case 16u: { return vec2<f32>(0.0, 0.8); }  // Island — handled separately in islandLighting
    case 17u: { return vec2<f32>(0.1, 0.5); }  // Port — stone/wood
    default: { return vec2<f32>(0.0, 0.5); }
  }
}

// GGX/Trowbridge-Reitz normal distribution function
fn distributionGGX(N: vec3<f32>, H: vec3<f32>, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let NdotH = max(dot(N, H), 0.0);
  let NdotH2 = NdotH * NdotH;
  let nom = a2;
  let denom = (NdotH2 * (a2 - 1.0) + 1.0);
  let denom2 = denom * denom;
  return nom / max(denom2, 0.0001);
}

// Schlick-Beckmann geometry function (direct lighting)
fn geometrySchlickGGX(NdotV: f32, roughness: f32) -> f32 {
  let r = roughness + 1.0;
  let k = (r * r) / 8.0;
  return NdotV / (NdotV * (1.0 - k) + k);
}

// Smith's method for combining geometry functions
fn geometrySmith(N: vec3<f32>, V: vec3<f32>, L: vec3<f32>, roughness: f32) -> f32 {
  let NdotV = max(dot(N, V), 0.0);
  let NdotL = max(dot(N, L), 0.0);
  let ggx2 = geometrySchlickGGX(NdotV, roughness);
  let ggx1 = geometrySchlickGGX(NdotL, roughness);
  return ggx1 * ggx2;
}

// Schlick Fresnel approximation
fn fresnelSchlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
  return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

// Fresnel with roughness term for IBL (used for environment specular)
fn fresnelSchlickRoughness(cosTheta: f32, F0: vec3<f32>, roughness: f32) -> vec3<f32> {
  return F0 + (max(vec3<f32>(1.0 - roughness), F0) - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

// Cook-Torrance specular BRDF for a single light direction
fn cookTorranceSpecular(N: vec3<f32>, V: vec3<f32>, L: vec3<f32>,
                         F0: vec3<f32>, roughness: f32) -> vec3<f32> {
  let H = normalize(V + L);
  let NDF = distributionGGX(N, H, roughness);
  let G = geometrySmith(N, V, L, roughness);
  let NdotV = max(dot(N, V), 0.0);
  let NdotL = max(dot(N, L), 0.0);
  let VdotH = max(dot(V, H), 0.0);
  let F = fresnelSchlick(VdotH, F0);
  let numerator = NDF * G * F;
  let denominator = 4.0 * NdotV * NdotL + 0.0001;
  return numerator / denominator;
}

// PBR dynamic lights using Cook-Torrance for specular and Lambert for diffuse
fn applyPBRDynamicLights(N: vec3<f32>, worldPos: vec3<f32>, V: vec3<f32>,
                          albedo: vec3<f32>, F0: vec3<f32>, roughness: f32, metallic: f32) -> vec3<f32> {
  var color = vec3<f32>(0.0);

  let numPoint = lightData.numPointLights;
  for (var i = 0u; i < MAX_POINT_LIGHTS; i++) {
    if (i >= numPoint) { break; }
    let light = lightData.pointLights[i];
    let toLight = light.position - worldPos;
    let dist = length(toLight);
    if (dist > light.radius) { continue; }
    let L = toLight / max(dist, 0.001);
    let atten = 1.0 - smoothstep(0.0, light.radius, dist);
    let NdotL = max(dot(N, L), 0.0);
    if (NdotL <= 0.0) { continue; }

    let radiance = light.color * light.intensity * atten;
    let kD = (1.0 - metallic) * (1.0 / PI);
    let diffuse = albedo * kD * NdotL * radiance;
    let spec = cookTorranceSpecular(N, V, L, F0, roughness) * NdotL * radiance;
    color += diffuse + spec;
  }

  let numSpot = lightData.numSpotLights;
  for (var i = 0u; i < MAX_SPOT_LIGHTS; i++) {
    if (i >= numSpot) { break; }
    let light = lightData.spotLights[i];
    let toLight = light.position - worldPos;
    let dist = length(toLight);
    if (dist > light.radius) { continue; }
    let L = toLight / max(dist, 0.001);
    let spotCos = dot(-L, light.direction);
    if (spotCos < light.cosOuter) { continue; }
    let spotAtten = smoothstep(light.cosOuter, light.cosInner, spotCos);
    let atten = (1.0 - smoothstep(0.0, light.radius, dist)) * spotAtten;
    let NdotL = max(dot(N, L), 0.0);
    if (NdotL <= 0.0) { continue; }

    let radiance = light.color * light.intensity * atten;
    let kD = (1.0 - metallic) * (1.0 / PI);
    let diffuse = albedo * kD * NdotL * radiance;
    let spec = cookTorranceSpecular(N, V, L, F0, roughness) * NdotL * radiance;
    color += diffuse + spec;
  }

  return color;
}
