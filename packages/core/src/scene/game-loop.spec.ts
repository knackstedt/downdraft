import { Stage, system } from "../ecs/system";
import { World } from "../ecs/world";
import { GameLoop } from "./game-loop";
import { Scene } from "./scene";
import { GameWorld } from "./world";

function makeGameWorld(): GameWorld {
  const world = new World();
  const scene = new Scene("test", world);
  return new GameWorld(scene);
}

function makeMockRenderCallback(): { alphaValues: number[]; renderCount: number; cb: (alpha: number) => void } {
  const mock = {
    alphaValues: [] as number[],
    renderCount: 0,
    cb(alpha: number) {
      mock.renderCount++;
      mock.alphaValues.push(alpha);
    },
  };
  return mock;
}

describe("GameLoop", () => {
  it("should run fixed-timestep simulation steps", () => {
    const gw = makeGameWorld();
    let stepCount = 0;
    gw.world.schedule.addSystem(system("counter", Stage.Update, () => { stepCount++; }));

    const loop = new GameLoop(gw, { fixedDt: 0.016, maxStepsPerFrame: 5 });
    loop.start();

    // Simulate one frame with exactly 3 fixed steps worth of time
    const steps = loop.runFrame(0.048);

    expect(stepCount).toBe(3);
    expect(steps).toBe(3);
    loop.stop();
  });

  it("should compute interpolation alpha", () => {
    const gw = makeGameWorld();
    const loop = new GameLoop(gw, { fixedDt: 0.016, maxStepsPerFrame: 5 });
    loop.start();

    // 0.024s = 1 full step (0.016) + 0.008 remainder → alpha = 0.008/0.016 = 0.5
    loop.runFrame(0.024);
    expect(loop.getAlpha()).toBeCloseTo(0.5, 5);

    loop.stop();
  });

  it("should cap steps at maxStepsPerFrame to prevent spiral of death", () => {
    const gw = makeGameWorld();
    let stepCount = 0;
    gw.world.schedule.addSystem(system("counter", Stage.Update, () => { stepCount++; }));

    const loop = new GameLoop(gw, { fixedDt: 0.016, maxStepsPerFrame: 3 });
    loop.start();

    // 1.0s of accumulated time would need 62 steps, but cap is 3
    const steps = loop.runFrame(1.0);
    expect(steps).toBe(3);
    expect(stepCount).toBe(3);

    // Accumulator should be clamped to prevent unbounded growth
    expect(loop.getAccumulator()).toBeLessThan(0.016 * 3);

    loop.stop();
  });

  it("should call onRender with alpha when provided", () => {
    const gw = makeGameWorld();
    const mock = makeMockRenderCallback();

    const loop = new GameLoop(gw, { fixedDt: 0.016, maxStepsPerFrame: 5, onRender: mock.cb });
    loop.start();

    // 0.024s → 1 step, alpha = 0.5
    loop.runFrame(0.024);

    expect(mock.renderCount).toBe(1);
    expect(mock.alphaValues).toEqual([0.5]);

    loop.stop();
  });

  it("should handle zero delta time gracefully", () => {
    const gw = makeGameWorld();
    let stepCount = 0;
    gw.world.schedule.addSystem(system("counter", Stage.Update, () => { stepCount++; }));

    const loop = new GameLoop(gw, { fixedDt: 0.016, maxStepsPerFrame: 5 });
    loop.start();

    const steps = loop.runFrame(0);
    expect(steps).toBe(0);
    expect(stepCount).toBe(0);
    expect(loop.getAlpha()).toBe(0);

    loop.stop();
  });

  it("should pass alpha to GameWorld resources", () => {
    const gw = makeGameWorld();
    const loop = new GameLoop(gw, { fixedDt: 0.016, maxStepsPerFrame: 5 });
    loop.start();

    // 0.024s → 1 step + 0.008 remainder → alpha = 0.5
    loop.runFrame(0.024);

    expect(gw.resources.alpha).toBeCloseTo(0.5, 5);

    loop.stop();
  });

  it("should run Stage.Render systems during world.step()", () => {
    const gw = makeGameWorld();
    let renderRan = false;
    gw.world.schedule.addSystem(system("render-prep", Stage.Render, () => { renderRan = true; }));

    const loop = new GameLoop(gw, { fixedDt: 0.016, maxStepsPerFrame: 5 });
    loop.start();
    loop.runFrame(0.016);

    expect(renderRan).toBe(true);
    loop.stop();
  });

  it("should track FPS", () => {
    const gw = makeGameWorld();
    const loop = new GameLoop(gw, { fixedDt: 0.016, maxStepsPerFrame: 5 });
    loop.start();

    // Run several frames at ~16ms
    for (let i = 0; i < 65; i++) {
      loop.runFrame(0.016);
    }

    // After ~1 second of frames, FPS should be roughly 60+
    expect(loop.getFPS()).toBeGreaterThan(0);

    loop.stop();
  });

  it("should allow runtime config changes", () => {
    const gw = makeGameWorld();
    const loop = new GameLoop(gw, { fixedDt: 0.016, maxStepsPerFrame: 5 });
    loop.start();

    expect(loop.getFixedDt()).toBe(0.016);
    loop.setFixedDt(0.033);
    expect(loop.getFixedDt()).toBe(0.033);
    expect(loop.getAccumulator()).toBe(0);

    loop.setMaxStepsPerFrame(2);
    expect(loop.getMaxStepsPerFrame()).toBe(2);

    loop.stop();
  });

  it("should reject NaN frameDt", () => {
    const gw = makeGameWorld();
    let stepCount = 0;
    gw.world.schedule.addSystem(system("counter", Stage.Update, () => { stepCount++; }));
    const loop = new GameLoop(gw, { fixedDt: 0.016, maxStepsPerFrame: 5 });
    loop.start();

    const steps = loop.runFrame(NaN);
    expect(steps).toBe(0);
    expect(stepCount).toBe(0);
    loop.stop();
  });

  it("should reject Infinity frameDt", () => {
    const gw = makeGameWorld();
    let stepCount = 0;
    gw.world.schedule.addSystem(system("counter", Stage.Update, () => { stepCount++; }));
    const loop = new GameLoop(gw, { fixedDt: 0.016, maxStepsPerFrame: 5 });
    loop.start();

    const steps = loop.runFrame(Infinity);
    expect(steps).toBe(0);
    expect(stepCount).toBe(0);
    loop.stop();
  });

  it("should reject negative frameDt", () => {
    const gw = makeGameWorld();
    let stepCount = 0;
    gw.world.schedule.addSystem(system("counter", Stage.Update, () => { stepCount++; }));
    const loop = new GameLoop(gw, { fixedDt: 0.016, maxStepsPerFrame: 5 });
    loop.start();

    const steps = loop.runFrame(-1);
    expect(steps).toBe(0);
    expect(stepCount).toBe(0);
    loop.stop();
  });
});

describe("GameWorld SceneManager integration", () => {
  it("should expose sceneManager on GameWorld", () => {
    const gw = makeGameWorld();
    expect(gw.sceneManager).toBeDefined();
    expect(gw.sceneManager.getCurrentScene()).toBeNull();
  });

  it("should register the initial scene in SceneManager", () => {
    const gw = makeGameWorld();
    expect(gw.sceneManager.has("test")).toBe(true);
    expect(gw.sceneManager.get("test")).toBe(gw.scene);
  });

  it("should dispose SceneManager on GameWorld.dispose()", () => {
    const gw = makeGameWorld();
    const scene = gw.sceneManager.create("extra", (s) => {
      s.spawn(new Map());
    });
    // Load to populate entities
    scene.load();
    expect(gw.world.entityCount()).toBeGreaterThan(1);

    gw.dispose();
    // After dispose, all scenes unloaded and cleared
    expect(gw.sceneManager.list()).toHaveLength(0);
    expect(gw.sceneManager.getCurrentScene()).toBeNull();
  });

  it("should support scene transition via SceneManager", async () => {
    const gw = makeGameWorld();
    const scene2 = gw.sceneManager.create("level2", (s) => {
      s.spawn(new Map());
    });

    // Activate initial scene
    gw.sceneManager.activate("test");
    expect(gw.sceneManager.getCurrentScene()).toBe(gw.scene);

    // Transition to level2
    await gw.sceneManager.transition("level2");
    expect(gw.sceneManager.getCurrentScene()).toBe(scene2);
    expect(scene2.isActive()).toBe(true);
  });
});
