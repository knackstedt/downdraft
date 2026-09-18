// ============================================================================
// MaterialNodes — Node type definitions for the Node Material Editor
// Maps to the existing shader-graph compiler node types in
// packages/engine/shader-graph/src/compiler.ts
// ============================================================================

(function (global) {
  "use strict";

  var MaterialNodes = {
    // ─── Input ──────────────────────────────────────────────────────

    uv: {
      label: "UV",
      category: "input",
      inputs: [],
      outputs: [{ name: "value", type: "vec2" }],
      properties: [],
    },

    normal: {
      label: "Normal",
      category: "input",
      inputs: [],
      outputs: [{ name: "value", type: "vec3" }],
      properties: [],
    },

    world_pos: {
      label: "World Position",
      category: "input",
      inputs: [],
      outputs: [{ name: "value", type: "vec3" }],
      properties: [],
    },

    camera_pos: {
      label: "Camera Position",
      category: "input",
      inputs: [],
      outputs: [{ name: "value", type: "vec3" }],
      properties: [],
    },

    time: {
      label: "Time",
      category: "input",
      inputs: [],
      outputs: [{ name: "value", type: "float" }],
      properties: [],
    },

    vertex_color: {
      label: "Vertex Color",
      category: "input",
      inputs: [],
      outputs: [{ name: "value", type: "vec4" }],
      properties: [],
    },

    // ─── Constants ──────────────────────────────────────────────────

    constant: {
      label: "Float Constant",
      category: "constant",
      inputs: [],
      outputs: [{ name: "value", type: "float" }],
      properties: [
        { name: "value", label: "Value", type: "float", default: 0.0 },
      ],
    },

    vec3_constant: {
      label: "Vec3 Constant",
      category: "constant",
      inputs: [],
      outputs: [{ name: "value", type: "vec3" }],
      properties: [
        { name: "value", label: "Value", type: "vec3", default: [0, 0, 0] },
      ],
    },

    vec4_constant: {
      label: "Vec4 Constant",
      category: "constant",
      inputs: [],
      outputs: [{ name: "value", type: "vec4" }],
      properties: [
        { name: "value", label: "Value", type: "vec4", default: [0, 0, 0, 1] },
      ],
    },

    color_picker: {
      label: "Color",
      category: "constant",
      inputs: [],
      outputs: [{ name: "value", type: "vec4" }],
      properties: [
        { name: "value", label: "Color", type: "color", default: [1, 1, 1, 1] },
      ],
    },

    // ─── Texture ────────────────────────────────────────────────────

    texture_sample: {
      label: "Texture Sample",
      category: "texture",
      inputs: [{ name: "uv", type: "vec2", optional: true }],
      outputs: [{ name: "value", type: "vec4" }],
      properties: [],
    },

    texture_sample_cube: {
      label: "Cubemap Sample",
      category: "texture",
      inputs: [{ name: "dir", type: "vec3", optional: true }],
      outputs: [{ name: "value", type: "vec4" }],
      properties: [],
    },

    // ─── Math ───────────────────────────────────────────────────────

    multiply: {
      label: "Multiply",
      category: "math",
      inputs: [
        { name: "a", type: "vec4", optional: true },
        { name: "b", type: "vec4", optional: true },
      ],
      outputs: [{ name: "value", type: "vec4" }],
      properties: [],
    },

    add: {
      label: "Add",
      category: "math",
      inputs: [
        { name: "a", type: "vec4", optional: true },
        { name: "b", type: "vec4", optional: true },
      ],
      outputs: [{ name: "value", type: "vec4" }],
      properties: [],
    },

    subtract: {
      label: "Subtract",
      category: "math",
      inputs: [
        { name: "a", type: "vec4", optional: true },
        { name: "b", type: "vec4", optional: true },
      ],
      outputs: [{ name: "value", type: "vec4" }],
      properties: [],
    },

    lerp: {
      label: "Lerp",
      category: "math",
      inputs: [
        { name: "a", type: "vec4", optional: true },
        { name: "b", type: "vec4", optional: true },
        { name: "t", type: "float", optional: true },
      ],
      outputs: [{ name: "value", type: "vec4" }],
      properties: [],
    },

    normalize: {
      label: "Normalize",
      category: "math",
      inputs: [{ name: "v", type: "vec3", optional: true }],
      outputs: [{ name: "value", type: "vec3" }],
      properties: [],
    },

    dot: {
      label: "Dot",
      category: "math",
      inputs: [
        { name: "a", type: "vec3", optional: true },
        { name: "b", type: "vec3", optional: true },
      ],
      outputs: [{ name: "value", type: "float" }],
      properties: [],
    },

    cross: {
      label: "Cross",
      category: "math",
      inputs: [
        { name: "a", type: "vec3", optional: true },
        { name: "b", type: "vec3", optional: true },
      ],
      outputs: [{ name: "value", type: "vec3" }],
      properties: [],
    },

    power: {
      label: "Power",
      category: "math",
      inputs: [
        { name: "base", type: "float", optional: true },
        { name: "exp", type: "float", optional: true },
      ],
      outputs: [{ name: "value", type: "float" }],
      properties: [],
    },

    saturate: {
      label: "Saturate",
      category: "math",
      inputs: [{ name: "v", type: "float", optional: true }],
      outputs: [{ name: "value", type: "float" }],
      properties: [],
    },

    max: {
      label: "Max",
      category: "math",
      inputs: [
        { name: "a", type: "float", optional: true },
        { name: "b", type: "float", optional: true },
      ],
      outputs: [{ name: "value", type: "float" }],
      properties: [],
    },

    min: {
      label: "Min",
      category: "math",
      inputs: [
        { name: "a", type: "float", optional: true },
        { name: "b", type: "float", optional: true },
      ],
      outputs: [{ name: "value", type: "float" }],
      properties: [],
    },

    abs: {
      label: "Abs",
      category: "math",
      inputs: [{ name: "v", type: "float", optional: true }],
      outputs: [{ name: "value", type: "float" }],
      properties: [],
    },

    sin: {
      label: "Sin",
      category: "math",
      inputs: [{ name: "v", type: "float", optional: true }],
      outputs: [{ name: "value", type: "float" }],
      properties: [],
    },

    cos: {
      label: "Cos",
      category: "math",
      inputs: [{ name: "v", type: "float", optional: true }],
      outputs: [{ name: "value", type: "float" }],
      properties: [],
    },

    fract: {
      label: "Fract",
      category: "math",
      inputs: [{ name: "v", type: "float", optional: true }],
      outputs: [{ name: "value", type: "float" }],
      properties: [],
    },

    floor: {
      label: "Floor",
      category: "math",
      inputs: [{ name: "v", type: "float", optional: true }],
      outputs: [{ name: "value", type: "float" }],
      properties: [],
    },

    smoothstep: {
      label: "Smoothstep",
      category: "math",
      inputs: [
        { name: "edge0", type: "float", optional: true },
        { name: "edge1", type: "float", optional: true },
        { name: "x", type: "float", optional: true },
      ],
      outputs: [{ name: "value", type: "float" }],
      properties: [],
    },

    mix3: {
      label: "Mix Vec3",
      category: "math",
      inputs: [
        { name: "a", type: "vec3", optional: true },
        { name: "b", type: "vec3", optional: true },
        { name: "t", type: "float", optional: true },
      ],
      outputs: [{ name: "value", type: "vec3" }],
      properties: [],
    },

    swizzle_xyz: {
      label: "Swizzle .xyz",
      category: "math",
      inputs: [{ name: "v", type: "vec4", optional: true }],
      outputs: [{ name: "value", type: "vec3" }],
      properties: [],
    },

    swizzle_rgb: {
      label: "Swizzle .rgb",
      category: "math",
      inputs: [{ name: "v", type: "vec4", optional: true }],
      outputs: [{ name: "value", type: "vec3" }],
      properties: [],
    },

    vec3_from_xy: {
      label: "Vec3 from XY",
      category: "math",
      inputs: [
        { name: "x", type: "float", optional: true },
        { name: "y", type: "float", optional: true },
        { name: "z", type: "float", optional: true },
      ],
      outputs: [{ name: "value", type: "vec3" }],
      properties: [],
    },

    vec4_from_xyzw: {
      label: "Vec4 from XYZW",
      category: "math",
      inputs: [
        { name: "x", type: "float", optional: true },
        { name: "y", type: "float", optional: true },
        { name: "z", type: "float", optional: true },
        { name: "w", type: "float", optional: true },
      ],
      outputs: [{ name: "value", type: "vec4" }],
      properties: [],
    },

    // ─── PBR ────────────────────────────────────────────────────────

    pbr_lighting: {
      label: "PBR Lighting",
      category: "pbr",
      inputs: [
        { name: "N", type: "vec3", optional: true },
        { name: "worldPos", type: "vec3", optional: true },
        { name: "baseColor", type: "vec3", optional: true },
        { name: "metallic", type: "float", optional: true },
        { name: "roughness", type: "float", optional: true },
      ],
      outputs: [{ name: "value", type: "vec3" }],
      properties: [],
    },

    pbr_params: {
      label: "PBR Params",
      category: "pbr",
      inputs: [],
      outputs: [{ name: "value", type: "vec4" }],
      properties: [],
    },

    metallic_roughness: {
      label: "Metallic/Roughness",
      category: "pbr",
      inputs: [],
      outputs: [{ name: "value", type: "vec2" }],
      properties: [
        { name: "metallic", label: "Metallic", type: "float", min: 0, max: 1, step: 0.01, default: 0.0 },
        { name: "roughness", label: "Roughness", type: "float", min: 0, max: 1, step: 0.01, default: 0.5 },
      ],
    },

    fresnel: {
      label: "Fresnel",
      category: "pbr",
      inputs: [
        { name: "N", type: "vec3", optional: true },
        { name: "V", type: "vec3", optional: true },
        { name: "power", type: "float", optional: true },
      ],
      outputs: [{ name: "value", type: "float" }],
      properties: [
        { name: "power", label: "Power", type: "float", min: 0.1, max: 10, step: 0.1, default: 5.0 },
      ],
    },

    // ─── Lighting ───────────────────────────────────────────────────

    dynamic_lights: {
      label: "Dynamic Lights",
      category: "lighting",
      inputs: [
        { name: "N", type: "vec3", optional: true },
        { name: "worldPos", type: "vec3", optional: true },
        { name: "baseColor", type: "vec3", optional: true },
      ],
      outputs: [{ name: "value", type: "vec3" }],
      properties: [],
    },

    // ─── Output ─────────────────────────────────────────────────────

    output_color: {
      label: "Output Color",
      category: "output",
      inputs: [{ name: "color", type: "vec4" }],
      outputs: [],
      properties: [],
    },

    output_world_pos: {
      label: "Output World Pos",
      category: "output",
      inputs: [{ name: "pos", type: "vec3" }],
      outputs: [],
      properties: [],
    },

    output_normal: {
      label: "Output Normal",
      category: "output",
      inputs: [{ name: "normal", type: "vec3" }],
      outputs: [],
      properties: [],
    },
  };

  // ─── Material templates (pre-built graphs) ──────────────────────────

  var MaterialTemplates = {
    "pbr_metal": {
      name: "PBR Metal",
      description: "Standard PBR with metallic surface",
      graph: {
        nodes: [
          { id: "n1", type: "uv", x: 50, y: 50, properties: {} },
          { id: "n2", type: "texture_sample", x: 250, y: 50, properties: {} },
          { id: "n3", type: "normal", x: 50, y: 200, properties: {} },
          { id: "n4", type: "world_pos", x: 50, y: 300, properties: {} },
          { id: "n5", type: "metallic_roughness", x: 250, y: 200, properties: { metallic: 1.0, roughness: 0.3 } },
          { id: "n6", type: "pbr_lighting", x: 500, y: 100, properties: {} },
          { id: "n7", type: "swizzle_rgb", x: 450, y: 50, properties: {} },
          { id: "n8", type: "vec4_from_xyzw", x: 750, y: 100, properties: {} },
          { id: "n9", type: "output_color", x: 950, y: 100, properties: {} },
        ],
        connections: [
          { fromNode: "n1", fromPort: "value", toNode: "n2", toPort: "uv" },
          { fromNode: "n2", fromPort: "value", toNode: "n7", toPort: "v" },
          { fromNode: "n3", fromPort: "value", toNode: "n6", toPort: "N" },
          { fromNode: "n4", fromPort: "value", toNode: "n6", toPort: "worldPos" },
          { fromNode: "n7", fromPort: "value", toNode: "n6", toPort: "baseColor" },
          { fromNode: "n6", fromPort: "value", toNode: "n8", toPort: "x" },
          { fromNode: "n8", fromPort: "value", toNode: "n9", toPort: "color" },
        ],
      },
    },
    "unlit_color": {
      name: "Unlit Color",
      description: "Simple unlit color output",
      graph: {
        nodes: [
          { id: "n1", type: "color_picker", x: 100, y: 100, properties: { value: [0.8, 0.6, 0.2, 1.0] } },
          { id: "n2", type: "output_color", x: 400, y: 100, properties: {} },
        ],
        connections: [
          { fromNode: "n1", fromPort: "value", toNode: "n2", toPort: "color" },
        ],
      },
    },
    "pbr_textured": {
      name: "PBR Textured",
      description: "PBR with albedo texture and normal map",
      graph: {
        nodes: [
          { id: "n1", type: "uv", x: 50, y: 50, properties: {} },
          { id: "n2", type: "texture_sample", x: 250, y: 50, properties: {} },
          { id: "n3", type: "normal", x: 50, y: 200, properties: {} },
          { id: "n4", type: "world_pos", x: 50, y: 300, properties: {} },
          { id: "n5", type: "metallic_roughness", x: 250, y: 200, properties: { metallic: 0.0, roughness: 0.7 } },
          { id: "n6", type: "pbr_lighting", x: 500, y: 100, properties: {} },
          { id: "n7", type: "swizzle_rgb", x: 450, y: 50, properties: {} },
          { id: "n8", type: "vec4_from_xyzw", x: 750, y: 100, properties: {} },
          { id: "n9", type: "output_color", x: 950, y: 100, properties: {} },
        ],
        connections: [
          { fromNode: "n1", fromPort: "value", toNode: "n2", toPort: "uv" },
          { fromNode: "n2", fromPort: "value", toNode: "n7", toPort: "v" },
          { fromNode: "n3", fromPort: "value", toNode: "n6", toPort: "N" },
          { fromNode: "n4", fromPort: "value", toNode: "n6", toPort: "worldPos" },
          { fromNode: "n7", fromPort: "value", toNode: "n6", toPort: "baseColor" },
          { fromNode: "n6", fromPort: "value", toNode: "n8", toPort: "x" },
          { fromNode: "n8", fromPort: "value", toNode: "n9", toPort: "color" },
        ],
      },
    },
  };

  global.MaterialNodes = MaterialNodes;
  global.MaterialTemplates = MaterialTemplates;
})(typeof window !== "undefined" ? window : this);
