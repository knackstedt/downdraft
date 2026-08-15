// ============================================================================
// MiningDevToolsBridge — extends DevToolsDataBridge with sim stats + controls
// for the mining RPG. Exposes a "Sim" tab in the DevTools panel.
// ============================================================================

import {
    createSimStatsPanelExtension,
    DevToolsDataBridge,
    type IDevToolsPanelExtension,
    type ISimStats,
    type ISimStatsProvider,
} from "@downdraft/plugin-devtools";
import type { MiningRenderer } from "../renderer/mining-renderer";
import { PLAYER, WORLD_SEED } from "../shared/constants";
import { useGameStore } from "../stores/game-store";

export class MiningDevToolsBridge extends DevToolsDataBridge {
  private gameRenderer: MiningRenderer;
  private cachedStats: { fps: number; tick: number; frame: number } = { fps: 0, tick: 0, frame: 0 };
  private cachedSpeed = 1;
  private statsPollInterval: ReturnType<typeof setInterval> | null = null;

  constructor(renderer: MiningRenderer) {
    super();
    this.gameRenderer = renderer;
  }

  init(renderer?: any): void {
    super.init(renderer);

    this.statsPollInterval = setInterval(() => {
      const host = this.gameRenderer.getWorkerHost();
      if (!host) return;
      host.getStats().then((s) => {
        if (s) this.cachedStats = s;
      }).catch(() => {});
    }, 100);
  }

  destroy(): void {
    if (this.statsPollInterval) {
      clearInterval(this.statsPollInterval);
      this.statsPollInterval = null;
    }
    super.destroy();
  }

  protected getSimStatsProvider(): ISimStatsProvider {
    const renderer = this.gameRenderer;
    return {
      getSimStats: (): ISimStats => {
        const host = renderer.getWorkerHost();
        const store = useGameStore.getState();
        const player = host ? {
          px: host.getPlayerF32(PLAYER.PX),
          py: host.getPlayerF32(PLAYER.PY),
          vx: host.getPlayerF32(PLAYER.VX),
          vy: host.getPlayerF32(PLAYER.VY),
          health: host.getPlayerI32(PLAYER.HEALTH),
          onGround: host.getPlayerI32(PLAYER.ON_GROUND) !== 0,
          facing: host.getPlayerI32(PLAYER.FACING),
        } : null;

        return {
          fps: this.cachedStats.fps,
          tick: this.cachedStats.tick,
          frame: this.cachedStats.frame,
          paused: store.paused,
          speed: this.cachedSpeed,
          extra: {
            depth: store.depth,
            loadedChunks: store.loadedChunks,
            activeChunks: store.activeChunks,
            frozenChunks: store.loadedChunks - store.activeChunks,
            terrainSeed: WORLD_SEED,
            renderFPS: renderer.getFPS(),
            inventoryCount: store.inventory.reduce((sum, e) => sum + e.count, 0),
            inventoryTypes: store.inventory.length,
            player,
          },
        };
      },
      pauseSim: (): void => {
        this.gameRenderer.getWorkerHost()?.pause();
        useGameStore.getState().setPaused(true);
      },
      resumeSim: (): void => {
        this.gameRenderer.getWorkerHost()?.resume();
        useGameStore.getState().setPaused(false);
      },
      stepSim: (): void => {
        this.gameRenderer.getWorkerHost()?.step();
      },
      setSimSpeed: (speed: number): void => {
        this.cachedSpeed = speed;
        this.gameRenderer.getWorkerHost()?.setSpeed(speed);
      },
      clearSim: (): void => {
        // No clear for mining-rpg (chunk world regenerates from seed)
      },
    };
  }

  protected getPanelExtensions(): IDevToolsPanelExtension[] {
    return [
      createSimStatsPanelExtension({
        extraRows: (stats) => {
          const extra = stats.extra;
          if (!extra) return [];
          const rows: [string, string][] = [
            ["Depth", String(extra.depth ?? "—")],
            ["Loaded Chunks", String(extra.loadedChunks ?? "—")],
            ["Active Chunks", String(extra.activeChunks ?? "—")],
            ["Frozen Chunks", String(extra.frozenChunks ?? "—")],
            ["Terrain Seed", String(extra.terrainSeed ?? "—")],
            ["Render FPS", String(extra.renderFPS ?? "—")],
            ["Inventory Items", String(extra.inventoryCount ?? "—")],
            ["Inventory Types", String(extra.inventoryTypes ?? "—")],
          ];
          if (extra.player) {
            const p = extra.player;
            rows.push(
              ["Player Pos", `(${p.px.toFixed(1)}, ${p.py.toFixed(1)})`],
              ["Player Vel", `(${p.vx.toFixed(2)}, ${p.vy.toFixed(2)})`],
              ["Player Health", String(p.health)],
              ["On Ground", p.onGround ? "Yes" : "No"],
              ["Facing", p.facing > 0 ? "Right" : "Left"],
            );
          }
          return rows;
        },
      }),
    ];
  }
}
