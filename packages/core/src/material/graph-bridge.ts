import { GraphCompiler, MaterialGraph, type CompileOptions, type GraphNode, type ShaderGraphProfile } from "@downdraft/shader-graph";
import { BlendMode, CullMode, Material, type MaterialDefinition } from "./material";

export interface UINodeData {
  id: string;
  type: string;
  inputs: Array<{ id: string; name: string; type: string }>;
  outputs: Array<{ id: string; name: string; type: string }>;
  properties: Record<string, unknown>;
}

export interface UIConnection {
  id: string;
  fromNode: string;
  fromPort: string;
  toNode: string;
  toPort: string;
}

export interface GraphToMaterialOptions {
  name?: string;
  blendMode?: BlendMode;
  cullMode?: CullMode;
  profile?: ShaderGraphProfile;
  compileOptions?: CompileOptions;
}

export function uiGraphToMaterialGraph(nodes: UINodeData[], connections: UIConnection[]): MaterialGraph {
  const graph = new MaterialGraph();

  for (const node of nodes) {
    const graphNode: GraphNode = {
      id: node.id,
      type: node.type,
      inputs: {},
      outputs: {},
      properties: node.properties,
    };
    for (const inp of node.inputs) graphNode.inputs[inp.name] = inp.id;
    for (const out of node.outputs) graphNode.outputs[out.name] = out.id;
    graph.addNode(graphNode);
  }

  for (const conn of connections) {
    graph.connect(conn.fromNode, conn.fromPort, conn.toNode, conn.toPort);
  }

  return graph;
}

export function compileGraphToMaterial(
  graph: MaterialGraph,
  options: GraphToMaterialOptions = {},
): Material {
  const compiler = new GraphCompiler();
  const compileOpts: CompileOptions = options.compileOptions ?? {
    profile: options.profile,
  };
  const result = compiler.compileDetailed(graph, compileOpts);
  const wgsl = result.wgsl;

  const def: MaterialDefinition = {
    name: options.name ?? "graph_material",
    shader: "inline://graph",
    inlineShaderSource: wgsl,
    uniforms: {},
    textures: {
      albedoMap: { name: "albedoMap", binding: 1, sampler: "linear-repeat" },
    },
    blendMode: options.blendMode ?? BlendMode.Opaque,
    cullMode: options.cullMode ?? CullMode.Back,
    profile: options.profile?.name,
  };

  return new Material(def);
}

export function compileUIGraphToMaterial(
  nodes: UINodeData[],
  connections: UIConnection[],
  options: GraphToMaterialOptions = {},
): Material {
  const graph = uiGraphToMaterialGraph(nodes, connections);
  return compileGraphToMaterial(graph, options);
}
