import { VisionTestSuite, createLogger, type VisionTestResult } from "@downdraft/core";
import { visionTestSuite, type VisionTestResult as VTR } from "../../tests/vision/index";

const log = createLogger();

export interface ExampleSceneTest {
  name: string;
  description: string;
  assertions: Array<{
    x: number;
    y: number;
    expected: [number, number, number, number];
    tolerance?: number;
    label?: string;
  }>;
  regionChecks?: Array<{
    region: { x: number; y: number; width: number; height: number };
    expectedColor: { r: number; g: number; b: number; a?: number };
    tolerance?: number;
    label?: string;
  }>;
  llmPrompt?: string;
}

export const EXAMPLE_SCENE_TESTS: ExampleSceneTest[] = [
  {
    name: "clear-color",
    description: "Verify the screen clears to the expected background color",
    assertions: [
      { x: 0, y: 0, expected: [26, 26, 30, 255], tolerance: 10, label: "top-left corner" },
      { x: 399, y: 299, expected: [26, 26, 30, 255], tolerance: 10, label: "center" },
      { x: 799, y: 599, expected: [26, 26, 30, 255], tolerance: 10, label: "bottom-right corner" },
    ],
  },
  {
    name: "cube-render",
    description: "Verify a cube renders at screen center with visible faces",
    assertions: [
      { x: 400, y: 300, expected: [128, 128, 128, 255], tolerance: 40, label: "cube center" },
    ],
    regionChecks: [
      {
        region: { x: 350, y: 250, width: 100, height: 100 },
        expectedColor: { r: 100, g: 100, b: 100, a: 255 },
        tolerance: 60,
        label: "cube body region",
      },
    ],
    llmPrompt: "A 3D cube rendered in the center of the screen on a dark background",
  },
  {
    name: "lighting",
    description: "Verify directional lighting creates gradient on cube surfaces",
    assertions: [
      { x: 370, y: 270, expected: [180, 180, 180, 255], tolerance: 50, label: "lit face" },
      { x: 430, y: 330, expected: [80, 80, 80, 255], tolerance: 50, label: "shadowed face" },
    ],
    llmPrompt: "A lit 3D cube showing directional lighting with brighter and darker faces",
  },
  {
    name: "sky-gradient",
    description: "Verify sky gradient from horizon to zenith",
    assertions: [
      { x: 400, y: 50, expected: [80, 120, 200, 255], tolerance: 40, label: "sky top" },
      { x: 400, y: 550, expected: [200, 180, 150, 255], tolerance: 40, label: "sky bottom" },
    ],
    regionChecks: [
      {
        region: { x: 0, y: 0, width: 800, height: 100 },
        expectedColor: { r: 80, g: 120, b: 200, a: 255 },
        tolerance: 50,
        label: "sky top band",
      },
    ],
  },
  {
    name: "particle-effects",
    description: "Verify particle system renders visible particles",
    assertions: [
      { x: 400, y: 200, expected: [255, 150, 50, 255], tolerance: 80, label: "particle glow" },
    ],
    llmPrompt: "Particle effects with glowing orange particles visible on screen",
  },
  {
    name: "water-surface",
    description: "Verify water surface renders with blue tones",
    assertions: [
      { x: 400, y: 400, expected: [40, 80, 140, 255], tolerance: 50, label: "water center" },
    ],
    regionChecks: [
      {
        region: { x: 200, y: 380, width: 400, height: 100 },
        expectedColor: { r: 40, g: 80, b: 140, a: 255 },
        tolerance: 60,
        label: "water surface region",
      },
    ],
    llmPrompt: "A water surface with blue tones rendered in the lower portion of the screen",
  },
  {
    name: "shadow-rendering",
    description: "Verify shadows are cast on the ground plane",
    assertions: [
      { x: 400, y: 480, expected: [40, 40, 40, 255], tolerance: 30, label: "shadow area" },
      { x: 200, y: 480, expected: [80, 80, 80, 255], tolerance: 30, label: "non-shadowed ground" },
    ],
  },
  {
    name: "post-process-bloom",
    description: "Verify bloom post-processing creates glow around bright areas",
    assertions: [
      { x: 400, y: 300, expected: [200, 200, 200, 255], tolerance: 60, label: "bloomed center" },
    ],
    llmPrompt: "A scene with bloom post-processing creating a glow effect around bright objects",
  },
];

export async function runExampleSceneTests(
  device: GPUDevice,
  canvas: HTMLCanvasElement | OffscreenCanvas,
  width: number = 800,
  height: number = 600,
): Promise<{
  core: VisionTestResult[];
  vision: VTR[];
  summary: { total: number; passed: number; failed: number };
}> {
  const suite = new VisionTestSuite(device);
  const coreResults: VisionTestResult[] = [];

  for (const test of EXAMPLE_SCENE_TESTS) {
    if (test.assertions.length > 0) {
      const result = await suite.runPixelTest(
        test.name,
        (canvas as HTMLCanvasElement).getContext("webgpu")?.getCurrentTexture()!,
        width,
        height,
        test.assertions.map((a) => ({
          x: a.x,
          y: a.y,
          expected: a.expected,
          tolerance: a.tolerance ?? 5,
        })),
      );
      coreResults.push(result);
      const status = result.passed ? "PASS" : "FAIL";
      log.info("Vision", `${status}: ${test.name} — ${result.message}`);
    }
  }

  const visionTests = EXAMPLE_SCENE_TESTS.filter((t) => t.llmPrompt || t.regionChecks).map((test) => ({
    name: test.name,
    canvas,
    options: {
      regions: test.regionChecks?.map((rc) => ({
        region: rc.region,
        expectedColor: rc.expectedColor,
        tolerance: rc.tolerance,
      })),
      llmPrompt: test.llmPrompt,
      width,
      height,
    },
  }));

  const visionResults = visionTests.length > 0
    ? await visionTestSuite(visionTests)
    : [];

  const summary = {
    total: coreResults.length + visionResults.length,
    passed: coreResults.filter((r) => r.passed).length + visionResults.filter((r) => r.passed).length,
    failed: coreResults.filter((r) => !r.passed).length + visionResults.filter((r) => !r.passed).length,
  };

  suite.destroy();

  return { core: coreResults, vision: visionResults, summary };
}

export function printTestSummary(summary: { total: number; passed: number; failed: number }): void {
  log.info("Vision", "═══════════════════════════════════════════════");
  log.info("Vision", "  Vision Test Summary");
  log.info("Vision", `  Total: ${summary.total}  Passed: ${summary.passed}  Failed: ${summary.failed}`);
  log.info("Vision", `  Status: ${summary.failed === 0 ? "ALL PASSED ✓" : "FAILURES ✗"}`);
  log.info("Vision", "═══════════════════════════════════════════════");
}
