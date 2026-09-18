import { GraphCompiler, MaterialGraph, getProfile, type CompileOptions, type GraphNode, type ShaderGraphProfile } from "@downdraft/engine/shader-graph";
import { BlendMode, CullMode, Material, type MaterialDefinition } from "./material";
import { DEFAULT_VARIANT_FLAGS, variantKey, withVariant, type MaterialVariantFlags } from "./variants";

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

/**
 * Compile a graph into a Material that retains the source graph (for editor
 * round-tripping + variant recompilation). The base variant WGSL is compiled
 * immediately; additional variants are compiled lazily via compileVariant.
 */
export function compileGraphToMaterialWithGraph(
  graph: MaterialGraph,
  options: GraphToMaterialOptions = {},
  variantFlags?: MaterialVariantFlags,
): Material {
  const compiler = new GraphCompiler();
  const compileOpts: CompileOptions = options.compileOptions ?? { profile: options.profile };
  const result = compiler.compileDetailed(graph, compileOpts);

  const def: MaterialDefinition = {
    name: options.name ?? "graph_material",
    shader: "inline://graph",
    inlineShaderSource: result.wgsl,
    graph,
    uniforms: {},
    textures: {
      albedoMap: { name: "albedoMap", binding: 1, sampler: "linear-repeat" },
    },
    blendMode: options.blendMode ?? BlendMode.Opaque,
    cullMode: options.cullMode ?? CullMode.Back,
    profile: options.profile?.name,
    variantFlags: variantFlags ?? { ...DEFAULT_VARIANT_FLAGS },
  };

  const material = new Material(def);
  material.compiledVariants.set(variantKey(material.variantFlags), result.wgsl);
  return material;
}

/**
 * Compile (or return cached) WGSL for a specific variant of a graph material.
 * Used by the renderer to fetch permutation WGSL keyed on variant flags.
 */
export function compileVariant(
  material: Material,
  flags: MaterialVariantFlags,
  profile?: ShaderGraphProfile,
): string {
  const key = variantKey(flags);
  const cached = material.compiledVariants.get(key);
  if (cached) return cached;

  if (!material.graph) {
    // Non-graph materials reuse their inlineShaderSource for all variants.
    const wgsl = material.inlineShaderSource ?? "";
    material.compiledVariants.set(key, wgsl);
    return wgsl;
  }

  const compiler = new GraphCompiler();
  const resolvedProfile = profile ?? (material.profile ? getProfile(material.profile) : undefined);
  const result = compiler.compileDetailed(material.graph, {
    profile: resolvedProfile,
    variantFlags: flags,
  });
  material.compiledVariants.set(key, result.wgsl);
  return result.wgsl;
}

/**
 * Enumerate the compile-time permutations for a material's variant flag space.
 * Returns the list of flag sets to precompile (e.g. for warm-up).
 */
export function enumerateVariants(base: MaterialVariantFlags): MaterialVariantFlags[] {
  const out: MaterialVariantFlags[] = [];
  for (const sc of [false, true]) {
    for (const sk of [false, true]) {
      for (const am of ["opaque", "clip", "blend"] as const) {
        for (const mo of [false, true]) {
          for (const in_ of [false, true]) {
            out.push(withVariant(base, {
              shadowCaster: sc, skinning: sk, alphaMode: am, morph: mo, instanced: in_,
            }));
          }
        }
      }
    }
  }
  return out;
}
