// ============================================================================
// GC Profiler — tracks GC frequency and duration per process
// Works in Node.js (main/worker) and browser (renderer) via PerformanceObserver
// ============================================================================

import { createLogger } from "../util/logger";

const log = createLogger();

export interface GCStats {
  label: string;
  interval: {
    count: number;
    totalTime: number;
    scavengeCount: number;
    scavengeTime: number;
    majorCount: number;
    majorTime: number;
    otherCount: number;
    otherTime: number;
  };
  overall: {
    count: number;
    totalTime: number;
    wallMs: number;
  };
}

interface GCInterval {
  count: number;
  totalTime: number;
  scavengeCount: number;
  scavengeTime: number;
  majorCount: number;
  majorTime: number;
  otherCount: number;
  otherTime: number;
}

export interface GCProfilerHandle {
  stop: () => void;
}

export function startGCProfiler(
  label: string,
  onStats: (stats: GCStats) => void,
  intervalMs = 2000,
): GCProfilerHandle | null {
  const PO = globalThis.PerformanceObserver;
  if (!PO) {
    log.warn(`GC:${label}`, "PerformanceObserver unavailable — skipping GC profiling");
    return null;
  }
  // 'gc' entries are a V8/Node entry type — JSC (Bun) supports
  // PerformanceObserver but never emits them. Bail rather than run a
  // setInterval that reports empty stats forever.
  const supported = (PO as unknown as { supportedEntryTypes?: string[] }).supportedEntryTypes;
  if (supported && !supported.includes("gc")) {
    log.warn(`GC:${label}`, "host does not emit 'gc' performance entries — skipping GC profiling");
    return null;
  }

  let cur: GCInterval = {
    count: 0, totalTime: 0,
    scavengeCount: 0, scavengeTime: 0,
    majorCount: 0, majorTime: 0,
    otherCount: 0, otherTime: 0,
  };

  let totalGC = 0;
  let totalGCTime = 0;
  const startTime = performance.now();

  const obs = new PO((list: PerformanceObserverEntryList) => {
    for (const entry of list.getEntries()) {
      const dur = entry.duration;
      cur.count++;
      cur.totalTime += dur;
      totalGC++;
      totalGCTime += dur;

      const kind = (entry as PerformanceEntry & { kind?: number }).kind;
      if (kind === 1) {
        cur.scavengeCount++;
        cur.scavengeTime += dur;
      } else if (kind === 2) {
        cur.majorCount++;
        cur.majorTime += dur;
      } else {
        cur.otherCount++;
        cur.otherTime += dur;
      }
    }
  });

  try {
    obs.observe({ entryTypes: ['gc'], buffered: true });
  } catch (e) {
    log.warn(`GC:${label}`, `Failed to observe GC events: ${e}`);
    return null;
  }

  const timer = setInterval(() => {
    const wallMs = performance.now() - startTime;

    onStats({
      label,
      interval: { ...cur },
      overall: { count: totalGC, totalTime: totalGCTime, wallMs },
    });

    cur = {
      count: 0, totalTime: 0,
      scavengeCount: 0, scavengeTime: 0,
      majorCount: 0, majorTime: 0,
      otherCount: 0, otherTime: 0,
    };
  }, intervalMs);

  return {
    stop: () => {
      clearInterval(timer);
      try { obs.disconnect(); } catch {}
    },
  };
}
