// ============================================================================
// Vitals — shared health / damage / regen / death / respawn / meter tracking
//
// Every game in the repo used to hand-roll the same bookkeeping: clamp health
// on damage, track overkill + last-damage time, transition to a dead state,
// emit damaged/died/respawned events, regenerate after a damage-free delay,
// and tick secondary meters (oxygen / air / energy / hunger / thirst) that
// drain under a condition and deal damage while depleted.
//
// `Vitals` owns that bookkeeping while writing through to a caller-supplied
// host object (e.g. the game's player state struct) so `p.health` stays a
// plain field that saves, SAB writers, and HUDs can keep reading directly.
// ============================================================================

/** Minimal shape the host state object must expose. */
export interface VitalsHost {
  health: number;
  dead?: boolean;
}

export interface DamageEvent<Cause = unknown> {
  health: number;
  maxHealth: number;
  amount: number;
  cause: Cause | undefined;
  /** Damage beyond what was needed to reach 0 (gibbing/armor hooks). */
  overkill: number;
  died: boolean;
}

export interface MeterConfig<Cause = unknown> {
  max: number;
  /** Initial value (default: `max`). */
  initial?: number;
  /**
   * Host field the meter is bound to (e.g. `"oxygen"`). When set, the meter
   * reads/writes `host[field]` so save data and HUD reads keep working on the
   * plain field. When absent, the value is stored inside the Vitals instance.
   */
  field?: string;
  /** Units per `dt` drained while the `drainWhen` condition is true. */
  drainRate?: number;
  /** Units per `dt` recovered while the drain condition is false. */
  recoverRate?: number;
  /**
   * Condition key gating the drain. Absent = drains every update.
   * Condition keys are supplied per-update via `update(dt, conditions)`.
   */
  drainWhen?: string;
  /** Health damage per `dt` applied while the meter is at 0. */
  depleteDamageRate?: number;
  depleteDamageCause?: Cause;
  /**
   * Condition key gating depletion damage; defaults to `drainWhen` (e.g. a
   * player with 0 oxygen only drowns while still submerged). Set to `""` to
   * apply depletion damage unconditionally (starvation keeps hurting on land).
   */
  depleteWhen?: string;
  onChange?(value: number, previous: number): void;
}

export interface VitalsConfig<Cause = unknown, Host extends VitalsHost = VitalsHost> {
  maxHealth: number;
  /**
   * Health regeneration: `rate` hp per `dt` once `delay` seconds have passed
   * without damage. Absent = no regen.
   */
  regen?: { delay: number; rate: number };
  meters?: Record<string, MeterConfig<Cause>>;
  /**
   * Dead-state accessors. Defaults: `isDead` reads `host.dead ?? host.health <= 0`,
   * `setDead` writes `host.dead` (when the host has the field).
   */
  isDead?(host: Host): boolean;
  setDead?(host: Host, dead: boolean): void;
  onDamage?(event: DamageEvent<Cause>, host: Host): void;
  onDeath?(event: { cause: Cause | undefined; overkill: number }, host: Host): void;
  onRespawn?(host: Host): void;
}

export interface VitalsSnapshot {
  health: number;
  dead: boolean;
  meters?: Record<string, number>;
}

export class Vitals<Cause = unknown, Host extends VitalsHost = VitalsHost> {
  private meterValues = new Map<string, number>();
  private timeSinceDamage = Infinity;

  constructor(
    private readonly cfg: VitalsConfig<Cause, Host>,
    readonly host: Host,
  ) {}

  get health(): number {
    return this.host.health;
  }

  get maxHealth(): number {
    return this.cfg.maxHealth;
  }

  get dead(): boolean {
    return this.cfg.isDead ? this.cfg.isDead(this.host) : (this.host.dead ?? this.host.health <= 0);
  }

  private setDead(dead: boolean): void {
    if (this.cfg.setDead) this.cfg.setDead(this.host, dead);
    else if ("dead" in this.host) this.host.dead = dead;
  }

  /**
   * Apply `amount` damage. No-op (returns null) while dead or when amount <= 0.
   * Clamps health at 0, tracks overkill, resets the regen-delay timer, fires
   * `onDamage` always and `onDeath` on the killing blow.
   */
  damage(amount: number, cause?: Cause): DamageEvent<Cause> | null {
    if (this.dead || amount <= 0) return null;
    const overkill = Math.max(0, amount - this.host.health);
    this.host.health = Math.max(0, this.host.health - amount);
    this.timeSinceDamage = 0;
    const died = this.host.health <= 0;
    if (died) this.setDead(true);
    const event: DamageEvent<Cause> = {
      health: this.host.health,
      maxHealth: this.cfg.maxHealth,
      amount,
      cause,
      overkill,
      died,
    };
    this.cfg.onDamage?.(event, this.host);
    if (died) this.cfg.onDeath?.({ cause, overkill }, this.host);
    return event;
  }

  /** Heal up to `maxHealth`. Returns the amount actually applied. */
  heal(amount: number): number {
    const next = Math.min(this.cfg.maxHealth, this.host.health + Math.max(0, amount));
    const applied = next - this.host.health;
    this.host.health = next;
    return applied;
  }

  /** Kill outright (lethal damage path that bypasses the dead guard). */
  kill(cause?: Cause): void {
    if (this.dead) return;
    const overkill = 0;
    this.host.health = 0;
    this.setDead(true);
    this.cfg.onDeath?.({ cause, overkill }, this.host);
  }

  /** Restore full health (+ all meters unless `restoreMeters: false`) and clear dead. */
  respawn(opts?: { restoreMeters?: boolean }): void {
    this.host.health = this.cfg.maxHealth;
    this.setDead(false);
    this.timeSinceDamage = 0;
    if (opts?.restoreMeters !== false) {
      for (const [name, m] of Object.entries(this.cfg.meters ?? {})) {
        this.writeMeter(name, m.initial ?? m.max, m);
      }
    }
    this.cfg.onRespawn?.(this.host);
  }

  // ── Meters ──

  meter(name: string): number {
    const m = this.cfg.meters?.[name];
    if (!m) throw new Error(`Vitals: unknown meter "${name}"`);
    if (m.field) return (this.host as unknown as Record<string, number>)[m.field] ?? (m.initial ?? m.max);
    return this.meterValues.get(name) ?? (m.initial ?? m.max);
  }

  setMeter(name: string, value: number): void {
    const m = this.cfg.meters?.[name];
    if (!m) throw new Error(`Vitals: unknown meter "${name}"`);
    this.writeMeter(name, value, m);
  }

  meterMax(name: string): number {
    const m = this.cfg.meters?.[name];
    if (!m) throw new Error(`Vitals: unknown meter "${name}"`);
    return m.max;
  }

  /** Imperative drain (e.g. an action tax like sprint/climb energy). */
  drainMeter(name: string, amount: number): void {
    this.setMeter(name, this.meter(name) - Math.max(0, amount));
  }

  private writeMeter(name: string, value: number, m: MeterConfig<Cause>): void {
    const clamped = Math.max(0, Math.min(m.max, value));
    const prev = this.meter(name);
    if (m.field) (this.host as unknown as Record<string, number>)[m.field] = clamped;
    else this.meterValues.set(name, clamped);
    if (clamped !== prev) m.onChange?.(clamped, prev);
  }

  /**
   * Advance meters + health regen by `dt`. `dt` is in whatever unit the rates
   * use — seconds for per-second rates, or 1 per fixed tick for per-tick rates.
   *
   * Condition values may be `boolean | number`: a number > 0 counts as active
   * and multiplies the meter's `drainRate` (e.g. a biome's oxygen drain
   * multiplier); depletion gates only check truthiness.
   *
   * Meter rules per update:
   *  - drains at `drainRate × conditionValue` while `conditions[drainWhen]` is
   *    truthy (or always at `drainRate` when no `drainWhen` is set)
   *  - recovers at `recoverRate` while the drain condition is falsy
   *  - while at 0, applies `depleteDamageRate` health damage gated by
   *    `conditions[depleteWhen ?? drainWhen]` (or unconditional when neither set)
   */
  update(dt: number, conditions: Record<string, boolean | number> = {}): void {
    this.timeSinceDamage += dt;
    for (const [name, m] of Object.entries(this.cfg.meters ?? {})) {
      const cond = m.drainWhen === undefined ? true : conditions[m.drainWhen];
      const drainMul = cond === true ? 1 : cond || 0;
      if (drainMul > 0) {
        if (m.drainRate) this.writeMeter(name, this.meter(name) - m.drainRate * drainMul * dt, m);
      } else if (m.recoverRate) {
        this.writeMeter(name, this.meter(name) + m.recoverRate * dt, m);
      }
      if (m.depleteDamageRate && this.meter(name) <= 0) {
        const gate = m.depleteWhen ?? m.drainWhen;
        if (gate === undefined || gate === "" || conditions[gate]) {
          this.damage(m.depleteDamageRate * dt, m.depleteDamageCause);
        }
      }
    }
    const regen = this.cfg.regen;
    if (regen && !this.dead && this.host.health < this.cfg.maxHealth && this.timeSinceDamage >= regen.delay) {
      this.heal(regen.rate * dt);
    }
  }

  // ── Save / load ──

  serialize(): VitalsSnapshot {
    const snap: VitalsSnapshot = { health: this.host.health, dead: this.dead };
    const meters = this.cfg.meters;
    if (meters && Object.keys(meters).length > 0) {
      snap.meters = {};
      for (const name of Object.keys(meters)) snap.meters[name] = this.meter(name);
    }
    return snap;
  }

  restore(snap: Partial<VitalsSnapshot> | undefined): void {
    if (!snap) return;
    if (typeof snap.health === "number") this.host.health = Math.min(this.cfg.maxHealth, snap.health);
    if (typeof snap.dead === "boolean") this.setDead(snap.dead);
    if (snap.meters) {
      for (const [name, v] of Object.entries(snap.meters)) {
        if (this.cfg.meters?.[name]) this.setMeter(name, v);
      }
    }
    // Restart the regen-delay window — a restored player waits for the delay
    // before regenerating, same as one that just took damage.
    this.timeSinceDamage = 0;
  }
}
