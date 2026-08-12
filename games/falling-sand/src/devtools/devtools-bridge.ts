// ============================================================================
// FallingSandDevToolsBridge — extends DevToolsDataBridge with sim stats +
// controls for the falling-sand game. Exposes a "Sim" tab in the DevTools
// panel via the reusable createSimStatsPanelExtension() factory.
// ============================================================================

import {
    createSimStatsPanelExtension,
    DevToolsDataBridge,
    type IDevToolsPanelExtension,
    type ISimStats,
    type ISimStatsProvider,
} from "@downdraft/plugin-devtools";
import type { FallingSandRenderer } from "../renderer/falling-sand-renderer";
import { NUM_LAYERS, PLAYER } from "../shared/sim-buffer";
import { useGameStore } from "../stores/game-store";

export class FallingSandDevToolsBridge extends DevToolsDataBridge {
  private gameRenderer: FallingSandRenderer;
  // Cached worker stats — getStats() is async (worker RPC), but the panel
  // calls getSimStats() synchronously via evalInPage. We poll at 10Hz and
  // cache the latest result.
  private cachedStats: { fps: number; tick: number; frame: number } = { fps: 0, tick: 0, frame: 0 };
  private cachedSpeed = 1;
  private statsPollInterval: ReturnType<typeof setInterval> | null = null;

  constructor(renderer: FallingSandRenderer) {
    super();
    this.gameRenderer = renderer;
  }

  init(renderer?: any): void {
    super.init(renderer);

    // Poll worker stats at 10Hz for the synchronous getSimStats() path.
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
            grid: `${renderer.getGridW()}x${renderer.getGridH()}`,
            layers: NUM_LAYERS,
            renderFPS: renderer.getFPS(),
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
        this.gameRenderer.clearAll();
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
            ["Grid", extra.grid ?? "—"],
            ["Layers", String(extra.layers ?? "—")],
            ["Render FPS", String(extra.renderFPS ?? "—")],
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
