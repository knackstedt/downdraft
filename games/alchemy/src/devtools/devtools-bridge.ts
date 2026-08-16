import {
    createSimStatsPanelExtension,
    DevToolsDataBridge,
    type IDevToolsPanelExtension,
    type ISimStats,
    type ISimStatsProvider,
} from "@downdraft/plugin-devtools";
import type { AlchemyRenderer } from "../renderer/alchemy-renderer";
import { useGameStore } from "../stores/game-store";

export class AlchemyDevToolsBridge extends DevToolsDataBridge {
  private gameRenderer: AlchemyRenderer;
  private cachedStats: { fps: number; tick: number; frame: number } = { fps: 0, tick: 0, frame: 0 };
  private cachedSpeed = 1;
  private statsPollInterval: ReturnType<typeof setInterval> | null = null;

  constructor(renderer: AlchemyRenderer) {
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
        const store = useGameStore.getState();
        return {
          fps: this.cachedStats.fps,
          tick: this.cachedStats.tick,
          frame: this.cachedStats.frame,
          paused: store.paused,
          speed: this.cachedSpeed,
          extra: {
            grid: `${renderer.getGridW()}x${renderer.getGridH()}`,
            renderFPS: renderer.getFPS(),
            money: store.money,
            potions: store.potions.length,
            activeStation: store.activeStation,
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
          const extra = stats.extra as any;
          if (!extra) return [];
          return [
            ["Grid", extra.grid ?? "—"],
            ["Render FPS", String(extra.renderFPS ?? "—")],
            ["Money", String(extra.money ?? "—")],
            ["Potions", String(extra.potions ?? "—")],
            ["Station", extra.activeStation ?? "none"],
          ] as [string, string][];
        },
      }),
    ];
  }
}
