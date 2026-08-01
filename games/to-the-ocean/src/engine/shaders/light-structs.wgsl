const MAX_POINT_LIGHTS = 32u;
const MAX_SPOT_LIGHTS = 8u;

struct PointLight {
  position: vec3<f32>,
  radius: f32,
  color: vec3<f32>,
  intensity: f32,
};

struct SpotLight {
  position: vec3<f32>,
  radius: f32,
  direction: vec3<f32>,
  cosInner: f32,
  color: vec3<f32>,
  cosOuter: f32,
  intensity: f32,
  _pad: f32,
};

struct LightStorage {
  numPointLights: u32,
  numSpotLights: u32,
  _pad0: u32,
  _pad1: u32,
  pointLights: array<PointLight, MAX_POINT_LIGHTS>,
  spotLights: array<SpotLight, MAX_SPOT_LIGHTS>,
};

@group(1) @binding(0) var<storage, read> lightData: LightStorage;

fn applyDynamicLights(N: vec3<f32>, worldPos: vec3<f32>, viewDir: vec3<f32>,
                      specPower: f32, specIntensity: f32) -> vec3<f32> {
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
    let diff = max(dot(N, L), 0.0);
    color += light.color * diff * light.intensity * atten;

    let halfDir = normalize(L + viewDir);
    let NdotH = max(dot(N, halfDir), 0.0);
    color += light.color * pow(NdotH, specPower) * specIntensity * light.intensity * atten;
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
    let diff = max(dot(N, L), 0.0);
    color += light.color * diff * light.intensity * atten;

    let halfDir = normalize(L + viewDir);
    let NdotH = max(dot(N, halfDir), 0.0);
    color += light.color * pow(NdotH, specPower) * specIntensity * light.intensity * atten;
  }

  return color;
}
