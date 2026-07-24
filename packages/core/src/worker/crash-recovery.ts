import type { SimWorkerSupervisor } from "../worker/supervisor.ts";
import type { CheckpointManager, CheckpointData } from "../scene/checkpoint.ts";
import type { World } from "../ecs/world.ts";
import type { Serializer, SaveData } from "../save/serializer.ts";

export interface CrashRecoveryConfig {
  checkpointIntervalMs: number;
  maxCheckpoints: number;
  autoRestore: boolean;
  checkpointPrefix: string;
}

export const DEFAULT_RECOVERY_CONFIG: CrashRecoveryConfig = {
  checkpointIntervalMs: 5000,
  maxCheckpoints: 10,
  autoRestore: true,
  checkpointPrefix: "auto",
};

export interface RecoveryState {
  lastCheckpointTime: number;
  checkpointCount: number;
  crashCount: number;
  lastRestoredCheckpoint: string | null;
  isRecovering: boolean;
}

export class CrashRecoveryManager {
  private supervisor: SimWorkerSupervisor;
  private checkpointManager: CheckpointManager;
  private world: World;
  private serializer: Serializer;
  private config: CrashRecoveryConfig;
  private state: RecoveryState;
  private dbWorker: { execute: (cmd: unknown) => Promise<unknown> } | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private onCheckpoint: ((name: string) => void) | null = null;
  private onRecovery: ((checkpointName: string) => void) | null = null;

  constructor(
    supervisor: SimWorkerSupervisor,
    checkpointManager: CheckpointManager,
    world: World,
    serializer: Serializer,
    config?: Partial<CrashRecoveryConfig>,
  ) {
    this.supervisor = supervisor;
    this.checkpointManager = checkpointManager;
    this.world = world;
    this.serializer = serializer;
    this.config = { ...DEFAULT_RECOVERY_CONFIG, ...config };
    this.state = {
      lastCheckpointTime: 0,
      checkpointCount: 0,
      crashCount: 0,
      lastRestoredCheckpoint: null,
      isRecovering: false,
    };
  }

  setDBWorker(worker: { execute: (cmd: unknown) => Promise<unknown> }): void {
    this.dbWorker = worker;
  }

  setOnCheckpoint(fn: (name: string) => void): void {
    this.onCheckpoint = fn;
  }

  setOnRecovery(fn: (checkpointName: string) => void): void {
    this.onRecovery = fn;
  }

  start(): void {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => this.createCheckpoint(), this.config.checkpointIntervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  createCheckpoint(): string {
    const name = `${this.config.checkpointPrefix}_${Date.now()}`;
    const cp = this.checkpointManager.create(name, this.world);
    this.state.lastCheckpointTime = Date.now();
    this.state.checkpointCount++;

    if (this.dbWorker) {
      const saveData = this.serializer.serialize(this.world, name);
      this.dbWorker.execute({
        op: "checkpoint",
        key: name,
        data: saveData,
      }).catch((err) => {
        console.error("[CrashRecovery] Failed to persist checkpoint:", err);
      });
    }

    if (this.onCheckpoint) this.onCheckpoint(name);
    return name;
  }

  async recoverFromCrash(): Promise<boolean> {
    if (this.state.isRecovering) return false;
    this.state.isRecovering = true;
    this.state.crashCount++;

    try {
      let checkpointName: string | null = null;

      if (this.dbWorker) {
        const result = await this.dbWorker.execute({
          op: "restore",
          key: this.config.checkpointPrefix,
        });
        if (result && typeof result === "object" && "scene" in result) {
          const saveData = result as SaveData;
          checkpointName = saveData.scene.name;
          this.serializer.deserialize(saveData, this.world, {
            migrate: (_data: unknown, _from: number) => _data,
            getCurrentVersion: () => 1,
            hasMigration: () => false,
            registerMigration: () => {},
          } as unknown as import("../save/schema.ts").SchemaRegistry);
        }
      }

      if (!checkpointName) {
        const checkpoints = this.checkpointManager.list();
        if (checkpoints.length === 0) {
          this.state.isRecovering = false;
          return false;
        }
        const latest = checkpoints[checkpoints.length - 1];
        checkpointName = latest.name;
        this.checkpointManager.restore(checkpointName, this.world);
      }

      this.state.lastRestoredCheckpoint = checkpointName;
      if (this.onRecovery) this.onRecovery(checkpointName);
      this.state.isRecovering = false;
      return true;
    } catch (err) {
      console.error("[CrashRecovery] Recovery failed:", err);
      this.state.isRecovering = false;
      return false;
    }
  }

  getState(): RecoveryState {
    return { ...this.state };
  }

  getConfig(): CrashRecoveryConfig {
    return { ...this.config };
  }

  setConfig(config: Partial<CrashRecoveryConfig>): void {
    this.config = { ...this.config, ...config };
    if (this.intervalId) {
      this.stop();
      this.start();
    }
  }

  listCheckpoints(): CheckpointData[] {
    return this.checkpointManager.list();
  }

  restoreCheckpoint(name: string): boolean {
    return this.checkpointManager.restore(name, this.world);
  }

  clearCheckpoints(): void {
    for (const cp of this.checkpointManager.list()) {
      if (this.dbWorker) {
        this.dbWorker.execute({
          op: "delete",
          key: cp.name,
        }).catch(() => {});
      }
    }
  }

  dispose(): void {
    this.stop();
    this.onCheckpoint = null;
    this.onRecovery = null;
  }
}
