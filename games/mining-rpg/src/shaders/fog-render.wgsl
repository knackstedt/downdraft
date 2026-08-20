// Fog-of-war overlay fragment shader.
// Samples the explored grid texture (r8unorm: 0=unexplored, 1=explored)
// and renders a black overlay with GRADIENT opacity over unexplored cells.
// Explored cells are fully transparent (alpha=0).
//
// The gradient is created by sampling a neighborhood of cells and averaging
// the explored values. This produces a smooth fade at the exploration frontier
// instead of a hard cliff.

struct Uniforms {
  gridW: f32,
  gridH: f32,
  pad0: f32,
  pad1: f32,
};

struct CameraUniforms {
  camX: f32,
  camY: f32,
  zoom: f32,
  canvasW: f32,
  canvasH: f32,
  depth: f32,
  pad1: f32,
};

@group(0) @binding(0) var exploredTex: texture_2d<f32>;
@group(0) @binding(1) var<uniform> u: Uniforms;
@group(0) @binding(2) var<uniform> cam: CameraUniforms;

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  // Convert screen UV to active-grid cell coords (same as sand-render.wgsl)
  let screenPx = vec2<f32>(uv.x * cam.canvasW, uv.y * cam.canvasH);
  let cellX = (screenPx.x - cam.canvasW * 0.5) / cam.zoom + cam.camX;
  let cellY = (screenPx.y - cam.canvasH * 0.5) / cam.zoom + cam.camY;

  let coords = vec2<i32>(i32(cellX), i32(cellY));
  if (coords.x < 0 || coords.x >= i32(u.gridW) || coords.y < 0 || coords.y >= i32(u.gridH)) {
    // Out of bounds = unexplored (solid black)
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }

  // Sample a neighborhood of cells and average the explored values.
  // The blur radius scales with zoom so the gradient is visible at any zoom.
  // At high zoom (close), use a small radius (sharp edge). At low zoom (far),
  // use a larger radius (wider gradient).
  let blurRadius = i32(clamp(3.0 / cam.zoom, 1.0, 6.0));

  var sum = 0.0;
  var count = 0.0;
  for (var dy = -blurRadius; dy <= blurRadius; dy++) {
    for (var dx = -blurRadius; dx <= blurRadius; dx++) {
      let sx = coords.x + dx;
      let sy = coords.y + dy;
      if (sx < 0 || sx >= i32(u.gridW) || sy < 0 || sy >= i32(u.gridH)) {
        // Out of bounds counts as unexplored (0)
        count += 1.0;
      } else {
        sum += textureLoad(exploredTex, vec2<i32>(sx, sy), 0).r;
        count += 1.0;
      }
    }
  }
  let avgExplored = sum / count;

  // Alpha = 1 - avgExplored (unexplored = opaque black, explored = transparent)
  // Use a smoothstep for a softer transition
  let alpha = 1.0 - smoothstep(0.3, 0.7, avgExplored);
  return vec4<f32>(0.0, 0.0, 0.0, alpha);
}
