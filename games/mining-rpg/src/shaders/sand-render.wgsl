struct Uniforms {
  gridW: f32,
  gridH: f32,
  time: f32,
  pad: f32,
};

struct CameraUniforms {
  // Camera center in active-grid cell coords
  camX: f32,
  camY: f32,
  // Zoom factor (1 = 1 cell per pixel, >1 = zoomed in)
  zoom: f32,
  // Canvas dimensions in pixels
  canvasW: f32,
  canvasH: f32,
  pad0: f32,
  pad1: f32,
};

@group(0) @binding(0) var gridTex: texture_2d<u32>;
@group(0) @binding(1) var paletteTex: texture_2d<f32>;
@group(0) @binding(2) var propsTex: texture_2d<f32>;
@group(0) @binding(3) var behindTex: texture_2d<f32>;
@group(0) @binding(4) var<uniform> u: Uniforms;
@group(0) @binding(5) var<uniform> cam: CameraUniforms;

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  // uv is 0..1 across the fullscreen quad (uv.y=0 at top, uv.y=1 at bottom).
  // Convert to active-grid cell coords using the camera position and zoom.
  // Screen pixel coords (0..canvasW, 0..canvasH), origin at top-left.
  let screenPx = vec2<f32>(uv.x * cam.canvasW, uv.y * cam.canvasH);
  // World cell coords: center the camera, scale by zoom
  let cellX = (screenPx.x - cam.canvasW * 0.5) / cam.zoom + cam.camX;
  let cellY = (screenPx.y - cam.canvasH * 0.5) / cam.zoom + cam.camY;

  let coords = vec2<i32>(i32(cellX), i32(cellY));
  if (coords.x < 0 || coords.x >= i32(u.gridW) || coords.y < 0 || coords.y >= i32(u.gridH)) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }

  let packed = textureLoad(gridTex, coords, 0).r;
  let matId = packed & 0xffu;
  let lifetime = f32((packed >> 8u) & 0xffu) / 255.0;
  let shade = (packed >> 16u) & 0x03u;

  if (matId == 0u) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }

  let palIdx = i32(matId) * 4 + i32(shade);
  let matColor = textureLoad(paletteTex, vec2<i32>(palIdx, 0), 0);

  let props = textureLoad(propsTex, vec2<i32>(i32(matId), 0), 0);
  let brightness = props.b;

  var alpha = matColor.a;
  if (matId == 5u || matId == 50u || matId == 51u) {
    alpha = alpha * (0.85 + 0.15 * lifetime);
  } else if (matId == 6u || matId == 11u || matId == 21u ||
      matId == 22u || matId == 39u) {
    alpha = alpha * (0.4 + 0.6 * lifetime);
  }
  if (matId == 22u) {
    alpha = alpha * 0.15;
  }
  if (matId == 27u) {
    let flicker = 0.5 + 0.5 * sin(u.time * 5.0 + f32(coords.x) * 0.5 + f32(coords.y) * 0.3);
    alpha = alpha * flicker;
  }

  let finalColor = matColor.rgb * brightness;
  return vec4<f32>(finalColor, alpha);
}
