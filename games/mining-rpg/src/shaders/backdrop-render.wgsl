struct Uniforms {
  gridW: f32,
  gridH: f32,
  time: f32,
  pad: f32,
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

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  // uv is 0..1 across the fullscreen quad.
  // Convert to screen pixel coords.
  let screenPx = vec2<f32>(uv.x * cam.canvasW, uv.y * cam.canvasH);

  // The camera position (cam.camX/cam.camY) is already in backdrop-local
  // cell coords — the renderer computed it as:
  //   worldCam * parallax * 0.5 - backdropOrigin
  // The screen offset (distance from camera center) still needs parallax
  // and half-res scaling to convert from foreground pixels to backdrop cells.
  let cellX = (screenPx.x - cam.canvasW * 0.5) / cam.zoom * cam.parallax * 0.5 + cam.camX;
  let cellY = (screenPx.y - cam.canvasH * 0.5) / cam.zoom * cam.parallax * 0.5 + cam.camY;

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

  // Sample the light accumulation texture (half-res)
  let lightCoords = vec2<i32>(coords.x / 2, coords.y / 2);
  let lightSample = textureLoad(lightTex, lightCoords, 0);
  let lighting = lightSample.rgb;

  return vec4<f32>(r * lighting.r, g * lighting.g, b * lighting.b, 1.0);
}
