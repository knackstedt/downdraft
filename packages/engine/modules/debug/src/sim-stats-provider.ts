// ============================================================================
// createSimStatsProvider — reusable ISimStatsProvider factory that eliminates
// the duplicated polling + control boilerplate across sim games.
//
// Handles:
//   - 10Hz polling of worker stats (cached for synchronous getSimStats())
//   - pause/resume/step/speed/clear delegation to the worker host + game store
//
// Games provide:
//   - getWorkerHost(): returns the worker host (with pause/resume/step/setSpeed/getStats)
//   - getStorePaused() / setStorePaused(): game store paused state
//   - getExtra(stats): game-specific extra rows (grid dims, player pos, etc.)
//   - clearSim(): game-specific clear/reset (optional)
// ============================================================================

import type { ISimStats, ISimStatsProvider } from "./types";

export interface SimStatsProviderOptions {
  /** Returns the worker host, or null if not ready. Must have getStats/pause/resume/step/setSpeed. */
  getWorkerHost: () => {
    getStats(): Promise<{ fps: number; tick: number; frame: number } | null>;
    pause(): void;
    resume(): void;
    step(): void;
    setSpeed(speed: number): void;
  } | null;

  /** Returns the current paused state from the game store. */
  getStorePaused: () => boolean;
  /** Sets the paused state in the game store. */
  setStorePaused: (paused: boolean) => void;

  /** Game-specific extra rows appended to ISimStats.extra. */
  getExtra?: (cachedStats: { fps: number; tick: number; frame: number }) => Record<string, any>;

  /** Game-specific clear/reset. Optional — omit if the game doesn't support clearing. */
  clearSim?: () => void;

  /** Polling interval in ms. Default: 100 (10Hz). */
  pollIntervalMs?: number;
}

export function createSimStatsProvider(opts: SimStatsProviderOptions): ISimStatsProvider & {
  start(): void;
  stop(): void;
} {
  const pollIntervalMs = opts.pollIntervalMs ?? 100;
  let cachedStats: { fps: number; tick: number; frame: number } = { fps: 0, tick: 0, frame: 0 };
  let cachedSpeed = 1;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function start(): void {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      const host = opts.getWorkerHost();
      if (!host) return;
      host.getStats().then((s) => {
        if (s) cachedStats = s;
      }).catch(() => {});
    }, pollIntervalMs);
  }

  function stop(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  const provider: ISimStatsProvider = {
    getSimStats: (): ISimStats => {
      const extra = opts.getExtra ? opts.getExtra(cachedStats) : undefined;
      return {
        fps: cachedStats.fps,
        tick: cachedStats.tick,
        frame: cachedStats.frame,
        paused: opts.getStorePaused(),
        speed: cachedSpeed,
        extra,
      };
    },
    pauseSim: (): void => {
      opts.getWorkerHost()?.pause();
      opts.setStorePaused(true);
    },
    resumeSim: (): void => {
      opts.getWorkerHost()?.resume();
      opts.setStorePaused(false);
    },
    stepSim: (): void => {
      opts.getWorkerHost()?.step();
    },
    setSimSpeed: (speed: number): void => {
      cachedSpeed = speed;
      opts.getWorkerHost()?.setSpeed(speed);
    },
    clearSim: opts.clearSim ? () => opts.clearSim!() : undefined,
  };

  return {
    ...provider,
    start,
    stop,
  };
}
