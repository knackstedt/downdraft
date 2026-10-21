// Ambient declarations for Bun-only modules used by the in-process agent and
// test-bed targets. The viewer itself runs on the engine's tri-runtime host;
// these imports are always behind runtime guards / dynamic import().
declare module "bun:jsc" {
  const jsc: {
    heapStats?: () => { heapSize?: number; heapCapacity?: number; objectCount?: number; protectedObjectCount?: number; [k: string]: unknown };
    samplingProfilerStackTraces?: () => { stackTraces?: { frames?: unknown[]; timestamp?: number; [k: string]: unknown }[]; [k: string]: unknown };
    startSamplingProfiler?: () => void;
    gcAndSweep?: () => void;
    [k: string]: unknown;
  };
  export = jsc;
}
