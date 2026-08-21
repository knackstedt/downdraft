struct Uniforms {
  gridW: f32,
  gridH: f32,
  // Backdrop grid origin Y in backdrop cell coords (originCy * BACKDROP_CHUNK_H).
  // Used to compute the foreground world Y of a backdrop cell for depth-aware
  // ambient: worldY = (originY + coords.y) * 2 (1 backdrop cell = 2 fg cells).
  originY: f32,
  // Foreground surface height in foreground world coords. Cave ambient falls
  // off with depth below the surface so caves are lighter near the surface
  // and darker deep underground (but never pure black).
  surfaceY: f32,
};

struct CameraUniforms {
  // Camera center in backdrop-local cell coords (already parallax-scaled
  // and half-res converted by the renderer).
  camX: f32,
  camY: f32,
  // Zoom factor (1 = 1 cell per pixel, >1 = zoomed in)
  zoom: f32,
  // Canvas dimensions in pixels
  canvasW: f32,
  canvasH: f32,
  // Parallax factor (screen offset is multiplied by this)
  parallax: f32,
  pad1: f32,
};

@group(0) @binding(0) var gridTex: texture_2d<u32>;
@group(0) @binding(1) var<uniform> u: Uniforms;
@group(0) @binding(2) var<uniform> cam: CameraUniforms;
@group(0) @binding(3) var lightTex: texture_2d<f32>;
@group(0) @binding(4) var volumetricTex: texture_2d<f32>;

fn cellTypeFromAlpha(a: f32) -> u32 {
  // 0 = cave, 64 = water, 128 = oil, 200 = solid, 255 = lava
  if (a > 240.0) { return 4u; }  // lava
  if (a > 160.0) { return 3u; }  // solid
  if (a > 96.0) { return 2u; }   // oil
  if (a > 32.0) { return 1u; }   // water
  return 0u;                      // cave
}

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  // uv is 0..1 across the fullscreen quad.
  // Convert to screen pixel coords.
  let screenPx = vec2<f32>(uv.x * cam.canvasW, uv.y * cam.canvasH);

  // The camera position (cam.camX/cam.camY) is already in backdrop-local
  // cell coords — the renderer computed it as:
  //   worldCam * parallax - backdropOrigin
  // The backdrop is full-res (1 backdrop cell = 1 foreground cell), so the
  // screen offset only needs parallax scaling (no half-res conversion).
  let cellX = (screenPx.x - cam.canvasW * 0.5) / cam.zoom * cam.parallax + cam.camX;
  let cellY = (screenPx.y - cam.canvasH * 0.5) / cam.zoom * cam.parallax + cam.camY;

  let coords = vec2<i32>(i32(cellX), i32(cellY));

  // Compute the foreground world Y of this backdrop cell to check if we're
  // above the surface (sky) or below (underground). worldY = (originY +
  // coords.y) * 2 (1 backdrop cell = 2 fg cells, but the backdrop grid is
  // full-res relative to the active grid, so worldY = originY + coords.y
  // in backdrop cell coords... actually the renderer passes originY in
  // backdrop cell coords and the shader computes worldY = (originY +
  // coords.y) * 2 per the comment in updateUniforms). We use this to draw
  // a sky gradient above the surface instead of the cave void color.
  let worldY = (u.originY + f32(coords.y)) * 2.0;

  // Above the surface: render a sky gradient instead of the cave void.
  // This avoids the "light reflecting off the sky" artifact where the
  // bright ambient light at depth=0 makes the dark cave-void backdrop
  // cells glow with a washed-out gray-blue color.
  if (worldY < u.surfaceY) {
    // Sky gradient: bright blue at the horizon, fading to lighter blue
    // higher up. heightAbove = how far above the surface (0 = horizon).
    let heightAbove = u.surfaceY - worldY;
    let skyT = clamp(heightAbove / 200.0, 0.0, 1.0);
    // Horizon: warm light blue (sky meeting terrain). Zenith: deeper blue.
    let horizon = vec3<f32>(0.45, 0.62, 0.85);
    let zenith = vec3<f32>(0.25, 0.42, 0.72);
    let skyColor = mix(horizon, zenith, skyT);
    // Subtle vertical banding for atmosphere (clouds-ish)
    let bandNoise = sin(f32(coords.x) * 0.03 + u.originY * 0.01) * 0.02;
    return vec4<f32>(skyColor + bandNoise, 1.0);
  }

  if (coords.x < 0 || coords.x >= i32(u.gridW) || coords.y < 0 || coords.y >= i32(u.gridH)) {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }

  let packed = textureLoad(gridTex, coords, 0).r;
  // Packed RGBA: r | (g << 8) | (b << 16) | (a << 24)
  let r = f32(packed & 0xffu) / 255.0;
  let g = f32((packed >> 8u) & 0xffu) / 255.0;
  let b = f32((packed >> 16u) & 0xffu) / 255.0;
  let a = f32((packed >> 24u) & 0xffu);
  let packedRGB = vec3<f32>(r, g, b);
  let cellType = cellTypeFromAlpha(a);

  // Sample the light accumulation + volumetric textures.
  // The backdrop grid is full-res (640×640 = ACTIVE_GRID_W×ACTIVE_GRID_H),
  // but the volumetric/light field is half-res (320×320). So 2 backdrop
  // cells = 1 volumetric texel. Sample at coords / 2.
  let lightCoords = vec2<i32>(
    clamp(coords.x / 2, 0, i32(u.gridW / 2) - 1),
    clamp(coords.y / 2, 0, i32(u.gridH / 2) - 1),
  );
  let lightSample = textureLoad(lightTex, lightCoords, 0);
  let volSample = textureLoad(volumetricTex, lightCoords, 0);
  let lighting = lightSample.rgb + volSample.rgb;

  // No ambient floor — the backdrop is fully black without a light source.
  // The backdrop is a background layer; it should only be visible where the
  // foreground light field (headlamp, lava, torches) reaches.

  // Use the SAME RGB lighting as the foreground (matColor * lighting) so the
  // backdrop color matches the foreground under the same light. The backdrop
  // is behind the foreground, so attenuate by a fixed factor to make it darker.
  // This keeps the calculation uniform — same base color, same light color,
  // same multiply — just dimmer.
  let dimLighting = lighting * 0.3;

  // Cell-type-aware shading — matches foreground sand-render pattern
  // (matColor * lighting), just with dimmed lighting:
  //   CAVE  — diffused light only (hazy void, black without light)
  //   LAVA  — self-emissive glow (always visible)
  //   WATER — dark body + blue-tinted diffused light
  //   OIL   — dark body + minimal diffused light
  //   SOLID — wall texture * dimmed RGB lighting (black without light)
  var color = vec3<f32>(0.0);

  if (cellType == 0u) {
    // Cave void: diffused light only — black without light, slight cool tint
    color = dimLighting * vec3<f32>(0.8, 0.85, 0.95);
  } else if (cellType == 4u) {
    // Lava: self-emissive (brightened packed color) — always glows
    color = packedRGB * 1.5 + dimLighting * 0.2;
  } else if (cellType == 1u) {
    // Water: dark body + blue-tinted diffused light
    color = packedRGB * 0.3 + dimLighting * vec3<f32>(0.5, 0.7, 1.0);
  } else if (cellType == 2u) {
    // Oil: dark body + minimal diffused light
    color = packedRGB * 0.4 + dimLighting * 0.2;
  } else {
    // Solid wall: texture * dimmed RGB lighting — same as foreground
    // (matColor * lighting) but with 0.3 attenuation. Black without light.
    color = packedRGB * dimLighting;
  }

  return vec4<f32>(color, 1.0);
}
