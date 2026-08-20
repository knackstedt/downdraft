import { expect, test } from "bun:test";
import { ParticleSystem, PARTICLE_TYPES } from "./particles";

test("particle system starts empty", () => {
  const ps = new ParticleSystem(64);
  expect(ps.activeCount).toBe(0);
});

test("spawn creates an active particle", () => {
  const ps = new ParticleSystem(64);
  ps.spawn(5, 10, PARTICLE_TYPES.PROJECTILE, 0xffaa3300, 2, 1, -1, 30);
  expect(ps.activeCount).toBe(1);
  const p = ps.getParticle(0);
  expect(p).not.toBeNull();
  expect(p!.x).toBe(5);
  expect(p!.y).toBe(10);
  expect(p!.type).toBe(PARTICLE_TYPES.PROJECTILE);
  expect(p!.active).toBe(true);
});

test("update advances particle physics and ages", () => {
  const ps = new ParticleSystem(64);
  ps.spawn(0, 0, PARTICLE_TYPES.PROJECTILE, 0xffaa3300, 1, 2, 3, 5);
  ps.update();
  const p = ps.getParticle(0);
  expect(p!.x).toBe(2); // x += vx
  expect(p!.y).toBe(3); // y += vy
  expect(p!.life).toBe(1);
});

test("particles are culled when life expires", () => {
  const ps = new ParticleSystem(64);
  ps.spawn(0, 0, PARTICLE_TYPES.PROJECTILE, 0xffaa3300, 1, 0, 0, 3);
  ps.update();
  ps.update();
  ps.update();
  expect(ps.activeCount).toBe(0);
});

test("projectile particles decelerate", () => {
  const ps = new ParticleSystem(64);
  ps.spawn(0, 0, PARTICLE_TYPES.PROJECTILE, 0xffaa3300, 1, 10, 0, 100);
  ps.update();
  const p = ps.getParticle(0);
  // vx should have decayed (10 * 0.92 = 9.2)
  expect(p!.vx).toBeLessThan(10);
  expect(p!.vx).toBeGreaterThan(8);
});

test("circle particles expand", () => {
  const ps = new ParticleSystem(64);
  ps.spawn(0, 0, PARTICLE_TYPES.CIRCLE, 0xffff6600, 2, 0, 0, 100);
  ps.update();
  const p = ps.getParticle(0);
  // size should have grown (2 + 0.3 = 2.3)
  expect(p!.size).toBeGreaterThan(2);
});

test("pool reuse: inactive slots are reused", () => {
  const ps = new ParticleSystem(64);
  // Spawn and kill a particle
  ps.spawn(1, 1, PARTICLE_TYPES.SLUG, 0xff00ff00, 1, 0, 0, 1);
  ps.update(); // life=1 >= maxLife=1 → dead
  expect(ps.activeCount).toBe(0);
  // Spawn a new particle — should reuse slot 0
  ps.spawn(2, 2, PARTICLE_TYPES.PROJECTILE, 0xffaa3300, 1, 0, 0, 10);
  const p = ps.getParticle(0);
  expect(p).not.toBeNull();
  expect(p!.x).toBe(2);
  expect(p!.type).toBe(PARTICLE_TYPES.PROJECTILE);
});

test("writeToBuffer outputs active particles", () => {
  const ps = new ParticleSystem(64);
  ps.spawn(1, 2, PARTICLE_TYPES.PROJECTILE, 0xffaa3300, 3, 4, 5, 30);
  const buf = new Float32Array(64 * 8);
  const count = ps.writeToBuffer(buf, 0);
  expect(count).toBe(1);
  expect(buf[0]).toBe(1); // x
  expect(buf[1]).toBe(2); // y
  expect(buf[2]).toBe(4); // vx
  expect(buf[3]).toBe(5); // vy
  expect(buf[4]).toBe(0xffaa3300); // color
  expect(buf[5]).toBe(3); // size
  expect(buf[7]).toBe(PARTICLE_TYPES.PROJECTILE); // type
});

test("clear removes all particles", () => {
  const ps = new ParticleSystem(64);
  ps.spawn(0, 0, PARTICLE_TYPES.PROJECTILE, 0, 1, 0, 0, 10);
  ps.spawn(1, 1, PARTICLE_TYPES.CIRCLE, 0, 1, 0, 0, 10);
  expect(ps.activeCount).toBe(2);
  ps.clear();
  expect(ps.activeCount).toBe(0);
});

// --- Integration: explode spawns particles ---

test("explode spawns explosion particles", () => {
  // Import here to avoid circular dependency issues in test setup
  const { Material, SandWorld } = require("./index");
  const w = new SandWorld(16, 16);
  w.reseed(42);
  // Place some material to be destroyed
  w.setCell(8, 8, { mat: Material.Sand, lifetime: 0, flags: 0 });
  // Trigger an explosion via antimatter (which calls explode internally)
  w.setCell(7, 8, { mat: Material.Antimatter, lifetime: 0, flags: 0 });
  w.step();
  // Particles should have been spawned
  const ps = w.getParticles();
  expect(ps.activeCount).toBeGreaterThan(0);
});
