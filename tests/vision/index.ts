import { createLogger } from "../../packages/core/src/util/logger";

const log = createLogger();

export { llmVisionBatch, llmVisionVerify, type LLMVisionOptions, type LLMVisionResult } from "./llm-vision";
export { averageColor, comparePixels, getPixel, scanRegions, type PixelScanOptions, type PixelScanResult, type RegionCheck } from "./pixel-scan";
export { captureScreenshot, captureScreenshotFromGPUTexture, saveScreenshot, type ScreenshotOptions, type ScreenshotResult } from "./screenshot";

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
  pixelScan?: import("./pixel-scan").PixelScanResult;
  llmResult?: import("./llm-vision").LLMVisionResult;
  screenshot: import("./screenshot").ScreenshotResult;
  durationMs: number;
}

export async function visionTest(
  name: string,
  canvas: HTMLCanvasElement | OffscreenCanvas,
  options: VisionTestOptions = {},
): Promise<VisionTestResult> {
  const startTime = performance.now();

  const { captureScreenshot } = await import("./screenshot");
  const { comparePixels, scanRegions } = await import("./pixel-scan");
  const { llmVisionVerify } = await import("./llm-vision");

  const screenshot = await captureScreenshot(canvas, {
    width: options.width,
    height: options.height,
  });

  let pixelScanResult: import("./pixel-scan").PixelScanResult | undefined;
  let llmResult: import("./llm-vision").LLMVisionResult | undefined;

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
    log.info("Vision", `${status}: ${test.name} (${result.durationMs.toFixed(1)}ms)`);
    if (result.pixelScan && !result.pixelScan.passed) {
      log.warn("Vision", `Pixel scan: ${result.pixelScan.mismatchedPixels}/${result.pixelScan.totalPixels} mismatched (max delta: ${result.pixelScan.maxDelta})`);
    }
    if (result.llmResult && !result.llmResult.passed) {
      log.warn("Vision", `LLM: ${result.llmResult.reasoning}`);
    }
  }
  return results;
}
