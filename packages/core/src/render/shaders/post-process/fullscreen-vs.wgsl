struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
  var p = array<vec2<f32>, 3>(
    vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0),
  );
  var o: VertexOutput;
  o.clipPos = vec4(p[vi], 0.0, 1.0);
  o.uv = vec2(p[vi].x * 0.5 + 0.5, 0.5 - p[vi].y * 0.5);
  return o;
}
fn lum(c: vec3<f32>) -> f32 { return dot(c, vec3(0.299, 0.587, 0.114)); }
