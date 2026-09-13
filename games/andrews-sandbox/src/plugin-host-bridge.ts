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
    MaterialRegistry,
    PhysicsRegistry,
    ShaderRegistry,
} from "@downdraft/core";
import type { PostProcessStack } from "@downdraft/library-postfx";
import type { ContentRegistry } from "../../libraries/content/src/content-registry";

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
    async registerMesh(id, path, manifestId, meta) {
      const baseUrl = getBaseUrl(manifestId);
      const name = (meta?.name as string) ?? deriveName(path);
      const scale = (meta?.scale as number) ?? 1.0;
      const shape = (meta?.shape as string) ?? "box";
      const physics = (meta?.physics as any) ?? { mass: 1.0, restitution: 0.3, friction: 0.5, gravityScale: 1.0 };
      contentRegistry.register({
        id,
        name,
        category: "prop",
        modelUri: path ? `${baseUrl}/${path}` : "",
        pluginSource: manifestId,
        pack: manifestId,
        packLabel: manifestId,
        physics,
        scale,
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
  getBaseUrl: (manifestId: string) => string,
): ShaderRegistry {
  return {
    async registerPostfxEffect(id, name, wgslPath, manifestId, props) {
      if (!postProcessStack) {
        console.warn(`[PluginHost] Cannot register postfx effect "${id}" — no PostProcessStack`);
        return;
      }
      // Resolve the WGSL path relative to the mod directory.
      const baseUrl = getBaseUrl(manifestId);
      const cleanPath = wgslPath.replace(/^\.\//, "");
      const fullUrl = baseUrl ? `${baseUrl}/${cleanPath}` : cleanPath;
      const resp = await fetch(fullUrl);
      if (!resp.ok) {
        console.error(`[PluginHost] Failed to fetch shader "${id}" from ${fullUrl}: ${resp.status} ${resp.statusText}`);
        return;
      }
      const wgsl = await resp.text();
      postProcessStack.registerCustomEffect({
        id, name, wgsl, layout: "cc",
        order: (props.order as any) ?? "stylized",
        uniforms: props.uniforms as number | undefined,
        settings: (props as any).settings,
      });
      // Apply default setting values to the uniform buffer.
      const settings = (props as any).settings as Array<{ key: string; default: number | boolean | string; type: string }> | undefined;
      if (settings && props.uniforms) {
        const uniformData = new Float32Array(props.uniforms / 4);
        // Per-frame values (inv_w, inv_h, time) are at offsets 0-2 (set by renderer).
        // User settings start at offset 3.
        let offset = 3;
        for (const s of settings) {
          if (s.type === "slider" && typeof s.default === "number") {
            if (offset < uniformData.length) uniformData[offset++] = s.default;
          } else if (s.type === "toggle") {
            if (offset < uniformData.length) uniformData[offset++] = s.default ? 1 : 0;
          } else if (s.type === "select" && typeof s.default === "string") {
            const idx = (s as any).options?.findIndex((o: any) => o.value === s.default) ?? 0;
            if (offset < uniformData.length) uniformData[offset++] = idx;
          }
        }
        postProcessStack.setCustomEffectUniform(id, uniformData);
      }
      console.log(`[PluginHost] Registered postfx effect "${id}" from mod "${manifestId}"`);
    },
    async unregisterPostfxEffect(id) {
      postProcessStack?.unregisterCustomEffect(id);
    },
    async registerMaterialShader(id, wgslPath, manifestId, props) {
      const baseUrl = getBaseUrl(manifestId);
      const cleanPath = wgslPath.replace(/^\.\//, "");
      const fullUrl = baseUrl ? `${baseUrl}/${cleanPath}` : cleanPath;
      const resp = await fetch(fullUrl);
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
