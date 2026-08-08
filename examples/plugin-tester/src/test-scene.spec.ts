// ============================================================================
// Test Scene Integration Tests — verify the combined test scene works
// ============================================================================

import { initTestScene } from "./test-scene";

describe("TestScene Integration", () => {
  it("should initialize without errors", () => {
    const scene = initTestScene();
    expect(scene).toBeDefined();
    expect(scene.navmesh).toBeDefined();
    expect(scene.water).toBeDefined();
  });

  it("should report navmesh polygon count", () => {
    const scene = initTestScene();
    const snapshot = scene.getSnapshot() as any;
    expect(snapshot.navmesh.polyCount).toBeGreaterThan(0);
  });

  it("should report agents with positions", () => {
    const scene = initTestScene();
    const snapshot = scene.getSnapshot() as any;
    expect(snapshot.navmesh.agents.length).toBe(5);
    for (const agent of snapshot.navmesh.agents) {
      expect(agent.pos.length).toBe(3);
      expect(typeof agent.state).toBe("string");
    }
  });

  it("should report water state", () => {
    const scene = initTestScene();
    const snapshot = scene.getSnapshot() as any;
    expect(snapshot.water.windSpeed).toBeGreaterThan(0);
    expect(snapshot.water.waveCount).toBeGreaterThan(0);
    expect(snapshot.water.sampleHeights.length).toBe(4);
  });

  it("should produce agent visuals for rendering", () => {
    const scene = initTestScene();
    const visuals = scene.getAgentVisuals();
    expect(visuals.length).toBe(5);
    for (const v of visuals) {
      expect(v.position.length).toBe(3);
      expect(v.color.length).toBe(3);
      expect(v.size).toBeGreaterThan(0);
    }
  });

  it("should tick without errors", () => {
    const scene = initTestScene();
    for (let i = 0; i < 10; i++) {
      scene.tick(1 / 60);
    }
  });

  it("should move agents over time", () => {
    const scene = initTestScene();
    const snapshot1 = scene.getSnapshot() as any;
    const pos1 = [...snapshot1.navmesh.agents[0].pos];

    for (let i = 0; i < 120; i++) {
      scene.tick(1 / 60);
    }

    const snapshot2 = scene.getSnapshot() as any;
    const pos2 = [...snapshot2.navmesh.agents[0].pos];

    const moved = pos1[0] !== pos2[0] || pos1[2] !== pos2[2];
    expect(moved).toBe(true);
  });

  it("should update water heights over time", () => {
    const scene = initTestScene();
    const snap1 = scene.getSnapshot() as any;
    const h1 = [...snap1.water.sampleHeights];

    for (let i = 0; i < 60; i++) {
      scene.tick(1 / 60);
    }

    const snap2 = scene.getSnapshot() as any;
    const h2 = [...snap2.water.sampleHeights];

    const changed = h1.some((h, i) => h !== h2[i]);
    expect(changed).toBe(true);
  });

  it("should handle many ticks without crashing", () => {
    const scene = initTestScene();
    for (let i = 0; i < 1000; i++) {
      scene.tick(1 / 60);
    }
    const snap = scene.getSnapshot() as any;
    expect(snap.navmesh.agents.length).toBe(5);
  });
});
