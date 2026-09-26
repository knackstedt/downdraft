import type { PhysicsBackend, SnapshotHooks } from "./interface";
import { RealmTier } from "./interface";
import type { RealmManager } from "./realm-manager";

/**
 * Snapshot manager for multiplayer / save-state support.
 *
 * - Realms are snapshotted independently at configurable frequencies.
 * - Near realm: every `snapshotInterval` ticks (default 30).
 * - Mid/far realms: less frequent (2× / 4× the interval).
 * - `onLateJoin(playerId)`: full snapshot + hook.
 * - `onReconnect(playerId, lastSeenTick)`: delta from lastSeen.
 * - `predictionMode` configures snapshot frequency + reconciliation needs.
 *
 * API surface only — no networking transport (games provide their own).
 */
export class SnapshotManager {
  private realmManager: RealmManager;
  private backend: PhysicsBackend;
  private snapshotInterval: number;
  private predictionMode: "server-authoritative" | "client-prediction";
  private hooks: SnapshotHooks | null = null;
  private tickCount: number = 0;
  /** Last snapshot per realm tier. */
  private lastSnapshots: Map<RealmTier, { data: Uint8Array; tick: number }> = new Map();
  /** Per-player last-seen tick (for reconnect delta). */
  private playerLastSeen: Map<string, number> = new Map();

  constructor(opts: {
    realmManager: RealmManager;
    backend: PhysicsBackend;
    snapshotInterval?: number;
    predictionMode?: "server-authoritative" | "client-prediction";
  }) {
    this.realmManager = opts.realmManager;
    this.backend = opts.backend;
    this.snapshotInterval = opts.snapshotInterval ?? 30;
    this.predictionMode = opts.predictionMode ?? "server-authoritative";
  }

  setSnapshotHooks(hooks: SnapshotHooks): void {
    this.hooks = hooks;
  }

  /**
   * Called every tick. Snapshots realms at their respective frequencies.
   */
  tick(): void {
    this.tickCount++;

    // Near: every snapshotInterval ticks
    if (this.tickCount % this.snapshotInterval === 0) {
      this.snapshotRealm(RealmTier.Near);
    }

    // Mid: every 2× the interval
    if (this.tickCount % (this.snapshotInterval * 2) === 0) {
      this.snapshotRealm(RealmTier.Mid);
    }

    // Far: every 4× the interval
    if (this.tickCount % (this.snapshotInterval * 4) === 0) {
      this.snapshotRealm(RealmTier.Far);
    }
  }

  /**
   * Snapshot a specific realm tier.
   */
  snapshotRealm(tier: RealmTier): Uint8Array {
    const realm = this.realmManager.getRealm(tier);
    const data = realm.serialize();
    this.lastSnapshots.set(tier, { data, tick: this.tickCount });
    this.hooks?.onSnapshot?.(tier, data, this.tickCount);
    return data;
  }

  /**
   * Restore a realm from snapshot data.
   */
  restoreRealm(tier: RealmTier, data: Uint8Array): void {
    const realm = this.realmManager.getRealm(tier);
    realm.deserialize(data);
    this.hooks?.onRestore?.(tier, this.tickCount);
  }

  /**
   * Snapshot all realms. Returns a map of tier → snapshot data.
   */
  snapshotAll(): Map<RealmTier, Uint8Array> {
    const result = new Map<RealmTier, Uint8Array>();
    [RealmTier.Near, RealmTier.Mid, RealmTier.Far].forEach((tier) => {
      result.set(tier, this.snapshotRealm(tier));
    });
    return result;
  }

  /**
   * Late join: full snapshot of all realms for a new player.
   * Invokes the `onLateJoin` hook if set.
   */
  onLateJoin(playerId: string): Map<RealmTier, Uint8Array> {
    const snapshots = this.snapshotAll();
    this.playerLastSeen.set(playerId, this.tickCount);
    this.hooks?.onLateJoin?.(playerId, snapshots, this.tickCount);
    return snapshots;
  }

  /**
   * Reconnect: delta snapshot from the player's last seen tick.
   * In server-authoritative mode, this is a full snapshot (no delta).
   * In client-prediction mode, the hook can compute a delta.
   */
  onReconnect(playerId: string, lastSeenTick: number): Map<RealmTier, Uint8Array> {
    const snapshots = this.snapshotAll();
    this.playerLastSeen.set(playerId, this.tickCount);
    this.hooks?.onReconnect?.(playerId, lastSeenTick, snapshots, this.tickCount);
    return snapshots;
  }

  /**
   * Get the last snapshot for a realm tier (or null if none).
   */
  getLastSnapshot(tier: RealmTier): { data: Uint8Array; tick: number } | null {
    return this.lastSnapshots.get(tier) ?? null;
  }

  getTickCount(): number {
    return this.tickCount;
  }

  getPredictionMode(): "server-authoritative" | "client-prediction" {
    return this.predictionMode;
  }

  reset(): void {
    this.tickCount = 0;
    this.lastSnapshots.clear();
    this.playerLastSeen.clear();
  }
}
