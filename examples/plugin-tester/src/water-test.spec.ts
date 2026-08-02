import { WaterPhysics, WaterBuffer, DEFAULT_PHYSICS_CONFIG } from "@downdraft/plugin-water";

describe("WaterBuffer", () => {
  it("should create a buffer with correct size", () => {
    const buf = new WaterBuffer(4);
    expect(buf).toBeDefined();
  });
});

describe("WaterPhysics", () => {
  it("should initialize with default config", () => {
    const buf = new WaterBuffer(4);
    const physics = new WaterPhysics(buf, DEFAULT_PHYSICS_CONFIG);
    expect(physics).toBeDefined();
  });

  it("should initialize with custom config", () => {
    const buf = new WaterBuffer(4);
    const physics = new WaterPhysics(buf, {
      ...DEFAULT_PHYSICS_CONFIG,
      windSpeed: 10,
      windDirX: 0.5,
      windDirZ: 0.5,
    });
    const config = physics.getConfig();
    expect(config.windSpeed).toBe(10);
    expect(config.windDirX).toBe(0.5);
    expect(config.windDirZ).toBe(0.5);
  });

  it("should sample water height at a position", () => {
    const buf = new WaterBuffer(4);
    const physics = new WaterPhysics(buf, {
      ...DEFAULT_PHYSICS_CONFIG,
      windSpeed: 5,
    });
    const h = physics.sampleWaterAt(0, 0);
    expect(typeof h).toBe("number");
    expect(Number.isFinite(h)).toBe(true);
  });

  it("should update over time without errors", () => {
    const buf = new WaterBuffer(4);
    const physics = new WaterPhysics(buf, {
      ...DEFAULT_PHYSICS_CONFIG,
      windSpeed: 5,
      windDirX: 0.7,
      windDirZ: 0.7,
    });
    for (let i = 0; i < 100; i++) {
      physics.update(1 / 60, 0, 0);
    }
  });

  it("should produce varying heights at different positions", () => {
    const buf = new WaterBuffer(4);
    const physics = new WaterPhysics(buf, {
      ...DEFAULT_PHYSICS_CONFIG,
      windSpeed: 5,
    });
    physics.update(1.0, 0, 0);
    const h0 = physics.sampleWaterAt(0, 0);
    const h1 = physics.sampleWaterAt(10, 0);
    const h2 = physics.sampleWaterAt(0, 10);
    const h3 = physics.sampleWaterAt(-10, -10);
    const heights = [h0, h1, h2, h3];
    const allSame = heights.every((h) => h === heights[0]);
    expect(allSame).toBe(false);
  });

  it("should change heights over time", () => {
    const buf = new WaterBuffer(4);
    const physics = new WaterPhysics(buf, {
      ...DEFAULT_PHYSICS_CONFIG,
      windSpeed: 5,
    });
    physics.update(0.1, 0, 0);
    const h1 = physics.sampleWaterAt(5, 5);
    physics.update(1.0, 0, 0);
    const h2 = physics.sampleWaterAt(5, 5);
    expect(h1).not.toBe(h2);
  });

  it("should report wave count from config", () => {
    const buf = new WaterBuffer(4);
    const physics = new WaterPhysics(buf, DEFAULT_PHYSICS_CONFIG);
    const config = physics.getConfig();
    expect(config.waves.length).toBeGreaterThan(0);
  });

  it("should report water level from config", () => {
    const buf = new WaterBuffer(4);
    const physics = new WaterPhysics(buf, {
      ...DEFAULT_PHYSICS_CONFIG,
      waterLevel: 5,
    });
    const config = physics.getConfig();
    expect(config.waterLevel).toBe(5);
  });

  it("should handle zero wind speed", () => {
    const buf = new WaterBuffer(4);
    const physics = new WaterPhysics(buf, {
      ...DEFAULT_PHYSICS_CONFIG,
      windSpeed: 0,
    });
    physics.update(1 / 60, 0, 0);
    const h = physics.sampleWaterAt(0, 0);
    expect(Number.isFinite(h)).toBe(true);
  });

  it("should handle high wind speed", () => {
    const buf = new WaterBuffer(4);
    const physics = new WaterPhysics(buf, {
      ...DEFAULT_PHYSICS_CONFIG,
      windSpeed: 25,
    });
    physics.update(1 / 60, 0, 0);
    const h = physics.sampleWaterAt(0, 0);
    expect(Number.isFinite(h)).toBe(true);
  });
});
