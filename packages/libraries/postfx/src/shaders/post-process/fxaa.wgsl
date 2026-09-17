// wgsl-validate: prelude ./fullscreen-vs.wgsl
// wgsl-validate: prelude ./occluder-chunk.wgsl
struct U { texelSize: vec2<f32>, _p0: f32, _p1: f32, _p2: f32, _p3: f32, _p4: f32, _p5: f32, _p6: f32, };
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var dummyTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;

fn FxaaContrast(a: vec4<f32>, b: vec4<f32>) -> f32 {
  let d = abs(a - b);
  return max(max(max(d.r, d.g), d.b), d.a);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  if (isOccluded(input.uv)) { discard; }
  let posM = input.uv;
  let rcpFrame = u.texelSize;

  let rgbaM = textureSample(colorTex, samp, posM);
  let rgbaS = textureSample(colorTex, samp, posM + vec2(0.0, rcpFrame.y));
  let rgbaE = textureSample(colorTex, samp, posM + vec2(rcpFrame.x, 0.0));
  let rgbaN = textureSample(colorTex, samp, posM + vec2(0.0, -rcpFrame.y));
  let rgbaW = textureSample(colorTex, samp, posM + vec2(-rcpFrame.x, 0.0));

  let earlyExit = max(max(max(
    FxaaContrast(rgbaM, rgbaN),
    FxaaContrast(rgbaM, rgbaS)),
    FxaaContrast(rgbaM, rgbaE)),
    FxaaContrast(rgbaM, rgbaW)) < 0.06;
  if (earlyExit) { return rgbaM; }

  let contrastN = FxaaContrast(rgbaM, rgbaN);
  let contrastS = FxaaContrast(rgbaM, rgbaS);
  let contrastE = FxaaContrast(rgbaM, rgbaE);
  let contrastW = FxaaContrast(rgbaM, rgbaW);

  var relativeVContrast = (contrastN + contrastS) - (contrastE + contrastW);
  relativeVContrast = relativeVContrast * 5.0;

  var horzSpan = relativeVContrast > 0.0;

  if (abs(relativeVContrast) < 0.1) {
    let dirToEdgeX = select(-1.0, 1.0, contrastE > contrastW);
    let dirToEdgeY = select(-1.0, 1.0, contrastS > contrastN);

    let rgbaAlongH = textureSampleLevel(colorTex, samp, posM + vec2(dirToEdgeX, -dirToEdgeY) * rcpFrame, 0.0);
    let matchAlongH = FxaaContrast(rgbaM, rgbaAlongH);

    let rgbaAlongV = textureSampleLevel(colorTex, samp, posM + vec2(-dirToEdgeX, dirToEdgeY) * rcpFrame, 0.0);
    let matchAlongV = FxaaContrast(rgbaM, rgbaAlongV);

    relativeVContrast = (matchAlongV - matchAlongH) * 5.0;
    if (abs(relativeVContrast) < 0.1) {
      return mix(rgbaM, (rgbaN + rgbaS + rgbaE + rgbaW) * 0.25, 0.4);
    }
    horzSpan = relativeVContrast > 0.0;
  }

  var rgbaN2 = select(rgbaN, rgbaW, horzSpan);
  var rgbaS2 = select(rgbaS, rgbaE, horzSpan);

  let pairN = FxaaContrast(rgbaM, rgbaN2) > FxaaContrast(rgbaM, rgbaS2);
  if (!pairN) { rgbaN2 = rgbaS2; }

  let offNPX = select(0.0, rcpFrame.x, horzSpan);
  let offNPY = select(rcpFrame.y, 0.0, horzSpan);

  var doneN = false;
  var doneP = false;
  var nDist = 0.0;
  var pDist = 0.0;
  var posN = posM;
  var posP = posM;

  for (var i = 0u; i < 5u; i++) {
    let inc = f32(i + 1u);
    if (!doneN) {
      nDist = nDist + inc;
      posN = posM + vec2(offNPX, offNPY) * nDist;
      let rgbaEndN = textureSampleLevel(colorTex, samp, posN, 0.0);
      doneN = FxaaContrast(rgbaEndN, rgbaM) > FxaaContrast(rgbaEndN, rgbaN2);
    }
    if (!doneP) {
      pDist = pDist + inc;
      posP = posM - vec2(offNPX, offNPY) * pDist;
      let rgbaEndP = textureSampleLevel(colorTex, samp, posP, 0.0);
      doneP = FxaaContrast(rgbaEndP, rgbaM) > FxaaContrast(rgbaEndP, rgbaN2);
    }
    if (doneN || doneP) { break; }
  }

  if (!doneN && !doneP) { return rgbaM; }

  let span = nDist + pDist;
  var dist = min(nDist, pDist) / max(span, 0.001);
  dist = 1.0 - dist;
  dist = sqrt(dist);

  let result = mix(rgbaM, rgbaN2, dist * 0.5);
  return result;
}
