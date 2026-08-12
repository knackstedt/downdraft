// ============================================================================
// Scene Inspector — game-specific DevTools API for to-the-ocean.
// Extends BaseSceneInspector with game-specific methods (boat layout, sim
// state, world control, weather, biome list, etc.).
// ============================================================================

import {
    BaseSceneInspector,
    useDebugStore,
    type IAssetResolver,
    type IDebugModeProvider,
    type IDebugOverlayProvider,
    type IDevToolsOverlayToggle,
    type IDevToolsPanelExtension,
    type IPerformanceMetricsProvider
} from "@downdraft/plugin-devtools";
import { ENT, PLR, PLR_FLAG } from "@shared/sim-buffer";
import { EntityType, EntityTypeNames, WeatherType } from "@shared/types";
import { getOverlayToggles, getPanelExtensions } from "../devtools/panel-extensions";
import type { SimBridge } from "../sim-bridge";
import { useGameStore } from "../stores/game-store";
import type { WebGPURenderer } from "./webgpu-renderer";

import {
    availableModelFiles,
    findBinForGLTF,
    findMTLForOBJ,
    syncFetchArrayBuffer,
    textureUrlMap,
} from "./scene-inspector-utils";

export class SceneInspector extends BaseSceneInspector {
  private gameRenderer: WebGPURenderer | null = null;
  private simBridge: SimBridge | null = null;

  /** Set by main.tsx after the bridge is created. */
  setSimBridge(bridge: SimBridge): void {
    this.simBridge = bridge;
  }

  // --- Asset resolver ---

  protected getAssetResolver(): IAssetResolver {
    return {
      getAvailableModels: () => availableModelFiles,
      syncFetchArrayBuffer,
      findMTLForOBJ,
      findBinForGLTF,
      getTextureUrl: (uri: string) => textureUrlMap.get(uri) ?? null,
    };
  }

  // --- Debug overlay provider (chunk grid, velocity arrows) ---

  protected getDebugOverlayProvider(): IDebugOverlayProvider | null {
    const r = this.gameRenderer;
    if (!r) return null;
    return {
      setShowChunkGrid: (show) => r.setShowChunkGrid(show),
      getShowChunkGrid: () => r.isChunkGridVisible(),
      setShowVelocityArrows: (show) => r.setShowVelocityArrows(show),
      getShowVelocityArrows: () => r.isVelocityArrowsVisible(),
    };
  }

  // --- Debug mode provider (sim worker) ---

  protected getDebugModeProvider(): IDebugModeProvider | null {
    return {
      setDebugMode: (enabled: boolean) => this.simBridge?.setDebugMode(enabled),
      setGCConfig: (config: any) => this.simBridge?.setGCConfig(config),
      forceMajorGC: () => this.simBridge?.forceWorkerMajorGC(),
    };
  }

  // --- Performance metrics provider ---

  protected getPerformanceMetricsProvider(): IPerformanceMetricsProvider | null {
    return {
      getPerformanceMetrics: () => this.getGamePerformanceMetrics(),
    };
  }

  // --- Panel extensions (game-specific DevTools tabs and overlay toggles) ---

  protected getPanelExtensions(): IDevToolsPanelExtension[] {
    return getPanelExtensions();
  }

  protected getOverlayToggles(): IDevToolsOverlayToggle[] {
    return getOverlayToggles();
  }

  // --- Init ---

  init(renderer: WebGPURenderer): void {
    this.gameRenderer = renderer;
    super.init(renderer);

    // Game-specific default overlay states
    renderer.setShowHitboxes(true);
    const overlay = this.getDebugOverlayProvider();
    if (overlay) {
      overlay.setShowChunkGrid(true);
      overlay.setShowVelocityArrows(true);
    }
  }

  // --- Build API with game-specific extensions ---

  protected buildApi(): Record<string, any> {
    const base = super.buildApi();

    // --- Boat Layout ---
    base.getBoatLayout = (): { boats: { entityId: number; cells: { type: number; rotation: number; gridX: number; gridY: number; gridZ: number }[] }[] } => {
      const reader = this.gameRenderer?.getBoatReader();
      if (!reader || !reader.isValid()) return { boats: [] };
      const count = reader.getBoatCount();
      const boats: { entityId: number; cells: { type: number; rotation: number; gridX: number; gridY: number; gridZ: number }[] }[] = [];
      for (let s = 0; s < count; s++) {
        const eid = reader.getBoatEntityId(s);
        if (!eid) continue;
        const cells = reader.getBoatCells(s);
        boats.push({
          entityId: eid,
          cells: cells.map(c => ({ type: c.type, rotation: c.rotation, gridX: c.gridX, gridY: c.gridY, gridZ: c.gridZ })),
        });
      }
      return { boats };
    };

    // --- Sim / World State ---
    base.getSimState = (): any => {
      const sim = this.gameRenderer?.getSimReader();
      if (!sim || !sim.isValid()) return null;
      const weatherNames: Record<number, string> = {};
      for (const k of Object.keys(WeatherType)) {
        const v = (WeatherType as any)[k];
        if (typeof v === "number") weatherNames[v] = k;
      }
      const wind = sim.getWindDir();
      const tod = sim.getTimeOfDay();
      const hours = Math.floor(tod * 24);
      const mins = Math.floor((tod * 24 - hours) * 60);
      return {
        tick: sim.getTick(),
        timeOfDay: tod,
        timeStr: `${hours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}`,
        weatherType: sim.getWeatherType(),
        weatherName: weatherNames[sim.getWeatherType()] ?? `Type${sim.getWeatherType()}`,
        weatherIntensity: sim.getWeatherIntensity(),
        windSpeed: sim.getWindSpeed(),
        windDirX: wind.x,
        windDirZ: wind.z,
        visibility: sim.getVisibility(),
        ambientTemp: sim.getAmbientTemp(),
        activePlayers: sim.getActivePlayers(),
        gamemode: sim.getGamemode(),
        entityCount: sim.getEntityCount(),
        playerCount: sim.getPlayerCount(),
        chunkCount: sim.getChunkCount(),
      };
    };

    // --- Physics Profiler ---
    base.setPhysicsProfiler = (enabled: boolean): void => {
      this.simBridge?.setPhysicsProfiler(enabled);
    };

    base.getPhysicsTiming = (): any => {
      const sim = this.gameRenderer?.getSimReader();
      if (!sim || !sim.isValid()) return null;
      return {
        profilerEnabled: sim.getPhysicsProfilerEnabled(),
        timing: sim.getPhysicsTiming(),
      };
    };

    // --- Player Stats ---
    base.getPlayerStats = (): any => {
      const sim = this.gameRenderer?.getSimReader();
      if (!sim || !sim.isValid()) return null;
      const count = sim.getPlayerCount();
      const players: any[] = [];
      for (let i = 0; i < count; i++) {
        const slot = sim.getPlayerSlot(i);
        if (!slot) continue;
        const f32 = slot.f32;
        const u32 = slot.u32;
        const flags = u32[PLR.FLAGS];
        const flagNames: string[] = [];
        for (const [name, bit] of Object.entries(PLR_FLAG)) {
          if (typeof bit === "number" && (flags & bit)) flagNames.push(name);
        }
        players.push({
          slot: i,
          playerId: u32[PLR.PLAYER_ID],
          entityId: u32[PLR.ENTITY_ID],
          position: [f32[PLR.POS_X], f32[PLR.POS_Y], f32[PLR.POS_Z]],
          heading: f32[PLR.HEADING],
          pitch: f32[PLR.PITCH] ?? 0,
          health: f32[PLR.HEALTH],
          maxHealth: f32[PLR.MAX_HEALTH],
          hunger: f32[PLR.HUNGER],
          thirst: f32[PLR.THIRST],
          oxygen: f32[PLR.OXYGEN],
          maxOxygen: f32[PLR.MAX_OXYGEN],
          temperature: f32[PLR.TEMPERATURE],
          gold: f32[PLR.GOLD],
          cameraMode: u32[PLR.CAMERA_MODE],
          flags,
          flagNames,
        });
      }
      return { players };
    };

    // --- Entity Sim Data ---
    base.getEntitySimData = (entityId: number): any => {
      const sim = this.gameRenderer?.getSimReader();
      if (!sim || !sim.isValid()) return null;
      const count = sim.getEntityCount();
      for (let i = 0; i < count; i++) {
        const slot = sim.getEntitySlot(i);
        if (!slot) continue;
        if (slot.u32[ENT.ID] !== entityId) continue;
        const f32 = slot.f32;
        const u32 = slot.u32;
        const type = u32[ENT.TYPE];
        const data: number[] = [];
        for (let d = 0; d < 8; d++) data.push(f32[ENT.DATA + d]);
        return {
          entityId,
          type,
          typeName: EntityTypeNames[type] ?? `Type${type}`,
          velocity: [f32[ENT.VEL_X], f32[ENT.VEL_Y], f32[ENT.VEL_Z]],
          angularVelocity: [f32[ENT.ANGVEL_X], f32[ENT.ANGVEL_Y], f32[ENT.ANGVEL_Z]],
          health: f32[ENT.HEALTH],
          maxHealth: f32[ENT.MAX_HEALTH],
          flags: u32[ENT.FLAGS],
          parentId: u32[ENT.PARENT_ID],
          chunkX: u32[ENT.CHUNK_X],
          chunkZ: u32[ENT.CHUNK_Z],
          data,
        };
      }
      return null;
    };

    // --- Physics Stats ---
    base.getPhysicsStats = (): any => {
      const sim = this.gameRenderer?.getSimReader();
      if (!sim || !sim.isValid()) return null;
      return {
        initialized: sim.getPhysicsInitialized() === 1,
        failed: sim.getPhysicsFailed() === 1,
        bodyCount: sim.getPhysicsBodyCount(),
        tickCount: sim.getPhysicsTickCount(),
      };
    };

    // --- Renderer Stats ---
    base.getRendererStats = (): any => {
      const sim = this.gameRenderer?.getSimReader();
      if (!sim || !sim.isValid()) return null;
      const playerSlot = sim.getPlayerSlot(0);
      if (!playerSlot) return null;
      const f32 = playerSlot.f32;
      const u32 = playerSlot.u32;
      const waterReader = this.gameRenderer?.getWaterReader();
      const keys = Array.from((this.gameRenderer as any).keysDown as Set<number>).map((k: number) => String.fromCharCode(k)).join(",");
      return {
        fps: this.gameRenderer?.getFPS() ?? 0,
        entityCount: sim.getEntityCount(),
        playerCount: sim.getPlayerCount(),
        tick: sim.getTick(),
        canvasW: this.gameRenderer?.getCanvasWidth() ?? 0,
        canvasH: this.gameRenderer?.getCanvasHeight() ?? 0,
        viewportW: this.gameRenderer?.getViewportWidth(0) ?? 0,
        viewportH: this.gameRenderer?.getViewportHeight(0) ?? 0,
        waterValid: waterReader?.isValid() ?? false,
        waterGrid: waterReader?.getGridSize() ?? 0,
        playerPos: [f32[PLR.POS_X], f32[PLR.POS_Y], f32[PLR.POS_Z]],
        heading: f32[PLR.HEADING],
        pitch: f32[PLR.PITCH] ?? 0,
        cameraMode: u32[PLR.CAMERA_MODE],
        keys,
      };
    };

    // --- World / Biome / Port / Island Control ---
    base.getWorldEntities = (): any => {
      const sim = this.gameRenderer?.getSimReader();
      if (!sim || !sim.isValid()) return { ports: [], islands: [] };
      const count = sim.getEntityCount();
      const ports: any[] = [];
      const islands: any[] = [];
      for (let i = 0; i < count; i++) {
        const slot = sim.getEntitySlot(i);
        if (!slot) continue;
        const type = slot.u32[ENT.TYPE];
        if (type === EntityType.Port) {
          ports.push({
            entityId: slot.u32[ENT.ID],
            chunkX: slot.u32[ENT.CHUNK_X],
            chunkZ: slot.u32[ENT.CHUNK_Z],
            position: [slot.f32[ENT.POS_X], slot.f32[ENT.POS_Y], slot.f32[ENT.POS_Z]],
            scale: slot.f32[ENT.SCALE],
            size: slot.f32[ENT.DATA],
            biome: slot.f32[ENT.DATA + 5],
          });
        } else if (type === EntityType.Island) {
          islands.push({
            entityId: slot.u32[ENT.ID],
            chunkX: slot.u32[ENT.CHUNK_X],
            chunkZ: slot.u32[ENT.CHUNK_Z],
            position: [slot.f32[ENT.POS_X], slot.f32[ENT.POS_Y], slot.f32[ENT.POS_Z]],
            scale: slot.f32[ENT.SCALE],
            radius: slot.f32[ENT.DATA],
            biome: slot.f32[ENT.DATA + 1],
            size: slot.f32[ENT.DATA + 2],
          });
        }
      }
      return { ports, islands };
    };

    base.getPlayerChunk = (): { chunkX: number; chunkZ: number; worldX: number; worldZ: number } => {
      const sim = this.gameRenderer?.getSimReader();
      if (!sim || !sim.isValid()) return { chunkX: 0, chunkZ: 0, worldX: 0, worldZ: 0 };
      const slot = sim.getPlayerSlot(0);
      if (!slot) return { chunkX: 0, chunkZ: 0, worldX: 0, worldZ: 0 };
      const wx = slot.f32[PLR.POS_X];
      const wz = slot.f32[PLR.POS_Z];
      const chunkSize = 256;
      return {
        chunkX: Math.floor(wx / chunkSize),
        chunkZ: Math.floor(wz / chunkSize),
        worldX: wx,
        worldZ: wz,
      };
    };

    base.sendWorldCommand = (cmd: any): void => {
      this.simBridge?.sendWorldCommand(cmd);
    };

    base.setWeather = (weatherType: number): void => {
      this.simBridge?.setWeather(weatherType);
    };

    base.setTimeOfDay = (time: number): void => {
      this.simBridge?.setTimeOfDay(time);
    };

    base.setSimSpeed = (speed: number): void => {
      useGameStore.getState().setCurrentSimSpeed(speed);
      this.simBridge?.setSimSpeed(speed);
    };

    base.getSimSpeed = (): number => {
      return useGameStore.getState().currentSimSpeed;
    };

    base.getBiomeList = (): { value: number; name: string }[] => {
      const biomeNames: Record<number, string> = {
        0: "Lake", 1: "Arctic", 2: "Desert", 3: "Boreal Forest",
        4: "Tropical", 5: "Sub-Tropical", 6: "Freshwater", 7: "Ocean",
        8: "Deep Ocean", 9: "Coral Reef", 10: "Kelp Forest", 11: "Volcanic",
        12: "Garbage Patch", 13: "Hell",
      };
      const result: { value: number; name: string }[] = [];
      for (let i = 0; i <= 13; i++) {
        result.push({ value: i, name: biomeNames[i] ?? `Biome ${i}` });
      }
      return result;
    };

    return base;
  }

  // --- Game-specific performance metrics ---

  private getGamePerformanceMetrics(): any {
    const pm = (window as any).__perfMetrics ?? {};
    const gcStats = useDebugStore.getState().gcStats;
    const fps = this.gameRenderer?.getFPS() ?? 0;
    const frameTimeMs = fps > 0 ? 1000 / fps : 0;
    const targetFrameMs = 1000 / 60;
    const gpuUtil = Math.min(100, (frameTimeMs / targetFrameMs) * 100);

    const perfMem = (performance as any).memory;
    const rendererMemMB = perfMem ? perfMem.usedJSHeapSize / 1048576 : 0;

    const sim = this.gameRenderer?.getSimReader();

    function gcFor(label: string) {
      const g = gcStats[label];
      if (!g) return { count: 0, totalTime: 0, scavengeCount: 0, majorCount: 0 };
      return {
        count: g.interval.count,
        totalTime: g.interval.totalTime,
        scavengeCount: g.interval.scavengeCount,
        majorCount: g.interval.majorCount,
      };
    }

    const main = pm.main;
    const worker = pm.worker;

    return {
      gpu: {
        utilization: gpuUtil,
        frameTimeMs,
        fps,
      },
      renderer: {
        cpuPercent: gpuUtil,
        memUsedMB: rendererMemMB,
        diskKBps: 0,
        networkKBps: 0,
        gc: gcFor("renderer"),
      },
      main: {
        cpuPercent: main?.cpuPercent ?? 0,
        memUsedMB: main?.memUsedMB ?? 0,
        diskKBps: 0,
        networkKBps: 0,
        gc: gcFor("main"),
      },
      worker: {
        cpuPercent: worker?.cpuPercent ?? 0,
        memUsedMB: worker?.memUsedMB ?? 0,
        diskKBps: 0,
        networkKBps: 0,
        gc: gcFor("sim-worker"),
      },
      physics: {
        profilerEnabled: sim?.getPhysicsProfilerEnabled() ?? false,
        timing: sim?.getPhysicsTiming(),
        bodyCount: sim?.getPhysicsBodyCount() ?? 0,
        tickCount: sim?.getPhysicsTickCount() ?? 0,
      },
      timestamp: performance.now(),
    };
  }

  destroy(): void {
    this.gameRenderer = null;
    super.destroy();
  }
}
