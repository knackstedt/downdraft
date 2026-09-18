// Occluder chunk — prepended to all postfx fragment shaders by makePipeline().
// Provides the OccluderUniform struct, a group(1) binding, and an isOccluded()
// test. Each shader's fs_main calls `if (isOccluded(input.uv)) { discard; }`
// at the top to skip work under opaque UI panels (the pixi-ui overlay composites
// on top of the game canvas, so the game's output under an opaque panel is
// never seen by the user).
//
// Rects are in UV space (0-1, top-left origin matching fullscreen-vs.wgsl).
// Up to 8 rects supported; count=0 disables occlusion (isOccluded always false).
struct OccluderUniform {
  count: f32,
  _p0: f32,
  _p1: f32,
  _p2: f32,
  rects: array<vec4<f32>, 8>,  // x, y, w, h in UV space (0-1)
};
@group(1) @binding(0) var<uniform> occluders: OccluderUniform;

fn isOccluded(uv: vec2<f32>) -> bool {
  for (var i = 0u; i < 8u; i = i + 1u) {
    if (f32(i) >= occluders.count) { break; }
    let r = occluders.rects[i];
    if (uv.x >= r.x && uv.x <= r.x + r.z && uv.y >= r.y && uv.y <= r.y + r.w) {
      return true;
    }
  }
  return false;
}
