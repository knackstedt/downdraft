// ============================================================================
// Test Registry — the core extensibility API for the visual test bench
//
// Tests register themselves via `registerTest()`. Each test provides a
// renderer factory + optional controls. The bench discovers tests via
// Vite glob import (see tests/index.ts).
//
// Game authors add their own tests by creating a `*.test.ts` file in
// `src/tests/` that calls `registerTest()` at module load time.
// ============================================================================

export interface TestContext {
  device: GPUDevice;
  canvas: HTMLCanvasElement;
  format: GPUTextureFormat;
  width: number;
  height: number;
  dt: number;
  elapsedTime: number;
}

/** A renderer created by a test's `createRenderer()`. */
export interface ITestRenderer {
  /** Initialize GPU resources. Called once when the test is activated. */
  init(ctx: TestContext): Promise<void> | void;
  /** Render one frame. Called every requestAnimationFrame. */
  render(ctx: TestContext): void;
  /** Handle canvas resize. Called when the canvas dimensions change. */
  resize(width: number, height: number): void;
  /** Release all GPU resources. Called when switching away from this test. */
  dispose(): void;
}

export interface TestControl {
  key: string;
  label: string;
  type: "slider" | "checkbox" | "button";
  min?: number;
  max?: number;
  step?: number;
  value: number | boolean;
  onChange: (value: number | boolean) => void;
}

export interface VisualTest {
  id: string;
  name: string;
  category: string;
  description: string;
  /** Whether this test requires WebGPU. If false, the test can render via Canvas2D. */
  requiresWebGPU?: boolean;
  /** Factory that creates the test's renderer. Called when the test is activated. */
  createRenderer(canvas: HTMLCanvasElement): ITestRenderer;
  /** Returns the test's live controls (sliders, checkboxes, buttons). Called on each React render. */
  getControls?(): TestControl[];
}

// ── Registry ──

const registry: VisualTest[] = [];

export function registerTest(test: VisualTest): void {
  if (registry.some((t) => t.id === test.id)) {
    console.warn(`[test-registry] duplicate test id "${test.id}" — skipping`);
    return;
  }
  registry.push(test);
}

export function getTests(): VisualTest[] {
  return registry;
}

export function getTestById(id: string): VisualTest | undefined {
  return registry.find((t) => t.id === id);
}
