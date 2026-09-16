import { describe, expect, it } from "bun:test";
import { Vitals } from "./vitals";

interface Host {
  health: number;
  dead: boolean;
  oxygen?: number;
}

function makeHost(health = 100): Host {
  return { health, dead: false };
}

describe("Vitals", () => {
  it("clamps damage at 0 and reports overkill", () => {
    const host = makeHost(30);
    const v = new Vitals({ maxHealth: 100 }, host);
    const e = v.damage(50, "hit")!;
    expect(host.health).toBe(0);
    expect(e.overkill).toBe(20);
    expect(e.died).toBe(true);
    expect(host.dead).toBe(true);
  });

  it("ignores damage while dead and non-positive amounts", () => {
    const host = makeHost(0);
    host.dead = true;
    const v = new Vitals({ maxHealth: 100 }, host);
    expect(v.damage(10)).toBeNull();
    host.dead = false;
    host.health = 50;
    expect(v.damage(0)).toBeNull();
    expect(v.damage(-5)).toBeNull();
    expect(host.health).toBe(50);
  });

  it("fires onDamage then onDeath on a killing blow", () => {
    const order: string[] = [];
    const host = makeHost(10);
    const v = new Vitals(
      {
        maxHealth: 100,
        onDamage: () => order.push("damage"),
        onDeath: () => order.push("death"),
      },
      host,
    );
    v.damage(10);
    expect(order).toEqual(["damage", "death"]);
  });

  it("heals up to maxHealth and reports the applied amount", () => {
    const host = makeHost(90);
    const v = new Vitals({ maxHealth: 100 }, host);
    expect(v.heal(30)).toBe(10);
    expect(host.health).toBe(100);
  });

  it("regenerates only after the damage-free delay", () => {
    const host = makeHost(50);
    const v = new Vitals({ maxHealth: 100, regen: { delay: 5, rate: 10 } }, host);
    v.update(10); // long idle: regen applies
    expect(host.health).toBe(100);
    v.damage(40);
    v.update(3); // inside the delay window: no regen
    expect(host.health).toBe(60);
    v.update(3); // past the delay: regen resumes
    expect(host.health).toBe(90);
  });

  it("does not regen while dead", () => {
    const host = makeHost(5);
    const v = new Vitals({ maxHealth: 100, regen: { delay: 0, rate: 10 } }, host);
    v.damage(5);
    v.update(10);
    expect(host.health).toBe(0);
    expect(host.dead).toBe(true);
  });

  it("drains a condition-gated meter and applies depletion damage", () => {
    const host = makeHost();
    const v = new Vitals<string, Host>(
      {
        maxHealth: 100,
        meters: {
          oxygen: { field: "oxygen", max: 10, drainRate: 1, drainWhen: "submerged", recoverRate: 5, depleteDamageRate: 2, depleteDamageCause: "drown" },
        },
      },
      host,
    );
    v.update(1, { submerged: true });
    expect(host.oxygen).toBe(9);
    // Numeric condition scales the drain rate.
    v.update(1, { submerged: 4 });
    expect(host.oxygen).toBe(5);
    // Recover while not submerged.
    v.update(1, { submerged: false });
    expect(host.oxygen).toBe(10);
    // Drain to 0 — the tick that depletes the meter already deals damage
    // (matches the original games' drain-then-check ordering).
    for (let i = 0; i < 10; i++) v.update(1, { submerged: true });
    expect(host.oxygen).toBe(0);
    expect(host.health).toBe(98);
    v.update(1, { submerged: true });
    expect(host.health).toBe(96);
    // Surfaced at 0 oxygen: no damage, starts refilling.
    v.update(1, { submerged: false });
    expect(host.health).toBe(96);
    expect(host.oxygen).toBe(5);
  });

  it("respawn restores health + meters and fires onRespawn", () => {
    const host = makeHost(0);
    host.dead = true;
    host.oxygen = 0;
    let respawned = false;
    const v = new Vitals(
      {
        maxHealth: 100,
        meters: { oxygen: { field: "oxygen", max: 10 } },
        onRespawn: () => { respawned = true; },
      },
      host,
    );
    v.respawn();
    expect(host.health).toBe(100);
    expect(host.dead).toBe(false);
    expect(host.oxygen).toBe(10);
    expect(respawned).toBe(true);
  });

  it("serializes and restores health, dead, and meters", () => {
    const host = makeHost(40);
    host.oxygen = 3;
    const v = new Vitals({ maxHealth: 100, meters: { oxygen: { field: "oxygen", max: 10 } } }, host);
    const snap = v.serialize();
    expect(snap).toEqual({ health: 40, dead: false, meters: { oxygen: 3 } });
    host.health = 100;
    host.oxygen = 10;
    v.restore(snap);
    expect(host.health).toBe(40);
    expect(host.oxygen).toBe(3);
  });

  it("defaults isDead to health <= 0 when the host has no dead field", () => {
    const host = { health: 0 };
    const v = new Vitals({ maxHealth: 100 }, host);
    expect(v.dead).toBe(true);
  });
});
