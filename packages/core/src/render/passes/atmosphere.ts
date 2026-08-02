import type { Vec3 } from "wgpu-matrix";

export interface AtmosphereConfig {
  planetRadius: number;
  atmosphereRadius: number;
  sunIntensity: number;
  rayleighCoefficients: Vec3;
  mieCoefficient: number;
  mieDirectionG: number;
  sunDirection: Vec3;
  samples: number;
}

export const DEFAULT_ATMOSPHERE_CONFIG: AtmosphereConfig = {
  planetRadius: 6371e3,
  atmosphereRadius: 6471e3,
  sunIntensity: 22.0,
  rayleighCoefficients: [5.5e-6, 13.0e-6, 22.4e-6],
  mieCoefficient: 21e-6,
  mieDirectionG: 0.758,
  sunDirection: [0, 1, 0],
  samples: 16,
};

export function computeRayleighScattering(
  wavelength: Vec3,
  coefficients: Vec3,
  density: number,
): Vec3 {
  return [
    coefficients[0] * density,
    coefficients[1] * density,
    coefficients[2] * density,
  ];
}

export function computeMieScattering(
  coefficient: number,
  density: number,
): number {
  return coefficient * density;
}

export function computeAtmosphereDensity(
  altitude: number,
  planetRadius: number,
  atmosphereRadius: number,
): number {
  const height = altitude - planetRadius;
  const atmosphereHeight = atmosphereRadius - planetRadius;
  if (height < 0) return 1.0;
  if (height > atmosphereHeight) return 0.0;
  return Math.exp(-height / (atmosphereHeight * 0.25));
}

export function computeOpticalDepthRayleigh(
  startAltitude: number,
  endAltitude: number,
  planetRadius: number,
  atmosphereRadius: number,
  samples: number,
): Vec3 {
  const depth: Vec3 = [0, 0, 0];
  const stepAltitude = (endAltitude - startAltitude) / samples;
  for (let i = 0; i < samples; i++) {
    const alt = startAltitude + stepAltitude * (i + 0.5);
    const density = computeAtmosphereDensity(alt, planetRadius, atmosphereRadius);
    depth[0] += density * stepAltitude;
    depth[1] += density * stepAltitude;
    depth[2] += density * stepAltitude;
  }
  return depth;
}

export function computeSkyColor(
  viewDir: Vec3,
  sunDir: Vec3,
  config: AtmosphereConfig,
): Vec3 {
  const cosTheta = viewDir[0] * sunDir[0] + viewDir[1] * sunDir[1] + viewDir[2] * sunDir[2];
  const rayleigh = computeRayleighScattering(
    config.rayleighCoefficients,
    config.rayleighCoefficients,
    1.0,
  );

  // Simplified sky color: Rayleigh phase * optical depth
  const phase = (3.0 / (16.0 * Math.PI)) * (1.0 + cosTheta * cosTheta);
  const intensity = config.sunIntensity * phase;

  return [
    intensity * rayleigh[0] * 1e6,
    intensity * rayleigh[1] * 1e6,
    intensity * rayleigh[2] * 1e6,
  ];
}

export const ATMOSPHERE_SHADER_CHUNK = /* wgsl */ `
struct AtmosphereUniforms {
  planetRadius: f32,
  atmosphereRadius: f32,
  sunIntensity: f32,
  mieG: f32,
  rayleighCoeffs: vec3<f32>,
  mieCoefficient: f32,
  sunDirection: vec3<f32>,
  samples: u32,
};

fn atmosphereDensity(altitude: f32, planetRadius: f32, atmosphereRadius: f32) -> f32 {
  let height = altitude - planetRadius;
  let atmosphereHeight = atmosphereRadius - planetRadius;
  if (height < 0.0) { return 1.0; }
  if (height > atmosphereHeight) { return 0.0; }
  return exp(-height / (atmosphereHeight * 0.25));
}

fn rayleighPhase(cosTheta: f32) -> f32 {
  return (3.0 / (16.0 * 3.14159265)) * (1.0 + cosTheta * cosTheta);
}

fn miePhase(cosTheta: f32, g: f32) -> f32 {
  let g2 = g * g;
  let denom = 1.0 + g2 - 2.0 * g * cosTheta;
  return (3.0 * (1.0 - g2)) / (8.0 * 3.14159265 * denom * sqrt(max(denom, 0.0001)));
}

fn computeAtmosphereColor(
  rayOrigin: vec3<f32>,
  rayDir: vec3<f32>,
  sunDir: vec3<f32>,
  uniforms: AtmosphereUniforms,
) -> vec3<f32> {
  // Simplified atmospheric scattering
  let cosTheta = dot(rayDir, sunDir);
  let rayleighPhaseVal = rayleighPhase(cosTheta);
  let miePhaseVal = miePhase(cosTheta, uniforms.mieG);

  // Approximate optical depth based on view direction
  let upDot = max(rayDir.y, 0.0);
  let opticalDepth = 1.0 / (upDot + 0.1);

  let rayleighColor = uniforms.rayleighCoeffs * rayleighPhaseVal * opticalDepth;
  let mieColor = uniforms.mieCoefficient * miePhaseVal * opticalDepth;

  let color = (rayleighColor + vec3<f32>(mieColor)) * uniforms.sunIntensity;
  return color;
}
`;
