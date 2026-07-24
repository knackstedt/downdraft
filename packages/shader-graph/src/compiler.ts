import type { MaterialGraph } from "./graph.ts";

export class GraphCompiler {
  compile(graph: MaterialGraph): string {
    const nodes = graph.getNodes();
    const connections = graph.getConnections();

    const lines: string[] = [
      "// Auto-generated WGSL from material graph",
      "",
      "struct VertexInput {",
      "  @location(0) position: vec3<f32>,",
      "  @location(1) normal: vec3<f32>,",
      "  @location(2) uv: vec2<f32>,",
      "};",
      "",
      "struct VertexOutput {",
      "  @builtin(position) clipPosition: vec4<f32>,",
      "  @location(0) uv: vec2<f32>,",
      "};",
      "",
      "@vertex",
      "fn vs_main(input: VertexInput) -> VertexOutput {",
      "  var output: VertexOutput;",
      "  output.clipPosition = vec4<f32>(input.position, 1.0);",
      "  output.uv = input.uv;",
      "  return output;",
      "}",
      "",
      "@fragment",
      "fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {",
      "  return vec4<f32>(1.0);",
      "}",
    ];

    return lines.join("\n");
  }
}
