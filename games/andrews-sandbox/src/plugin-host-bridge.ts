// ============================================================================
// PluginHost bridge — adapts the sandbox's ContentRegistry to the engine's
// PluginHost extension loader interfaces.
//
// This bridge replaces the direct PluginScanner → ContentRegistry wiring in
// main.tsx. The PluginHost discovers mod.json/plugin.json manifests, validates
// them, and dispatches extensions to the appropriate loaders. The asset
// loader bridges into ContentRegistry; the shader loaders bridge into
// PostProcessStack + MaterialRegistry.
// ============================================================================

import type {
  AssetRegistry,
  MapRegistry,
  PhysicsRegistry,
  ShaderRegistry,
} from "@downdraft/core";
import type { PostProcessStack } from "@downdraft/library-postfx";
import type { ContentRegistry, ContentEntry } from "../../libraries/content/src/content-registry";
import type { MaterialRegistry } from "@downdraft/core";

/** Adapt ContentRegistry → AssetRegistry for the PluginHost extension loader. */
export function createContentRegistryAssetBridge(
  contentRegistry: ContentRegistry,
  getBaseUrl: (manifestId: string) => string,
): AssetRegistry {
  const deriveName = (path: string): string => {
    const parts = path.split("/");
    return parts[parts.length - 1].replace(/\.[^.]+$/, "");
  };
  return {
    async registerMesh(id, path, manifestId) {
      const baseUrl = getBaseUrl(manifestId);
      contentRegistry.register({
        id,
        name: deriveName(path),
        category: "prop",
        modelUri: `${baseUrl}/${path}`,
        pluginSource: manifestId,
        pack: manifestId,
        packLabel: manifestId,
        physics: { mass: 1.0, restitution: 0.3, friction: 0.5, gravityScale: 1.0 },
        scale: 1.0,
        paintable: true,
      });
    },
    async unregisterMesh(id) { contentRegistry.remove(id); },
    async registerTexture(id, path, manifestId) {
      const baseUrl = getBaseUrl(manifestId);
      contentRegistry.register({
        id,
        name: deriveName(path),
        category: "texture",
        thumbnailUri: `${baseUrl}/${path}`,
        pluginSource: manifestId,
        pack: manifestId,
        packLabel: manifestId,
        physics: { mass: 1.0, restitution: 0.3, friction: 0.5, gravityScale: 1.0 },
        scale: 1.0,
        paintable: true,
      });
    },
    async unregisterTexture(id) { contentRegistry.remove(id); },
    async registerPBRMaterial(id, _path, manifestId, props) {
      contentRegistry.register({
        id,
        name: deriveName(id),
        category: "material",
        pluginSource: manifestId,
        pack: manifestId,
        packLabel: manifestId,
        physics: { mass: 1.0, restitution: 0.3, friction: 0.5, gravityScale: 1.0 },
        scale: 1.0,
        paintable: false,
      });
    },
    async unregisterPBRMaterial(id) { contentRegistry.remove(id); },
    async registerTexturePipeline(id, _path, manifestId, _props) {
      contentRegistry.register({
        id,
        name: deriveName(id),
        category: "pipeline",
        pluginSource: manifestId,
        pack: manifestId,
        packLabel: manifestId,
        physics: { mass: 1.0, restitution: 0.3, friction: 0.5, gravityScale: 1.0 },
        scale: 1.0,
        paintable: false,
      });
    },
    async unregisterTexturePipeline(id) { contentRegistry.remove(id); },
  };
}

/** Adapt PostProcessStack + MaterialRegistry → ShaderRegistry. */
export function createShaderBridge(
  postProcessStack: PostProcessStack | null,
  materialRegistry: MaterialRegistry,
): ShaderRegistry {
  return {
    async registerPostfxEffect(id, name, wgslPath, manifestId, props) {
      if (!postProcessStack) {
        console.warn(`[PluginHost] Cannot register postfx effect "${id}" — no PostProcessStack`);
        return;
      }
      // Fetch the WGSL source (wgslPath is relative to the mod dir).
      const resp = await fetch(wgslPath);
      const wgsl = await resp.text();
      postProcessStack.registerCustomEffect({
        id, name, wgsl, layout: "cc",
        order: (props.order as any) ?? "stylized",
        uniforms: props.uniforms as number | undefined,
      });
      console.log(`[PluginHost] Registered postfx effect "${id}" from mod "${manifestId}"`);
    },
    async unregisterPostfxEffect(id) {
      postProcessStack?.unregisterCustomEffect(id);
    },
    async registerMaterialShader(id, wgslPath, manifestId, props) {
      const resp = await fetch(wgslPath);
      const wgsl = await resp.text();
      materialRegistry.register({
        id, wgsl, manifestId,
        uniforms: props.uniforms as number | undefined,
        props,
      });
      console.log(`[PluginHost] Registered material shader "${id}" from mod "${manifestId}"`);
    },
    async unregisterMaterialShader(id) {
      materialRegistry.unregister(id);
    },
  };
}

/** A no-op MapRegistry for the sandbox (maps not yet supported in the sandbox). */
export function createNoopMapRegistry(): MapRegistry {
  return {
    async registerMap(id, _path, manifestId) {
      console.log(`[PluginHost] Map "${id}" from mod "${manifestId}" registered (noop)`);
    },
    async unregisterMap(_id) { /* noop */ },
  };
}

/** A no-op PhysicsRegistry for the sandbox (physics overrides not yet wired). */
export function createNoopPhysicsRegistry(): PhysicsRegistry {
  return {
    async registerPhysicsOverride(id, _path, manifestId) {
      console.log(`[PluginHost] Physics override "${id}" from mod "${manifestId}" registered (noop)`);
    },
    async unregisterPhysicsOverride(_id) { /* noop */ },
  };
}
