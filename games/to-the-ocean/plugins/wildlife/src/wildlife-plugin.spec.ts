import type { Plugin, PluginContext, Query, System } from "@downdraft/core";
import { createBuoyancyPlugin, type BuoyancyConfig, type BuoyancyDeps } from "@to-the-ocean/library-buoyancy";
import { createCollisionPlugin, type CollisionConfig, type CollisionDeps } from "@to-the-ocean/library-collision";
import type { WildlifeConfig, WildlifeDeps } from "./types";
import { createWildlifePlugin } from "./wildlife-plugin";

// Mock PluginContext that records all calls
function makeMockCtx(): { ctx: PluginContext; calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = [];
  const resources = new Map<string, unknown>();
  const ctx: PluginContext = {
    registerComponent: (name: string, schema: unknown) => {
      calls.push({ method: "registerComponent", args: [name, schema] });
      return 0;
    },
    registerSystem: (stage, fn) => {
      calls.push({ method: "registerSystem", args: [stage, fn] });
    },
    registerSystemObject: (sys: System) => {
      calls.push({ method: "registerSystemObject", args: [sys] });
    },
    allocateSABChannel: (name: string, size: number) => {
      calls.push({ method: "allocateSABChannel", args: [name, size] });
      return { name, buffer: new SharedArrayBuffer(size) };
    },
    provide: (token: any, value: unknown) => {
      calls.push({ method: "provide", args: [token, value] });
      resources.set(token.key, value);
    },
    inject: (token: any) => {
      calls.push({ method: "inject", args: [token] });
      return resources.get(token.key);
    },
    injectOptional: (token: any) => {
      calls.push({ method: "injectOptional", args: [token] });
      return resources.get(token.key);
    },
    registerMigration: (version: number, fn) => {
      calls.push({ method: "registerMigration", args: [version, fn] });
    },
    onDispose: (fn: () => void) => {
      calls.push({ method: "onDispose", args: [fn] });
    },
    devtools: {
      registerPanel: () => {},
      registerOverlayToggle: () => {},
      registerDataFeed: () => {},
      registerCommand: () => {},
      registerSABStat: () => {},
    },
  };
  return { ctx, calls };
}

const mockQuery: Query = { components: [], filter: () => false } as unknown as Query;

// Minimal config/deps stubs — the plugin wrapper only forwards them to the system factory
const mockWildlifeDeps: WildlifeDeps = {
  getBiome: () => 0,
  getEntity: () => undefined,
  getOnboardShipId: () => -1,
} as unknown as WildlifeDeps;

const mockWildlifeConfig: WildlifeConfig = {
  entityTypes: { fish: 1, shark: 2, eel: 3, jellyfish: 4, devilShrimp: 5, whale: 6, dolphin: 7, turtle: 8, crustacean: 9, coral: 10, moose: 11, ship: 12, pirateShip: 13, port: 14, island: 15, player: 16 },
  entityFlags: { static: 1, bioluminescent: 2 },
  playerFlags: { swimming: 1, onboard: 2 },
  biomes: { ocean: 0, tropical: 1, subTropical: 2, deepOcean: 3, coralReef: 4, kelpForest: 5, volcanic: 6, hell: 7, arctic: 8, garbagePatch: 9 },
  spawnRadius: 100,
  maxPerBiome: 10,
  despawnRadius: 200,
  shipClearance: 5,
  pirateShipClearance: 10,
  portClearanceMargin: 5,
  islandClearanceMargin: 5,
  maxSpawnAttempts: 10,
  sharkAttackDamage: 10,
  eelShockDamage: 5,
  jellyfishDotDamage: 2,
  devilShrimpAttackDamage: 8,
  sharkDetectBoatSpeed: 5,
  shipDataSpeedIndex: 0,
} as WildlifeConfig;

const mockBuoyancyDeps: BuoyancyDeps = {
  getWaterHeight: () => 0,
} as unknown as BuoyancyDeps;

const mockBuoyancyConfig: BuoyancyConfig = {
  entityTypes: { player: 16, ship: 12, smallCraft: 13 },
  entityFlags: { static: 1 },
  shipData: { heading: 0, pitch: 0, roll: 0 },
  physics: {
    gravity: -9.81,
    waterDensity: 1000,
    maxTilt: 0.3,
    restoringStiffness: 50,
    verticalDamping: 0.5,
    angularDamping: 0.3,
  },
  boatCellWorldSize: 1,
  boatLayerHeight: 1,
  seabedHeight: -50,
  isHullShellCell: () => false,
  getCellVerticalExtent: () => ({ y0: 0, y1: 1 }),
} as unknown as BuoyancyConfig;

const mockCollisionDeps: CollisionDeps = {
  getVoxelField: () => null,
  sampleTerrainHeight: () => 0,
  getPortColliderDims: () => ({ dock: { halfW: 5, halfD: 5 }, pier: { halfW: 3, halfL: 10, centerZ: 0 } }),
} as unknown as CollisionDeps;

const mockCollisionConfig: CollisionConfig = {
  entityTypes: { player: 16, ship: 12, smallCraft: 13, pirateShip: 14, port: 15, island: 17 },
  entityFlags: { static: 1 },
  portDataIndex: 0,
  shipCollisionRestitution: 0.5,
  entityMass: {},
  wildlifeDensity: {},
  defaultLodDistance: 100,
} as unknown as CollisionConfig;

describe("game plugin wrappers", () => {
  describe("createWildlifePlugin", () => {
    it("returns a plugin with correct name and version", () => {
      const plugin = createWildlifePlugin({
        wildlifeQuery: mockQuery,
        playersQuery: mockQuery,
        shipsQuery: mockQuery,
        allEntitiesQuery: mockQuery,
        deps: mockWildlifeDeps,
        config: mockWildlifeConfig,
      });
      expect(plugin.name).toBe("wildlife");
      expect(plugin.version).toBe("1.0.0");
    });

    it("register() calls registerSystemObject and onDispose", () => {
      const plugin = createWildlifePlugin({
        wildlifeQuery: mockQuery,
        playersQuery: mockQuery,
        shipsQuery: mockQuery,
        allEntitiesQuery: mockQuery,
        deps: mockWildlifeDeps,
        config: mockWildlifeConfig,
      });
      const { ctx, calls } = makeMockCtx();
      plugin.register(ctx);

      const systemObjCalls = calls.filter((c) => c.method === "registerSystemObject");
      expect(systemObjCalls).toHaveLength(1);
      expect(systemObjCalls[0].args[0]).toBeDefined();

      const disposeCalls = calls.filter((c) => c.method === "onDispose");
      expect(disposeCalls).toHaveLength(1);
      expect(typeof disposeCalls[0].args[0]).toBe("function");
    });

    it("satisfies the Plugin interface", () => {
      const plugin: Plugin = createWildlifePlugin({
        wildlifeQuery: mockQuery,
        playersQuery: mockQuery,
        shipsQuery: mockQuery,
        allEntitiesQuery: mockQuery,
        deps: mockWildlifeDeps,
        config: mockWildlifeConfig,
      });
      expect(typeof plugin.name).toBe("string");
      expect(typeof plugin.register).toBe("function");
    });
  });

  describe("createBuoyancyPlugin", () => {
    it("returns a plugin with correct name and version", () => {
      const plugin = createBuoyancyPlugin({
        shipsQuery: mockQuery,
        allEntitiesQuery: mockQuery,
        deps: mockBuoyancyDeps,
        config: mockBuoyancyConfig,
      });
      expect(plugin.name).toBe("buoyancy");
      expect(plugin.version).toBe("1.0.0");
    });

    it("register() calls registerSystemObject", () => {
      const plugin = createBuoyancyPlugin({
        shipsQuery: mockQuery,
        allEntitiesQuery: mockQuery,
        deps: mockBuoyancyDeps,
        config: mockBuoyancyConfig,
      });
      const { ctx, calls } = makeMockCtx();
      plugin.register(ctx);

      const systemObjCalls = calls.filter((c) => c.method === "registerSystemObject");
      expect(systemObjCalls).toHaveLength(1);
      expect(systemObjCalls[0].args[0]).toBeDefined();
    });

    it("does not register an onDispose handler (no cleanup needed)", () => {
      const plugin = createBuoyancyPlugin({
        shipsQuery: mockQuery,
        allEntitiesQuery: mockQuery,
        deps: mockBuoyancyDeps,
        config: mockBuoyancyConfig,
      });
      const { ctx, calls } = makeMockCtx();
      plugin.register(ctx);

      const disposeCalls = calls.filter((c) => c.method === "onDispose");
      expect(disposeCalls).toHaveLength(0);
    });
  });

  describe("createCollisionPlugin", () => {
    it("returns a plugin with correct name and version", () => {
      const plugin = createCollisionPlugin({
        allEntitiesQuery: mockQuery,
        playersQuery: mockQuery,
        deps: mockCollisionDeps,
        config: mockCollisionConfig,
      });
      expect(plugin.name).toBe("collision");
      expect(plugin.version).toBe("1.0.0");
    });

    it("register() calls registerSystemObject", () => {
      const plugin = createCollisionPlugin({
        allEntitiesQuery: mockQuery,
        playersQuery: mockQuery,
        deps: mockCollisionDeps,
        config: mockCollisionConfig,
      });
      const { ctx, calls } = makeMockCtx();
      plugin.register(ctx);

      const systemObjCalls = calls.filter((c) => c.method === "registerSystemObject");
      expect(systemObjCalls).toHaveLength(1);
      expect(systemObjCalls[0].args[0]).toBeDefined();
    });

    it("does not register an onDispose handler (no cleanup needed)", () => {
      const plugin = createCollisionPlugin({
        allEntitiesQuery: mockQuery,
        playersQuery: mockQuery,
        deps: mockCollisionDeps,
        config: mockCollisionConfig,
      });
      const { ctx, calls } = makeMockCtx();
      plugin.register(ctx);

      const disposeCalls = calls.filter((c) => c.method === "onDispose");
      expect(disposeCalls).toHaveLength(0);
    });
  });
});
