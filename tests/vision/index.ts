export { captureScreenshot, captureScreenshotFromGPUTexture, saveScreenshot, type ScreenshotOptions, type ScreenshotResult } from "./screenshot.ts";
export { comparePixels, scanRegions, getPixel, averageColor, type PixelScanOptions, type PixelScanResult, type RegionCheck } from "./pixel-scan.ts";
export { llmVisionVerify, llmVisionBatch, type LLMVisionOptions, type LLMVisionResult } from "./llm-vision.ts";

export interface VisionTestOptions {
  referenceImage?: Uint8Array;
  pixelTolerance?: number;
  regions?: Array<{
    region: { x: number; y: number; width: number; height: number };
    expectedColor: { r: number; g: number; b: number; a?: number };
    tolerance?: number;
  }>;
  llmPrompt?: string;
  llmApiKey?: string;
  width?: number;
  height?: number;
}

export interface VisionTestResult {
  name: string;
  passed: boolean;
  pixelScan?: import("./pixel-scan.ts").PixelScanResult;
  llmResult?: import("./llm-vision.ts").LLMVisionResult;
  screenshot: import("./screenshot.ts").ScreenshotResult;
  durationMs: number;
}

export async function visionTest(
  name: string,
  canvas: HTMLCanvasElement | OffscreenCanvas,
  options: VisionTestOptions = {},
): Promise<VisionTestResult> {
  const startTime = performance.now();

  const { captureScreenshot } = await import("./screenshot.ts");
  const { comparePixels, scanRegions } = await import("./pixel-scan.ts");
  const { llmVisionVerify } = await import("./llm-vision.ts");

  const screenshot = await captureScreenshot(canvas, {
    width: options.width,
    height: options.height,
  });

  let pixelScanResult: import("./pixel-scan.ts").PixelScanResult | undefined;
  let llmResult: import("./llm-vision.ts").LLMVisionResult | undefined;

  if (options.referenceImage) {
    pixelScanResult = comparePixels(
      screenshot.data,
      options.referenceImage,
      screenshot.width,
      screenshot.height,
      { tolerance: options.pixelTolerance ?? 5 },
    );
  } else if (options.regions) {
    pixelScanResult = scanRegions(
      screenshot.data,
      screenshot.width,
      screenshot.height,
      options.regions,
    );
  }

  if (options.llmPrompt) {
    llmResult = await llmVisionVerify({
      prompt: options.llmPrompt,
      imageData: screenshot.data,
      apiKey: options.llmApiKey,
    });
  }

  const pixelPassed = pixelScanResult?.passed ?? true;
  const llmPassed = llmResult?.passed ?? true;
  const passed = pixelPassed && llmPassed;

  const durationMs = performance.now() - startTime;

  return {
    name,
    passed,
    pixelScan: pixelScanResult,
    llmResult: llmResult,
    screenshot,
    durationMs,
  };
}

export async function visionTestSuite(
  tests: Array<{ name: string; canvas: HTMLCanvasElement | OffscreenCanvas; options: VisionTestOptions }>,
): Promise<Array<VisionTestResult>> {
  const results: VisionTestResult[] = [];
  for (const test of tests) {
    const result = await visionTest(test.name, test.canvas, test.options);
    results.push(result);
    const status = result.passed ? "PASS" : "FAIL";
    console.log(`[Vision] ${status}: ${test.name} (${result.durationMs.toFixed(1)}ms)`);
    if (result.pixelScan && !result.pixelScan.passed) {
      console.log(`  Pixel scan: ${result.pixelScan.mismatchedPixels}/${result.pixelScan.totalPixels} mismatched (max delta: ${result.pixelScan.maxDelta})`);
    }
    if (result.llmResult && !result.llmResult.passed) {
      console.log(`  LLM: ${result.llmResult.reasoning}`);
    }
  }
  return results;
}
