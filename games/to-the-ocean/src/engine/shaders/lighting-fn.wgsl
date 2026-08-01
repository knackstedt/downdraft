fn entityLighting(N: vec3<f32>, worldPos: vec3<f32>, baseColor: vec3<f32>) -> vec3<f32> {
  let sunDir = normalize(uniforms.sunDirIntensity.xyz);
  let sunIntensity = uniforms.sunDirIntensity.w;
  let ambientLevel = uniforms.ambientParams.x;

  let pbrParams = getPBRParams(uniforms.entityType);
  let metallic = pbrParams.x;
  let roughness = pbrParams.y;

  let albedo = baseColor;
  let V = normalize(uniforms.cameraPos - worldPos);
  let NdotV = max(dot(N, V), 0.0);

  // F0 — dielectric reflectance at normal incidence, metal uses albedo as F0
  let F0 = mix(vec3<f32>(0.04), albedo, metallic);

  // --- Direct lighting (sun) ---
  let L = sunDir;
  let NdotL = max(dot(N, L), 0.0);
  let radiance = vec3<f32>(sunIntensity);

  let kD = (1.0 - metallic) * (1.0 / PI);
  let diffuse = albedo * kD * NdotL * radiance;
  let spec = cookTorranceSpecular(N, V, L, F0, roughness) * NdotL * radiance;
  var color = diffuse + spec;

  // --- Image-based lighting (IBL) from captured environment ---
  let R = reflect(-V, N);
  let irradiance = getIBLDiffuse(N) * ambientLevel;
  let kD_ibl = (1.0 - metallic) * (1.0 / PI);
  color += albedo * kD_ibl * irradiance;

  let F_ibl = fresnelSchlickRoughness(NdotV, F0, roughness);
  let specIBL = getIBLSpecular(N, R, roughness) * F_ibl * ambientLevel;
  color += specIBL;

  // --- Dynamic point/spot lights (PBR) ---
  color += applyPBRDynamicLights(N, worldPos, V, albedo, F0, roughness, metallic);

  // Bioluminescent emissive — self-illumination for glowing entities (jellyfish, etc.)
  if ((uniforms.entityFlags & 512u) != 0u) {
    let pulse = 0.6 + 0.4 * sin(uniforms.time * 2.0);
    color += vec3<f32>(0.2, 0.8, 1.0) * pulse * 0.5;
  }

  // Fog
  let dist = length(uniforms.cameraPos - worldPos);
  let fogFactor = min(dist / 1000.0, 1.0);
  color = mix(color, uniforms.fogColor.xyz, fogFactor);

  return color;
}
