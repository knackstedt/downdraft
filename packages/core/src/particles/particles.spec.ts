import { createExplosionEmitter, createFireEmitter, createParticleEmitter, createSmokeEmitter, createSparkEmitter } from "./emitter";
import { createParticleGPUData, packParticleBuffer } from "./particle-data";
import { ParticleSimulator } from "./simulator";
import { ParticleSystem } from "./system";

describe("ParticleEmitter", () => {
  it("should create a default emitter", () => {
    const emitter = createParticleEmitter();
    expect(emitter.emissionRate).toBeGreaterThan(0);
    expect(emitter.lifetime).toBeGreaterThan(0);
    expect(emitter.maxParticles).toBeGreaterThan(0);
  });

  it("createFireEmitter should have fire-like properties", () => {
    const emitter = createFireEmitter();
    expect(emitter.emissionRate).toBeGreaterThan(0);
    expect(emitter.startColor).toBeDefined();
    expect(emitter.endColor).toBeDefined();
  });

  it("createSmokeEmitter should have smoke-like properties", () => {
    const emitter = createSmokeEmitter();
    expect(emitter.emissionRate).toBeGreaterThan(0);
    expect(emitter.gravity[1]).toBeLessThanOrEqual(0);
  });

  it("createSparkEmitter should have spark-like properties", () => {
    const emitter = createSparkEmitter();
    expect(emitter.emissionRate).toBeGreaterThan(0);
    expect(emitter.speed).toBeGreaterThan(0);
  });

  it("createExplosionEmitter should have explosion-like properties", () => {
    const emitter = createExplosionEmitter();
    expect(emitter.emissionRate).toBeGreaterThan(0);
    expect(emitter.maxParticles).toBeGreaterThan(0);
  });

  it("should have valid shape", () => {
    const emitter = createParticleEmitter();
    expect(emitter.shape).toBeDefined();
    expect(["point", "sphere", "box", "cone", "disc"]).toContain(emitter.shape.type);
  });
});

describe("ParticleGPUData", () => {
  it("should create particle GPU data with correct array sizes", () => {
    const count = 100;
    const data = createParticleGPUData(count);
    expect(data.position.length).toBe(count * 3);
    expect(data.velocity.length).toBe(count * 3);
    expect(data.color.length).toBe(count * 4);
    expect(data.size.length).toBe(count);
    expect(data.lifetime.length).toBe(count);
    expect(data.rotation.length).toBe(count);
    expect(data.active.length).toBe(count);
  });

  it("should initialize all particles as inactive", () => {
    const data = createParticleGPUData(10);
    for (let i = 0; i < 10; i++) {
      expect(data.active[i]).toBe(0);
    }
  });

  it("packParticleBuffer should return Float32Array with 12 floats per particle", () => {
    const count = 5;
    const data = createParticleGPUData(count);
    const packed = packParticleBuffer(data, count);
    expect(packed).toBeInstanceOf(Float32Array);
    expect(packed.length).toBe(count * 12);
  });

  it("packParticleBuffer should interleave data correctly", () => {
    const count = 1;
    const data = createParticleGPUData(count);
    data.position[0] = 1; data.position[1] = 2; data.position[2] = 3;
    data.color[0] = 0.5; data.color[1] = 0.6; data.color[2] = 0.7; data.color[3] = 1.0;
    data.size[0] = 4;
    data.lifetime[0] = 5;
    data.rotation[0] = 6;
    data.active[0] = 1;

    const packed = packParticleBuffer(data, count);
    expect(packed[0]).toBe(1);
    expect(packed[1]).toBe(2);
    expect(packed[2]).toBe(3);
  });
});

describe("ParticleSimulator", () => {
  it("should construct with emitter data", () => {
    const emitter = createParticleEmitter();
    const sim = new ParticleSimulator(emitter);
    expect(sim).toBeDefined();
  });

  it("should update without error", () => {
    const emitter = createParticleEmitter();
    const sim = new ParticleSimulator(emitter);
    expect(() => sim.update(0.016)).not.toThrow();
  });

  it("should emit particles over time", () => {
    const emitter = createParticleEmitter();
    emitter.maxParticles = 100;
    const sim = new ParticleSimulator(emitter);
    for (let i = 0; i < 60; i++) {
      sim.update(0.016);
    }
    const data = sim.getParticleData();
    let activeCount = 0;
    for (let i = 0; i < emitter.maxParticles; i++) {
      if (data.active[i] > 0) activeCount++;
    }
    expect(activeCount).toBeGreaterThan(0);
  });

  it("should respect max particles", () => {
    const emitter = createParticleEmitter();
    emitter.maxParticles = 10;
    const sim = new ParticleSimulator(emitter);
    for (let i = 0; i < 100; i++) {
      sim.update(0.016);
    }
    const data = sim.getParticleData();
    let activeCount = 0;
    for (let i = 0; i < emitter.maxParticles; i++) {
      if (data.active[i] > 0) activeCount++;
    }
    expect(activeCount).toBeLessThanOrEqual(emitter.maxParticles);
  });

  it("should apply gravity", () => {
    const emitter = createParticleEmitter();
    emitter.gravity = [0, -9.81, 0];
    emitter.maxParticles = 1;
    const sim = new ParticleSimulator(emitter);
    sim.update(0.016);
    const data = sim.getParticleData();
    for (let i = 0; i < emitter.maxParticles; i++) {
      if (data.active[i] > 0) {
        expect(data.velocity[i * 3 + 1]).toBeLessThanOrEqual(0);
      }
    }
  });

  it("should get particle data", () => {
    const emitter = createParticleEmitter();
    const sim = new ParticleSimulator(emitter);
    const data = sim.getParticleData();
    expect(data).toBeDefined();
    expect(data.position).toBeDefined();
    expect(data.velocity).toBeDefined();
  });

  it("should not divide by zero when maxLifetime is zero", () => {
    const emitter = createParticleEmitter();
    emitter.maxParticles = 1;
    emitter.lifetime = 0;
    emitter.lifetimeVariance = 0;
    const sim = new ParticleSimulator(emitter);
    // Emit a particle with zero lifetime
    sim.update(0.016);
    const data = sim.getParticleData();
    // Force maxLifetime to 0 and lifetime to a positive value to test the guard
    data.maxLifetime[0] = 0;
    data.lifetime[0] = 1;
    data.active[0] = 1;
    // This should not produce NaN or throw
    expect(() => sim.update(0.016)).not.toThrow();
    // Check no NaN in color channels
    for (let i = 0; i < 4; i++) {
      expect(Number.isNaN(data.color[i])).toBe(false);
    }
  });
});

describe("ParticleSystem emitter IDs", () => {
  it("should assign unique sequential emitter IDs", () => {
    const sys = new ParticleSystem({ maxParticlesPerEmitter: 10, useGPUCompute: false, surfaceFormat: "rgba8unorm" });
    const id1 = sys.registerEmitter(createParticleEmitter());
    const id2 = sys.registerEmitter(createParticleEmitter());
    expect(id1).toBeGreaterThanOrEqual(0);
    expect(id2).toBe(id1 + 1);
  });

  it("should keep emitter IDs within safe integer range", () => {
    const sys = new ParticleSystem({ maxParticlesPerEmitter: 10, useGPUCompute: false, surfaceFormat: "rgba8unorm" });
    const id = sys.registerEmitter(createParticleEmitter());
    expect(id).toBeGreaterThanOrEqual(0);
    expect(id).toBeLessThan(0x7fffffff);
  });
});
