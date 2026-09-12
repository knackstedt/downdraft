// ============================================================================
// Extension loaders — bucket-specific loaders for declarative mod extensions.
//
// Each `ExtensionLoader` handles one bucket ("assets" | "maps" | "physics" |
// "shader-postfx" | "shader-material") and registers the extension's data into
// the appropriate game registry. The registries are injected by the game (via
// `ExtensionLoaderHost`) so the engine plugin system stays game-agnostic.
//
// Phase 3 implements asset/map/physics loaders. Shader loaders are added in
// Phase 4 (they depend on PostProcessStack + MaterialRegistry).
// ============================================================================

import type { ExtensionLoader } from "./host";
import type { PluginManifest, ModAssetExtension, ModMapExtension, ModPhysicsExtension } from "./manifest";

// ── Registry interfaces (game-implemented) ──
//
// The game injects these when wiring the PluginHost. Each loader calls the
// registry to register/unregister extension data. The dispose fn returned
// by `load` unregisters the data on unload.

/** Asset registry — registers meshes, textures, PBR materials, texture pipelines. */
export interface AssetRegistry {
  registerMesh(id: string, path: string, manifestId: string): Promise<void>;
  unregisterMesh(id: string): Promise<void>;
  registerTexture(id: string, path: string, manifestId: string): Promise<void>;
  unregisterTexture(id: string): Promise<void>;
  registerPBRMaterial(id: string, path: string, manifestId: string, props: Record<string, unknown>): Promise<void>;
  unregisterPBRMaterial(id: string): Promise<void>;
  registerTexturePipeline(id: string, path: string, manifestId: string, props: Record<string, unknown>): Promise<void>;
  unregisterTexturePipeline(id: string): Promise<void>;
}

/** Map registry — registers scene graphs. */
export interface MapRegistry {
  registerMap(id: string, path: string, manifestId: string): Promise<void>;
  unregisterMap(id: string): Promise<void>;
}

/** Physics registry — registers physics override descriptors. */
export interface PhysicsRegistry {
  registerPhysicsOverride(id: string, path: string, manifestId: string): Promise<void>;
  unregisterPhysicsOverride(id: string): Promise<void>;
}

/** Shader registry — registers postfx + material shaders (Phase 4). */
export interface ShaderRegistry {
  registerPostfxEffect(id: string, name: string, wgslPath: string, manifestId: string, props: Record<string, unknown>): Promise<void>;
  unregisterPostfxEffect(id: string): Promise<void>;
  registerMaterialShader(id: string, wgslPath: string, manifestId: string, props: Record<string, unknown>): Promise<void>;
  unregisterMaterialShader(id: string): Promise<void>;
}

/** The host for extension loaders — holds the injected registries. */
export interface ExtensionLoaderHost {
  assets?: AssetRegistry;
  maps?: MapRegistry;
  physics?: PhysicsRegistry;
  shaders?: ShaderRegistry;
}

// ── Asset extension loader ──

/** Create an ExtensionLoader for the "assets" bucket. */
export function createAssetLoader(registry: AssetRegistry): ExtensionLoader {
  return {
    bucket: "assets",
    async load(manifest, ext) {
      const a = ext as unknown as ModAssetExtension;
      const manifestId = manifest.id;
      const id = a.id;
      switch (a.kind) {
        case "mesh":
          await registry.registerMesh(id, a.path, manifestId);
          return () => { registry.unregisterMesh(id); };
        case "texture":
          await registry.registerTexture(id, a.path, manifestId);
          return () => { registry.unregisterTexture(id); };
        case "pbr-material":
          await registry.registerPBRMaterial(id, a.path, manifestId, a);
          return () => { registry.unregisterPBRMaterial(id); };
        case "texture-pipeline":
          await registry.registerTexturePipeline(id, a.path, manifestId, a);
          return () => { registry.unregisterTexturePipeline(id); };
        default:
          throw new Error(`Unknown asset kind: ${(a as any).kind}`);
      }
    },
  };
}

// ── Map extension loader ──

/** Create an ExtensionLoader for the "maps" bucket. */
export function createMapLoader(registry: MapRegistry): ExtensionLoader {
  return {
    bucket: "maps",
    async load(manifest, ext) {
      const m = ext as unknown as ModMapExtension;
      await registry.registerMap(m.id, m.path, manifest.id);
      return () => { registry.unregisterMap(m.id); };
    },
  };
}

// ── Physics extension loader ──

/** Create an ExtensionLoader for the "physics" bucket. */
export function createPhysicsLoader(registry: PhysicsRegistry): ExtensionLoader {
  return {
    bucket: "physics",
    async load(manifest, ext) {
      const p = ext as unknown as ModPhysicsExtension;
      await registry.registerPhysicsOverride(p.id, p.path, manifest.id);
      return () => { registry.unregisterPhysicsOverride(p.id); };
    },
  };
}

// ── Shader extension loaders (Phase 4 stubs) ──
//
// These are thin wrappers that forward to the ShaderRegistry. The actual
// PostProcessStack + MaterialRegistry integration is implemented in Phase 4.

/** Create an ExtensionLoader for the "shader-postfx" bucket. */
export function createPostfxShaderLoader(registry: ShaderRegistry): ExtensionLoader {
  return {
    bucket: "shader-postfx",
    async load(manifest, ext) {
      const fx = ext as unknown as {
        id: string; name: string; wgsl: string; layout: string; order: string; uniforms?: number;
      };
      await registry.registerPostfxEffect(fx.id, fx.name, fx.wgsl, manifest.id, {
        layout: fx.layout, order: fx.order, uniforms: fx.uniforms,
      });
      return () => { registry.unregisterPostfxEffect(fx.id); };
    },
  };
}

/** Create an ExtensionLoader for the "shader-material" bucket. */
export function createMaterialShaderLoader(registry: ShaderRegistry): ExtensionLoader {
  return {
    bucket: "shader-material",
    async load(manifest, ext) {
      const mat = ext as unknown as { id: string; wgsl: string; uniforms?: number };
      await registry.registerMaterialShader(mat.id, mat.wgsl, manifest.id, {
        uniforms: mat.uniforms,
      });
      return () => { registry.unregisterMaterialShader(mat.id); };
    },
  };
}

// ── Convenience: register all loaders from an ExtensionLoaderHost ──

/** Register all available extension loaders (based on which registries are
 *  present on the host) onto a PluginHost. */
export function registerAllExtensionLoaders(
  register: (loader: ExtensionLoader) => void,
  host: ExtensionLoaderHost,
): void {
  if (host.assets) register(createAssetLoader(host.assets));
  if (host.maps) register(createMapLoader(host.maps));
  if (host.physics) register(createPhysicsLoader(host.physics));
  if (host.shaders) {
    register(createPostfxShaderLoader(host.shaders));
    register(createMaterialShaderLoader(host.shaders));
  }
}
