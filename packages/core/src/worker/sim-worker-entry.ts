import { parentPort, workerData } from "worker_threads";
import { Hierarchy } from "../ecs/hierarchy.ts";
import { World } from "../ecs/world.ts";
import { HighResTimer } from "../platform/time.ts";
import { SABReader } from "../sab/reader.ts";
import { SABWriter } from "../sab/writer.ts";
import { TelemetryCollector } from "../telemetry/collector.ts";
import { GCTracker } from "../telemetry/gc-tracker.ts";
import { createLogger } from "../util/logger.ts";
import type { HeartbeatPayload, StepAckPayload, WorkerMessage } from "./protocol.ts";

const log = createLogger();

interface SimWorkerData {
  sabBuffers: Record<string, SharedArrayBuffer>;
  config: Record<string, unknown>;
}

class SimWorkerRuntime {
  private world: World;
  private hierarchy: Hierarchy;
  private sabReader: SABReader;
  private sabWriter: SABWriter;
  private telemetry: TelemetryCollector;
  private gcTracker: GCTracker;
  private timer: HighResTimer;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  constructor(data: SimWorkerData) {
    this.world = new World();
    this.hierarchy = new Hierarchy();
    this.sabReader = new SABReader();
    this.sabWriter = new SABWriter();
    this.telemetry = new TelemetryCollector(true);
    this.gcTracker = new GCTracker(true);
    this.timer = new HighResTimer();

    // Attach SAB channels
    for (const [name, sab] of Object.entries(data.sabBuffers)) {
      this.sabReader.attachChannel(name as any, sab);
    }

    // Create output channels (transform)
    const transformSAB = data.sabBuffers["transform"];
    if (transformSAB) {
      this.sabWriter.attachChannel("transform", transformSAB);
    }
  }

  init(): void {
    this.timer.reset();
    this.startHeartbeat();
    log.info("sim-worker", "Initialized");
  }

  step(dt: number): StepAckPayload {
    const frameStart = HighResTimer.now();

    // Read input from SAB
    const input = this.sabReader.readIfChanged("input");
    if (input) {
      // TODO: Process input
    }

    // Step the world
    this.world.step(dt);

    // Write transforms to SAB
    this.sabWriter.writeChannel("transform", (buf) => {
      buf.writeField("position", [0, 0, 0]);
      buf.writeField("rotation", [0, 0, 0, 1]);
      buf.writeField("scale", 1);
    });

    const frameTime = HighResTimer.now() - frameStart;
    this.telemetry.recordFrame(frameTime);

    return {
      tick: this.world.tick,
      entityCount: this.world.entityCount(),
      frameTime,
    };
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      const mem = GCTracker.getCurrentMemory();
      const gcStats = this.gcTracker.getStats();
      const payload: HeartbeatPayload = {
        tick: this.world.tick,
        memoryUsage: mem.heapUsed,
        gcPauseTotal: gcStats.pauseTotal,
      };

      if (parentPort) {
        parentPort.postMessage({ type: "heartbeat", id: 0, payload } as WorkerMessage);
      }
    }, 1000);
  }

  dispose(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    log.info("sim-worker", "Disposed");
  }
}

if (parentPort) {
  const data = workerData as SimWorkerData;
  const runtime = new SimWorkerRuntime(data);

  parentPort.on("message", (msg: WorkerMessage) => {
    switch (msg.type) {
      case "init": {
        runtime.init();
        parentPort!.postMessage({ type: "init-ack", id: msg.id, payload: { ready: true } } as WorkerMessage);
        break;
      }
      case "step": {
        const dt = (msg.payload as { dt: number }).dt;
        const result = runtime.step(dt);
        parentPort!.postMessage({ type: "step-ack", id: msg.id, payload: result } as WorkerMessage);
        break;
      }
      case "command": {
        // TODO: Handle spawn/despawn/addComponent/removeComponent
        parentPort!.postMessage({ type: "query-result", id: msg.id, payload: { success: true } } as WorkerMessage);
        break;
      }
    }
  });

  process.on("exit", () => {
    runtime.dispose();
  });
}

export { SimWorkerRuntime };
