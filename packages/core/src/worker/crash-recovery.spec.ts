import { CrashRecoveryManager, DEFAULT_RECOVERY_CONFIG } from "./crash-recovery.ts";
import type { SimWorkerSupervisor } from "./supervisor.ts";
import type { CheckpointManager, CheckpointData } from "../scene/checkpoint.ts";
import type { World } from "../ecs/world.ts";
import type { Serializer, SaveData } from "../save/serializer.ts";

function makeMockSupervisor(): SimWorkerSupervisor {
  return {
    start: () => {},
    terminate: () => {},
    getHandle: () => null,
  } as unknown as SimWorkerSupervisor;
}

function makeMockCheckpointManager(): CheckpointManager {
  const checkpoints: Map<string, CheckpointData> = new Map();
  return {
    create: (name: string) => {
      const cp: CheckpointData = { name, timestamp: Date.now(), entities: [] };
      checkpoints.set(name, cp);
      return cp;
    },
    restore: (name: string) => checkpoints.has(name),
    list: () => [...checkpoints.values()],
    diff: () => null,
  } as unknown as CheckpointManager;
}

function makeMockWorld(): World {
  return {
    entities: [],
    archetypes: [],
    archetypeById: new Map(),
    spawn: () => ({ index: 0, generation: 0 }),
    despawn: () => {},
    flushCommands: () => {},
  } as unknown as World;
}

function makeMockSerializer(): Serializer {
  return {
    serialize: (): SaveData => ({ schemaVersion: 1, scene: { name: "test", entities: [] } }),
    deserialize: () => {},
    toJSON: (data: SaveData) => JSON.stringify(data),
    fromJSON: (json: string) => JSON.parse(json),
    toBinary: (data: SaveData) => new TextEncoder().encode(JSON.stringify(data)).buffer,
    fromBinary: (buf: ArrayBuffer) => JSON.parse(new TextDecoder().decode(buf)),
  } as unknown as Serializer;
}

describe("CrashRecoveryManager", () => {
  it("should construct with default config", () => {
    const mgr = new CrashRecoveryManager(
      makeMockSupervisor(),
      makeMockCheckpointManager(),
      makeMockWorld(),
      makeMockSerializer(),
    );
    expect(mgr.getConfig().checkpointIntervalMs).toBe(DEFAULT_RECOVERY_CONFIG.checkpointIntervalMs);
    expect(mgr.getConfig().maxCheckpoints).toBe(DEFAULT_RECOVERY_CONFIG.maxCheckpoints);
    expect(mgr.getConfig().autoRestore).toBe(DEFAULT_RECOVERY_CONFIG.autoRestore);
  });

  it("should construct with custom config", () => {
    const mgr = new CrashRecoveryManager(
      makeMockSupervisor(),
      makeMockCheckpointManager(),
      makeMockWorld(),
      makeMockSerializer(),
      { checkpointIntervalMs: 1000, maxCheckpoints: 5 },
    );
    expect(mgr.getConfig().checkpointIntervalMs).toBe(1000);
    expect(mgr.getConfig().maxCheckpoints).toBe(5);
  });

  it("should create checkpoints", () => {
    const mgr = new CrashRecoveryManager(
      makeMockSupervisor(),
      makeMockCheckpointManager(),
      makeMockWorld(),
      makeMockSerializer(),
    );
    const name = mgr.createCheckpoint();
    expect(name).toContain("auto_");
    expect(mgr.getState().checkpointCount).toBe(1);
  });

  it("should track last checkpoint time", () => {
    const mgr = new CrashRecoveryManager(
      makeMockSupervisor(),
      makeMockCheckpointManager(),
      makeMockWorld(),
      makeMockSerializer(),
    );
    mgr.createCheckpoint();
    expect(mgr.getState().lastCheckpointTime).toBeGreaterThan(0);
  });

  it("should start and stop checkpointing", () => {
    const mgr = new CrashRecoveryManager(
      makeMockSupervisor(),
      makeMockCheckpointManager(),
      makeMockWorld(),
      makeMockSerializer(),
      { checkpointIntervalMs: 10 },
    );
    mgr.start();
    mgr.stop();
  });

  it("should not start twice", () => {
    const mgr = new CrashRecoveryManager(
      makeMockSupervisor(),
      makeMockCheckpointManager(),
      makeMockWorld(),
      makeMockSerializer(),
      { checkpointIntervalMs: 100 },
    );
    mgr.start();
    mgr.start();
    mgr.stop();
  });

  it("should recover from crash with existing checkpoints", async () => {
    const mgr = new CrashRecoveryManager(
      makeMockSupervisor(),
      makeMockCheckpointManager(),
      makeMockWorld(),
      makeMockSerializer(),
    );
    mgr.createCheckpoint();
    const result = await mgr.recoverFromCrash();
    expect(result).toBe(true);
    expect(mgr.getState().crashCount).toBe(1);
    expect(mgr.getState().lastRestoredCheckpoint).not.toBeNull();
  });

  it("should fail recovery with no checkpoints", async () => {
    const mgr = new CrashRecoveryManager(
      makeMockSupervisor(),
      makeMockCheckpointManager(),
      makeMockWorld(),
      makeMockSerializer(),
    );
    const result = await mgr.recoverFromCrash();
    expect(result).toBe(false);
  });

  it("should not recover while already recovering", async () => {
    const mgr = new CrashRecoveryManager(
      makeMockSupervisor(),
      makeMockCheckpointManager(),
      makeMockWorld(),
      makeMockSerializer(),
    );
    mgr.createCheckpoint();
    mgr.getState().isRecovering = true;
    const result = await mgr.recoverFromCrash();
    expect(result).toBe(false);
  });

  it("should list checkpoints", () => {
    const mgr = new CrashRecoveryManager(
      makeMockSupervisor(),
      makeMockCheckpointManager(),
      makeMockWorld(),
      makeMockSerializer(),
    );
    mgr.createCheckpoint();
    mgr.createCheckpoint();
    expect(mgr.listCheckpoints().length).toBe(2);
  });

  it("should set and update config", () => {
    const mgr = new CrashRecoveryManager(
      makeMockSupervisor(),
      makeMockCheckpointManager(),
      makeMockWorld(),
      makeMockSerializer(),
    );
    mgr.setConfig({ maxCheckpoints: 20 });
    expect(mgr.getConfig().maxCheckpoints).toBe(20);
  });

  it("should call onCheckpoint callback", () => {
    const mgr = new CrashRecoveryManager(
      makeMockSupervisor(),
      makeMockCheckpointManager(),
      makeMockWorld(),
      makeMockSerializer(),
    );
    let callbackName: string | null = null;
    mgr.setOnCheckpoint((name) => { callbackName = name; });
    mgr.createCheckpoint();
    expect(callbackName).not.toBeNull();
  });

  it("should call onRecovery callback", async () => {
    const mgr = new CrashRecoveryManager(
      makeMockSupervisor(),
      makeMockCheckpointManager(),
      makeMockWorld(),
      makeMockSerializer(),
    );
    let recoveryName: string | null = null;
    mgr.setOnRecovery((name) => { recoveryName = name; });
    mgr.createCheckpoint();
    await mgr.recoverFromCrash();
    expect(recoveryName).not.toBeNull();
  });

  it("should dispose cleanly", () => {
    const mgr = new CrashRecoveryManager(
      makeMockSupervisor(),
      makeMockCheckpointManager(),
      makeMockWorld(),
      makeMockSerializer(),
    );
    mgr.start();
    expect(() => mgr.dispose()).not.toThrow();
  });
});
