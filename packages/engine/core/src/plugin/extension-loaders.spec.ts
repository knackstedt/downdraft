// Tests for the extension loaders (asset/map/physics/shader).
//
// Each loader is tested with a fake registry that records register/unregister
// calls. The tests verify:
//   - Correct registry method is called with the right args
//   - The dispose fn calls the unregister method
//   - Unknown asset kinds throw
//   - All 5 buckets are covered

import { World } from "../ecs/world";
import { setStrict } from "../module/diagnostics";
import { ModuleHost } from "../module/host";
import {
    createAssetLoader,
    createMapLoader,
    createMaterialShaderLoader,
    createPhysicsLoader,
    createPostfxShaderLoader,
    type AssetRegistry,
    type MapRegistry,
    type PhysicsRegistry,
    type ShaderRegistry,
} from "./extension-loaders";
import { PluginHost } from "./host";
import type { PluginManifest } from "./manifest";

function modManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "test-mod",
    name: "Test Mod",
    version: "1.0.0",
    engineVersion: "^0.1.0",
    game: "test-game",
    format: "worker-js",
    tier: "native",
    thread: "sim",
    entry: "./irrelevant",
    permissions: ["ecs", "events"],
    ...overrides,
  };
}

/** Fake asset registry that records calls. */
function fakeAssetRegistry(): AssetRegistry & {
  meshes: Array<{ id: string; path: string; manifestId: string }>;
  textures: Array<{ id: string; path: string; manifestId: string }>;
  pbrMaterials: Array<{ id: string; path: string; manifestId: string; props: Record<string, unknown> }>;
  pipelines: Array<{ id: string; path: string; manifestId: string; props: Record<string, unknown> }>;
  unregistered: string[];
} {
  return {
    meshes: [], textures: [], pbrMaterials: [], pipelines: [], unregistered: [],
    async registerMesh(id: string, path: string, manifestId: string) { this.meshes.push({ id, path, manifestId }); },
    async unregisterMesh(id: string) { this.unregistered.push(`mesh:${id}`); },
    async registerTexture(id: string, path: string, manifestId: string) { this.textures.push({ id, path, manifestId }); },
    async unregisterTexture(id: string) { this.unregistered.push(`texture:${id}`); },
    async registerPBRMaterial(id: string, path: string, manifestId: string, props: Record<string, unknown>) { this.pbrMaterials.push({ id, path, manifestId, props }); },
    async unregisterPBRMaterial(id: string) { this.unregistered.push(`pbr:${id}`); },
    async registerTexturePipeline(id: string, path: string, manifestId: string, props: Record<string, unknown>) { this.pipelines.push({ id, path, manifestId, props }); },
    async unregisterTexturePipeline(id: string) { this.unregistered.push(`pipeline:${id}`); },
  } as any;
}

function fakeMapRegistry(): MapRegistry & {
  maps: Array<{ id: string; path: string; manifestId: string }>;
  unregistered: string[];
} {
  return {
    maps: [], unregistered: [],
    async registerMap(id: string, path: string, manifestId: string) { this.maps.push({ id, path, manifestId }); },
    async unregisterMap(id: string) { this.unregistered.push(`map:${id}`); },
  } as any;
}

function fakePhysicsRegistry(): PhysicsRegistry & {
  overrides: Array<{ id: string; path: string; manifestId: string }>;
  unregistered: string[];
} {
  return {
    overrides: [], unregistered: [],
    async registerPhysicsOverride(id: string, path: string, manifestId: string) { this.overrides.push({ id, path, manifestId }); },
    async unregisterPhysicsOverride(id: string) { this.unregistered.push(`phys:${id}`); },
  } as any;
}

function fakeShaderRegistry(): ShaderRegistry & {
  postfx: Array<{ id: string; name: string; wgslPath: string; manifestId: string; props: Record<string, unknown> }>;
  materials: Array<{ id: string; wgslPath: string; manifestId: string; props: Record<string, unknown> }>;
  unregistered: string[];
} {
  return {
    postfx: [], materials: [], unregistered: [],
    async registerPostfxEffect(id: string, name: string, wgslPath: string, manifestId: string, props: Record<string, unknown>) { this.postfx.push({ id, name, wgslPath, manifestId, props }); },
    async unregisterPostfxEffect(id: string) { this.unregistered.push(`postfx:${id}`); },
    async registerMaterialShader(id: string, wgslPath: string, manifestId: string, props: Record<string, unknown>) { this.materials.push({ id, wgslPath, manifestId, props }); },
    async unregisterMaterialShader(id: string) { this.unregistered.push(`material:${id}`); },
  } as any;
}

describe("extension loaders", () => {
  beforeAll(() => setStrict(false));
  afterAll(() => setStrict(null));

  // ── Asset loader ──

  it("asset loader registers a mesh and disposes it", async () => {
    const reg = fakeAssetRegistry();
    const loader = createAssetLoader(reg);
    const dispose = await loader.load(
      modManifest(),
      { kind: "mesh", id: "mod:crate", path: "./crate.glb" } as any,
      {} as any,
    );
    expect(reg.meshes).toEqual([{ id: "mod:crate", path: "./crate.glb", manifestId: "test-mod" }]);
    dispose?.();
    expect(reg.unregistered).toContain("mesh:mod:crate");
  });

  it("asset loader registers a texture and disposes it", async () => {
    const reg = fakeAssetRegistry();
    const loader = createAssetLoader(reg);
    const dispose = await loader.load(
      modManifest(),
      { kind: "texture", id: "mod:paint", path: "./paint.png" } as any,
      {} as any,
    );
    expect(reg.textures).toEqual([{ id: "mod:paint", path: "./paint.png", manifestId: "test-mod" }]);
    dispose?.();
    expect(reg.unregistered).toContain("texture:mod:paint");
  });

  it("asset loader registers a pbr-material with props", async () => {
    const reg = fakeAssetRegistry();
    const loader = createAssetLoader(reg);
    const dispose = await loader.load(
      modManifest(),
      { kind: "pbr-material", id: "mod:metal", path: "./metal.json", metallic: 0.9, roughness: 0.2 } as any,
      {} as any,
    );
    expect(reg.pbrMaterials.length).toBe(1);
    expect(reg.pbrMaterials[0].id).toBe("mod:metal");
    expect(reg.pbrMaterials[0].props.metallic).toBe(0.9);
    dispose?.();
    expect(reg.unregistered).toContain("pbr:mod:metal");
  });

  it("asset loader registers a texture-pipeline with props", async () => {
    const reg = fakeAssetRegistry();
    const loader = createAssetLoader(reg);
    const dispose = await loader.load(
      modManifest(),
      { kind: "texture-pipeline", id: "mod:pipe", path: "./pipe.json", format: "bc7" } as any,
      {} as any,
    );
    expect(reg.pipelines.length).toBe(1);
    expect(reg.pipelines[0].props.format).toBe("bc7");
    dispose?.();
    expect(reg.unregistered).toContain("pipeline:mod:pipe");
  });

  it("asset loader throws on unknown kind", async () => {
    const reg = fakeAssetRegistry();
    const loader = createAssetLoader(reg);
    await expect(
      loader.load(modManifest(), { kind: "audio", id: "x", path: "./x" } as any, {} as any),
    ).rejects.toThrow("Unknown asset kind: audio");
  });

  // ── Map loader ──

  it("map loader registers and disposes a map", async () => {
    const reg = fakeMapRegistry();
    const loader = createMapLoader(reg);
    const dispose = await loader.load(
      modManifest(),
      { kind: "map", id: "mod:arena", path: "./arena.json" } as any,
      {} as any,
    );
    expect(reg.maps).toEqual([{ id: "mod:arena", path: "./arena.json", manifestId: "test-mod" }]);
    dispose?.();
    expect(reg.unregistered).toContain("map:mod:arena");
  });

  // ── Physics loader ──

  it("physics loader registers and disposes a physics override", async () => {
    const reg = fakePhysicsRegistry();
    const loader = createPhysicsLoader(reg);
    const dispose = await loader.load(
      modManifest(),
      { kind: "physics", id: "mod:phys", path: "./phys.json" } as any,
      {} as any,
    );
    expect(reg.overrides).toEqual([{ id: "mod:phys", path: "./phys.json", manifestId: "test-mod" }]);
    dispose?.();
    expect(reg.unregistered).toContain("phys:mod:phys");
  });

  // ── Shader loaders ──

  it("postfx shader loader registers and disposes an effect", async () => {
    const reg = fakeShaderRegistry();
    const loader = createPostfxShaderLoader(reg);
    const dispose = await loader.load(
      modManifest(),
      { id: "mod:acid", name: "Acid", wgsl: "./acid.wgsl", layout: "cc", order: "stylized", uniforms: 64 } as any,
      {} as any,
    );
    expect(reg.postfx.length).toBe(1);
    expect(reg.postfx[0].name).toBe("Acid");
    expect(reg.postfx[0].props).toEqual({ layout: "cc", order: "stylized", uniforms: 64 });
    dispose?.();
    expect(reg.unregistered).toContain("postfx:mod:acid");
  });

  it("material shader loader registers and disposes a material", async () => {
    const reg = fakeShaderRegistry();
    const loader = createMaterialShaderLoader(reg);
    const dispose = await loader.load(
      modManifest(),
      { id: "mod:iridescent", wgsl: "./iridescent.wgsl", uniforms: 128 } as any,
      {} as any,
    );
    expect(reg.materials.length).toBe(1);
    expect(reg.materials[0].wgslPath).toBe("./iridescent.wgsl");
    expect(reg.materials[0].props.uniforms).toBe(128);
    dispose?.();
    expect(reg.unregistered).toContain("material:mod:iridescent");
  });

  // ── Integration: PluginHost dispatches to extension loaders ──

  it("PluginHost dispatches asset + map + physics extensions to their loaders", async () => {
    const assetReg = fakeAssetRegistry();
    const mapReg = fakeMapRegistry();
    const physReg = fakePhysicsRegistry();
    const host = new PluginHost({
      gameId: "test-game",
      engineVersion: "0.1.0",
      moduleHost: new ModuleHost(new World()),
    });
    host.registerExtensionLoader(createAssetLoader(assetReg));
    host.registerExtensionLoader(createMapLoader(mapReg));
    host.registerExtensionLoader(createPhysicsLoader(physReg));
    // No logic loader needed for a pure-data mod.
    host.discover(
      modManifest({
        format: "asset",
        tier: "data",
        thread: "renderer",
        entry: undefined,
        permissions: [],
        logic: undefined,
        extensions: {
          assets: [
            { kind: "mesh", id: "mod:crate", path: "./crate.glb" },
            { kind: "texture", id: "mod:paint", path: "./paint.png" },
          ] as any,
          maps: [{ kind: "map", id: "mod:arena", path: "./arena.json" } as any],
          physics: [{ kind: "physics", id: "mod:phys", path: "./phys.json" } as any],
        },
      }),
      "local",
    );
    await host.loadAll();
    expect(assetReg.meshes.length).toBe(1);
    expect(assetReg.textures.length).toBe(1);
    expect(mapReg.maps.length).toBe(1);
    expect(physReg.overrides.length).toBe(1);
    // Unload → all extensions unregistered.
    host.unload("test-mod");
    expect(assetReg.unregistered.length).toBe(2);
    expect(mapReg.unregistered.length).toBe(1);
    expect(physReg.unregistered.length).toBe(1);
  });
});
