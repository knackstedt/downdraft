export enum ToneMappingOperator {
  None = "none",
  ACES = "aces",
  ACESFilmic = "aces-filmic",
  Reinhard = "reinhard",
  Reinhard2 = "reinhard2",
  Uncharted2 = "uncharted2",
  Filmic = "filmic",
  AgX = "agx",
  Uchimura = "uchimura",
}

export interface ToneMappingSettings {
  operator: ToneMappingOperator;
  exposure: number;
  gamma: number;
  whitePoint: number;
}

export const DEFAULT_TONE_MAPPING_SETTINGS: ToneMappingSettings = {
  operator: ToneMappingOperator.ACES,
  exposure: 1.0,
  gamma: 2.2,
  whitePoint: 11.2,
};

export const TONE_MAPPING_SHADER_CHUNK = /* wgsl */ `
enum ToneMappingOp {
  None = 0,
  ACES = 1,
  ACESFilmic = 2,
  Reinhard = 3,
  Reinhard2 = 4,
  Uncharted2 = 5,
  Filmic = 6,
  AgX = 7,
  Uchimura = 8,
};

struct ToneMappingUniforms {
  operator: u32,
  exposure: f32,
  gamma: f32,
  whitePoint: f32,
};

fn tonemapNone(color: vec3<f32>) -> vec3<f32> {
  return clamp(color, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn tonemapACES(color: vec3<f32>) -> vec3<f32> {
  let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
  return clamp((color * (a * color + b)) / (color * (c * color + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn tonemapACESFilmic(color: vec3<f32>) -> vec3<f32> {
  let a = 0.15; let b = 0.50; let c = 0.10; let d = 0.20; let e = 0.02; let f = 0.30;
  return (color * (color * a + b * c + d * e)) / (color * (color * a + b) + d * f) - e / f;
}

fn tonemapReinhard(color: vec3<f32>) -> vec3<f32> {
  return color / (color + 1.0);
}

fn tonemapReinhard2(color: vec3<f32>, whitePoint: f32) -> vec3<f32> {
  let lum = dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
  let tonemappedLum = lum * (1.0 + lum / (whitePoint * whitePoint)) / (1.0 + lum);
  return color * (tonemappedLum / max(lum, 0.001));
}

fn tonemapUncharted2(color: vec3<f32>, whitePoint: f32) -> vec3<f32> {
  let A = 0.15; let B = 0.50; let C = 0.10; let D = 0.20; let E = 0.02; let F = 0.30;
  fn curve(x: vec3<f32>) -> vec3<f32> {
    return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
  }
  return curve(color) / curve(vec3<f32>(whitePoint));
}

fn tonemapFilmic(color: vec3<f32>) -> vec3<f32> {
  let X = max(color.r - 0.0024, 0.0);
  let Y = max(color.g - 0.0024, 0.0);
  let Z = max(color.b - 0.0024, 0.0);
  let r = (X * (6.2 * X + 0.5)) / (X * (6.2 * X + 1.7) + 0.06);
  let g = (Y * (6.2 * Y + 0.5)) / (Y * (6.2 * Y + 1.7) + 0.06);
  let b = (Z * (6.2 * Z + 0.5)) / (Z * (6.2 * Z + 1.7) + 0.06);
  return vec3<f32>(r, g, b);
}

fn tonemapAgX(color: vec3<f32>) -> vec3<f32> {
  let MinEv = -12.47393;
  let MaxEv = 4.026069;
  let x = clamp(log2(color.r), MinEv, MaxEv);
  let y = clamp(log2(color.g), MinEv, MaxEv);
  let z = clamp(log2(color.b), MinEv, MaxEv);
  let r = (x - MinEv) / (MaxEv - MinEv);
  let g = (y - MinEv) / (MaxEv - MinEv);
  let b = (z - MinEv) / (MaxEv - MinEv);
  let r2 = pow(r, 2.2);
  let g2 = pow(g, 2.2);
  let b2 = pow(b, 2.2);
  return vec3<f32>(r2, g2, b2);
}

fn tonemapUchimura(color: vec3<f32>) -> vec3<f32> {
  let P = 1.0; let a = 5.0; let m = 0.22; let l = 0.4; let c = 1.633; let b = 0.63;
  fn uchimuraCurve(x: f32) -> f32 {
    let l0 = ((P - m) * l) / a;
    let L0 = m - m / a;
    let L1 = m + (1.0 - m) / a;
    let L2 = m + (1.0 - m) / a + (c + b) / c;
    let s = (1.0 + c) * a / (P - m);
    let S0 = m + l0;
    let S1 = m + a * l0;
    let S2 = m + a * (l0 + c / a);
    let C2 = (a * P) / (P - S1);
    let C1 = 1.0 + C2 * (S1 - S0);
    let C0 = 1.0 + C2 * (S0 - 0.0);
    if (x < S0) { return C0 * x; }
    if (x < S1) { return C1 * x - C2 * S0; }
    if (x < S2) { return a * x + b; }
    return C2 * x - C2 * S2;
  }
  return vec3<f32>(
    uchimuraCurve(color.r),
    uchimuraCurve(color.g),
    uchimuraCurve(color.b),
  );
}

fn applyToneMapping(color: vec3<f32>, op: u32, exposure: f32, whitePoint: f32) -> vec3<f32> {
  let exposed = color * exposure;
  switch (op) {
    case 0u: { return tonemapNone(exposed); }
    case 1u: { return tonemapACES(exposed); }
    case 2u: { return tonemapACESFilmic(exposed); }
    case 3u: { return tonemapReinhard(exposed); }
    case 4u: { return tonemapReinhard2(exposed, whitePoint); }
    case 5u: { return tonemapUncharted2(exposed, whitePoint); }
    case 6u: { return tonemapFilmic(exposed); }
    case 7u: { return tonemapAgX(exposed); }
    case 8u: { return tonemapUchimura(exposed); }
    default: { return tonemapACES(exposed); }
  }
}

fn linearToSRGB(color: vec3<f32>) -> vec3<f32> {
  return select(
    color * 12.92,
    pow(color, vec3<f32>(1.0 / 2.4)) * 1.055 - 0.055,
    color >= vec3<f32>(0.0031308),
  );
}

fn srgbToLinear(color: vec3<f32>) -> vec3<f32> {
  return select(
    color / 12.92,
    pow((color + 0.055) / 1.055, vec3<f32>(2.4)),
    color >= vec3<f32>(0.04045),
  );
}

fn linearToDisplayP3(color: vec3<f32>) -> vec3<f32> {
  return linearToSRGB(color);
}
`;

export function getToneMappingOperatorIndex(op: ToneMappingOperator): number {
  const map: Record<ToneMappingOperator, number> = {
    [ToneMappingOperator.None]: 0,
    [ToneMappingOperator.ACES]: 1,
    [ToneMappingOperator.ACESFilmic]: 2,
    [ToneMappingOperator.Reinhard]: 3,
    [ToneMappingOperator.Reinhard2]: 4,
    [ToneMappingOperator.Uncharted2]: 5,
    [ToneMappingOperator.Filmic]: 6,
    [ToneMappingOperator.AgX]: 7,
    [ToneMappingOperator.Uchimura]: 8,
  };
  return map[op] ?? 1;
}
