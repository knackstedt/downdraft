struct Uniforms {
  gridW: f32,
  gridH: f32,
  time: f32,
  pad: f32,
};

struct CameraUniforms {
  // Camera center in active-grid cell coords (foreground space)
  camX: f32,
  camY: f32,
  // Zoom factor (1 = 1 cell per pixel, >1 = zoomed in)
  zoom: f32,
  // Canvas dimensions in pixels
  canvasW: f32,
  canvasH: f32,
  // Parallax factor (camera offset is multiplied by this)
  parallax: f32,
  pad1: f32,
};

@group(0) @binding(0) var gridTex: texture_2d<u32>;
@group(0) @binding(1) var<uniform> u: Uniforms;
@group(0) @binding(2) var<uniform> cam: CameraUniforms;

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  // uv is 0..1 across the fullscreen quad.
  // Convert to screen pixel coords.
  let screenPx = vec2<f32>(uv.x * cam.canvasW, uv.y * cam.canvasH);

  // The backdrop is at half resolution, so each backdrop cell covers 2x2
  // foreground cells. The camera position is in foreground cell coords.
  // Apply parallax: the backdrop scrolls slower by the parallax factor.
  // Since the backdrop grid is half-res, we also divide by 2 to convert
  // foreground cell coords → backdrop cell coords.
  let cellX = (screenPx.x - cam.canvasW * 0.5) / cam.zoom * cam.parallax * 0.5 + cam.camX * cam.parallax * 0.5;
  let cellY = (screenPx.y - cam.canvasH * 0.5) / cam.zoom * cam.parallax * 0.5 + cam.camY * cam.parallax * 0.5;

  let coords = vec2<i32>(i32(cellX), i32(cellY));
  if (coords.x < 0 || coords.x >= i32(u.gridW) || coords.y < 0 || coords.y >= i32(u.gridH)) {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }

  let packed = textureLoad(gridTex, coords, 0).r;
  // Packed RGBA: r | (g << 8) | (b << 16) | (a << 24)
  let r = f32(packed & 0xffu) / 255.0;
  let g = f32((packed >> 8u) & 0xffu) / 255.0;
  let b = f32((packed >> 16u) & 0xffu) / 255.0;
  let a = f32((packed >> 24u) & 0xffu) / 255.0;

  return vec4<f32>(r, g, b, 1.0);
}
