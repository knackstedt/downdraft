import { Stage, system } from "../ecs/system.ts";
import { World } from "../ecs/world.ts";
import { GameLoop } from "./game-loop.ts";
import { Scene } from "./scene.ts";
import { GameWorld } from "./world.ts";

function makeGameWorld(): GameWorld {
  const world = new World();
  const scene = new Scene("test", world);
  return new GameWorld(scene);
}

function makeMockRenderLoop(): any {
  const mock = {
    alphaValues: [] as number[],
    renderCount: 0,
    _autonomous: true,
    _running: false,
    setAutonomous(a: boolean) { this._autonomous = a; },
    isAutonomous() { return this._autonomous; },
    setAlpha(a: number) {},
    getAlpha() { return 0; },
    start() { this._running = true; },
    stop() { this._running = false; },
    renderFrame(alpha?: number) {
      this.renderCount++;
      if (alpha !== undefined) this.alphaValues.push(alpha);
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

  it("should call renderLoop.renderFrame with alpha when renderLoop is provided", () => {
    const gw = makeGameWorld();
    const mock = makeMockRenderLoop();

    const loop = new GameLoop(gw, { fixedDt: 0.016, maxStepsPerFrame: 5, renderLoop: mock });
    loop.start();

    // Should have set autonomous to false
    expect(mock.isAutonomous()).toBe(false);

    // 0.024s → 1 step, alpha = 0.5
    loop.runFrame(0.024);

    expect(mock.renderCount).toBe(1);
    expect(mock.alphaValues).toEqual([0.5]);

    loop.stop();
  });

  it("should set renderLoop to non-autonomous on construction", () => {
    const gw = makeGameWorld();
    const mock = makeMockRenderLoop();
    expect(mock.isAutonomous()).toBe(true);

    new GameLoop(gw, { fixedDt: 0.016, maxStepsPerFrame: 5, renderLoop: mock });
    expect(mock.isAutonomous()).toBe(false);
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
});
