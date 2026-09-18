struct CloudUniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  timeOfDay: f32,
  weatherType: u32,
  sunDir: vec3<f32>,
  sunIntensity: f32,
  moonDir: vec3<f32>,
  moonIntensity: f32,
  time: f32,
  weatherBlend: f32,
  fogColor: vec3<f32>,
  fogDensity: f32,
};

@group(0) @binding(0) var<uniform> uniforms: CloudUniforms;

struct PerLayerUniforms {
  layerPos: vec3<f32>,
  _pad: f32,
};

@group(0) @binding(1) var<uniform> perLayer: PerLayerUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color: vec3<f32>,
  @location(3) viewDist: f32,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let worldPos = input.position + perLayer.layerPos;
  output.worldPos = worldPos;
  output.clipPos = uniforms.viewProj * vec4<f32>(worldPos, 1.0);
  output.normal = input.normal;
  output.color = input.color;
  output.viewDist = length(uniforms.cameraPos - worldPos);
  return output;
}

fn weatherTint(weather: u32) -> vec3<f32> {
  if (weather == 0u) { return vec3<f32>(1.0, 1.0, 1.0); }
  if (weather == 1u) { return vec3<f32>(1.0, 1.0, 1.0); }
  if (weather == 2u) { return vec3<f32>(0.7, 0.7, 0.72); }
  if (weather == 3u) { return vec3<f32>(0.55, 0.55, 0.58); }
  if (weather == 4u) { return vec3<f32>(0.25, 0.25, 0.30); }
  if (weather == 5u) { return vec3<f32>(0.6, 0.6, 0.62); }
  if (weather == 8u) { return vec3<f32>(0.4, 0.15, 0.08); }
  if (weather == 9u) { return vec3<f32>(0.85, 0.88, 0.92); }
  return vec3<f32>(1.0, 1.0, 1.0);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let N = normalize(input.normal);
  let baseColor = input.color;

  let sunDir = normalize(uniforms.sunDir);
  let moonDir = normalize(uniforms.moonDir);
  let sunNdotL = max(dot(N, sunDir), 0.0);
  let moonNdotL = max(dot(N, moonDir), 0.0);

  let dayFactor = smoothstep(0.2, 0.4, uniforms.timeOfDay) * (1.0 - smoothstep(0.65, 0.8, uniforms.timeOfDay));
  let sunsetFactor = smoothstep(0.15, 0.25, uniforms.timeOfDay) * (1.0 - smoothstep(0.25, 0.35, uniforms.timeOfDay))
    + smoothstep(0.65, 0.75, uniforms.timeOfDay) * (1.0 - smoothstep(0.75, 0.85, uniforms.timeOfDay));

  let sunColor = mix(vec3<f32>(1.0, 0.6, 0.3), vec3<f32>(1.0, 0.97, 0.9), dayFactor);
  let moonColor = vec3<f32>(0.7, 0.7, 0.75);

  let sunLight = sunColor * sunNdotL * uniforms.sunIntensity;
  let moonLight = moonColor * moonNdotL * uniforms.moonIntensity;
  let ambient = vec3<f32>(0.45, 0.45, 0.47) * (0.4 + dayFactor * 0.4);

  // Bounce light for underside
  let bottomFactor = max(-N.y, 0.0);
  let bounceColor = mix(vec3<f32>(0.8, 0.82, 0.85), vec3<f32>(1.0, 0.9, 0.75), dayFactor);
  let bounce = bounceColor * bottomFactor * (0.3 + dayFactor * 0.3);

  var litColor = baseColor * (sunLight + moonLight + ambient + bounce);

  // Sunset tint
  litColor = mix(litColor, litColor * vec3<f32>(1.0, 0.6, 0.4), sunsetFactor * 0.4);

  // Weather tinting
  let tint = weatherTint(uniforms.weatherType);
  litColor = mix(litColor, litColor * tint, 0.5);

  // Soft alpha
  let V = normalize(uniforms.cameraPos - input.worldPos);
  let NdotV = max(dot(N, V), 0.0);
  let edgeAlpha = smoothstep(0.0, 0.15, NdotV);
  let distFade = 1.0 - smoothstep(2000.0, 4000.0, input.viewDist);
  let baseAlpha = 0.65 + 0.3 * NdotV;
  let alpha = baseAlpha * edgeAlpha * distFade;

  // Distance fog
  let fogFactor = 1.0 - exp(-uniforms.fogDensity * input.viewDist);
  litColor = mix(litColor, uniforms.fogColor, fogFactor * 0.5);

  return vec4<f32>(litColor, alpha);
}
