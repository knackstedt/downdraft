struct Uniforms {
  gridW: f32,
  gridH: f32,
  // Backdrop grid origin Y in backdrop cell coords (originCy * BACKDROP_CHUNK_H).
  // The backdrop is full-res (1 backdrop cell = 1 foreground cell), so
  // worldY = originY + coords.y (no scaling).
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
  // 0 = cave, 32 = sky, 64 = water, 128 = oil, 200 = solid, 255 = lava
  if (a > 240.0) { return 5u; }  // lava
  if (a > 160.0) { return 4u; }  // solid
  if (a > 96.0) { return 3u; }   // oil
  if (a > 48.0) { return 2u; }   // water
  if (a > 16.0) { return 1u; }   // sky
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

  if (coords.x < 0 || coords.x >= i32(u.gridW) || coords.y < 0 || coords.y >= i32(u.gridH)) {
    // Out of bounds above the surface: render sky (the backdrop grid doesn't
    // cover above-surface chunks well, so fill with sky gradient). Use the
    // world Y to decide sky vs black — if above surface, it's sky.
    let worldY = u.originY + f32(coords.y);
    if (worldY < u.surfaceY) {
      let heightAbove = u.surfaceY - worldY;
      let skyT = clamp(heightAbove / 200.0, 0.0, 1.0);
      let horizon = vec3<f32>(0.45, 0.62, 0.85);
      let zenith = vec3<f32>(0.25, 0.42, 0.72);
      return vec4<f32>(mix(horizon, zenith, skyT), 1.0);
    }
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

  // Sky cells: render a sky gradient based on the cell's world Y relative to
  // the surface. This is per-cell (from the backdrop grid data), so it
  // follows the actual wavy terrain surface — not a single horizontal line
  // at the player's X position.
  if (cellType == 1u) {
    let worldY = u.originY + f32(coords.y);
    let heightAbove = max(0.0, u.surfaceY - worldY);
    let skyT = clamp(heightAbove / 200.0, 0.0, 1.0);
    let horizon = vec3<f32>(0.45, 0.62, 0.85);
    let zenith = vec3<f32>(0.25, 0.42, 0.72);
    let skyColor = mix(horizon, zenith, skyT);
    // Subtle horizontal banding for atmosphere
    let bandNoise = sin(f32(coords.x) * 0.03) * 0.02;
    return vec4<f32>(skyColor + bandNoise, 1.0);
  }

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
  } else if (cellType == 5u) {
    // Lava: self-emissive (brightened packed color) — always glows
    color = packedRGB * 1.5 + dimLighting * 0.2;
  } else if (cellType == 2u) {
    // Water: dark body + blue-tinted diffused light
    color = packedRGB * 0.3 + dimLighting * vec3<f32>(0.5, 0.7, 1.0);
  } else if (cellType == 3u) {
    // Oil: dark body + minimal diffused light
    color = packedRGB * 0.4 + dimLighting * 0.2;
  } else {
    // Solid wall: texture * dimmed RGB lighting — same as foreground
    // (matColor * lighting) but with 0.3 attenuation. Black without light.
    color = packedRGB * dimLighting;
  }

  return vec4<f32>(color, 1.0);
}
