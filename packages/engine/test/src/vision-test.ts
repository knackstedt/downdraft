export interface PixelMatchOptions {
  tolerance: number;
  mask?: Uint8Array;
  ignoreAlpha?: boolean;
}

export interface PixelScanResult {
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface DiffResult {
  totalPixels: number;
  diffPixels: number;
  diffPercentage: number;
  maxDiff: number;
  diffImage: Uint8Array | null;
}

export class VisionTest {
  private device: GPUDevice;
  private readbackBuffer: GPUBuffer | null = null;
  private width: number = 0;
  private height: number = 0;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  async captureTexture(
    texture: GPUTexture,
    width: number,
    height: number,
    format: GPUTextureFormat = "rgba8unorm",
  ): Promise<Uint8Array> {
    const bytesPerPixel = format.includes("16float") ? 8 : 4;
    const bytesPerRow = Math.ceil((width * bytesPerPixel) / 256) * 256;
    const bufferSize = bytesPerRow * height;

    if (
      !this.readbackBuffer ||
      this.width !== width ||
      this.height !== height
    ) {
      this.readbackBuffer?.destroy();
      this.readbackBuffer = this.device.createBuffer({
        size: bufferSize,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      this.width = width;
      this.height = height;
    }

    const encoder = this.device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture, mipLevel: 0, origin: [0, 0, 0] },
      {
        buffer: this.readbackBuffer,
        bytesPerRow,
        rowsPerImage: height,
      },
      [width, height, 1],
    );
    this.device.queue.submit([encoder.finish()]);

    await this.readbackBuffer.mapAsync(GPUMapMode.READ);
    const arrayBuffer = this.readbackBuffer.getMappedRange();
    const result = new Uint8Array(arrayBuffer.slice(0));
    this.readbackBuffer.unmap();

    if (bytesPerRow !== width * bytesPerPixel) {
      const unstripped = new Uint8Array(width * height * bytesPerPixel);
      for (let y = 0; y < height; y++) {
        const srcOffset = y * bytesPerRow;
        const dstOffset = y * width * bytesPerPixel;
        unstripped.set(result.subarray(srcOffset, srcOffset + width * bytesPerPixel), dstOffset);
      }
      return unstripped;
    }

    return result;
  }

  async captureCanvas(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    width: number,
    height: number,
  ): Promise<Uint8Array> {
    const context = canvas.getContext("webgpu");
    if (!context) throw new Error("Canvas does not have a WebGPU context");
    const texture = context.getCurrentTexture();
    if (!texture) throw new Error("Surface acquire failed (resize in flight?) — retry next frame");
    return this.captureTexture(texture, width, height);
  }

  getPixel(data: Uint8Array, width: number, x: number, y: number): PixelScanResult {
    const idx = (y * width + x) * 4;
    return {
      x,
      y,
      r: data[idx],
      g: data[idx + 1],
      b: data[idx + 2],
      a: data[idx + 3],
    };
  }

  scanRegion(
    data: Uint8Array,
    width: number,
    x: number,
    y: number,
    regionWidth: number,
    regionHeight: number,
  ): PixelScanResult[] {
    const results: PixelScanResult[] = [];
    for (let dy = 0; dy < regionHeight; dy++) {
      for (let dx = 0; dx < regionWidth; dx++) {
        const px = x + dx;
        const py = y + dy;
        if (px >= width) break;
        results.push(this.getPixel(data, width, px, py));
      }
    }
    return results;
  }

  assertPixel(
    data: Uint8Array,
    width: number,
    x: number,
    y: number,
    expected: [number, number, number, number],
    tolerance: number = 5,
  ): boolean {
    const pixel = this.getPixel(data, width, x, y);
    return (
      Math.abs(pixel.r - expected[0]) <= tolerance &&
      Math.abs(pixel.g - expected[1]) <= tolerance &&
      Math.abs(pixel.b - expected[2]) <= tolerance &&
      Math.abs(pixel.a - expected[3]) <= tolerance
    );
  }

  assertRegionColor(
    data: Uint8Array,
    width: number,
    x: number,
    y: number,
    regionWidth: number,
    regionHeight: number,
    expected: [number, number, number, number],
    tolerance: number = 5,
  ): boolean {
    for (let dy = 0; dy < regionHeight; dy++) {
      for (let dx = 0; dx < regionWidth; dx++) {
        if (!this.assertPixel(data, width, x + dx, y + dy, expected, tolerance)) {
          return false;
        }
      }
    }
    return true;
  }

  averageColor(
    data: Uint8Array,
    width: number,
    x: number,
    y: number,
    regionWidth: number,
    regionHeight: number,
  ): [number, number, number, number] {
    let r = 0, g = 0, b = 0, a = 0;
    let count = 0;
    for (let dy = 0; dy < regionHeight; dy++) {
      for (let dx = 0; dx < regionWidth; dx++) {
        const pixel = this.getPixel(data, width, x + dx, y + dy);
        r += pixel.r;
        g += pixel.g;
        b += pixel.b;
        a += pixel.a;
        count++;
      }
    }
    return [r / count, g / count, b / count, a / count];
  }

  compare(
    actual: Uint8Array,
    expected: Uint8Array,
    width: number,
    height: number,
    options: PixelMatchOptions = { tolerance: 5 },
  ): DiffResult {
    const tolerance = options.tolerance;
    const ignoreAlpha = options.ignoreAlpha ?? false;
    let diffPixels = 0;
    let maxDiff = 0;
    const diffImage = new Uint8Array(width * height * 4);

    for (let i = 0; i < width * height; i++) {
      const idx = i * 4;
      const mask = options.mask ? options.mask[i] : 1;
      if (mask === 0) {
        diffImage[idx] = 0;
        diffImage[idx + 1] = 0;
        diffImage[idx + 2] = 0;
        diffImage[idx + 3] = 255;
        continue;
      }

      const dr = Math.abs(actual[idx] - expected[idx]);
      const dg = Math.abs(actual[idx + 1] - expected[idx + 1]);
      const db = Math.abs(actual[idx + 2] - expected[idx + 2]);
      const da = ignoreAlpha ? 0 : Math.abs(actual[idx + 3] - expected[idx + 3]);

      const pixelDiff = Math.max(dr, dg, db, da);
      maxDiff = Math.max(maxDiff, pixelDiff);

      if (pixelDiff > tolerance) {
        diffPixels++;
        diffImage[idx] = 255;
        diffImage[idx + 1] = 0;
        diffImage[idx + 2] = 0;
        diffImage[idx + 3] = 255;
      } else {
        diffImage[idx] = actual[idx];
        diffImage[idx + 1] = actual[idx + 1];
        diffImage[idx + 2] = actual[idx + 2];
        diffImage[idx + 3] = actual[idx + 3];
      }
    }

    const totalPixels = width * height;
    return {
      totalPixels,
      diffPixels,
      diffPercentage: (diffPixels / totalPixels) * 100,
      maxDiff,
      diffImage,
    };
  }

  async screenshotToDataURL(
    texture: GPUTexture,
    width: number,
    height: number,
  ): Promise<string> {
    const data = await this.captureTexture(texture, width, height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    const imageData = ctx.createImageData(width, height);
    imageData.data.set(data);
    ctx.putImageData(imageData, 0, 0);
    return canvas.toDataURL("image/png");
  }

  destroy(): void {
    this.readbackBuffer?.destroy();
    this.readbackBuffer = null;
  }
}

export interface VisionTestResult {
  name: string;
  passed: boolean;
  diffPercentage: number;
  message: string;
}

export class VisionTestSuite {
  private vision: VisionTest;
  private results: VisionTestResult[] = [];

  constructor(device: GPUDevice) {
    this.vision = new VisionTest(device);
  }

  async runPixelTest(
    name: string,
    texture: GPUTexture,
    width: number,
    height: number,
    assertions: Array<{
      x: number;
      y: number;
      expected: [number, number, number, number];
      tolerance?: number;
    }>,
  ): Promise<VisionTestResult> {
    const data = await this.vision.captureTexture(texture, width, height);
    let allPassed = true;
    const failures: string[] = [];

    assertions.forEach((assertion) => {
      const passed = this.vision.assertPixel(
        data,
        width,
        assertion.x,
        assertion.y,
        assertion.expected,
        assertion.tolerance ?? 5,
      );
      if (!passed) {
        allPassed = false;
        const pixel = this.vision.getPixel(data, width, assertion.x, assertion.y);
        failures.push(
          `Pixel (${assertion.x}, ${assertion.y}): expected [${assertion.expected}], got [${pixel.r}, ${pixel.g}, ${pixel.b}, ${pixel.a}]`,
        );
      }
    });

    const result: VisionTestResult = {
      name,
      passed: allPassed,
      diffPercentage: 0,
      message: allPassed ? "All pixel assertions passed" : failures.join("; "),
    };
    this.results.push(result);
    return result;
  }

  async runComparisonTest(
    name: string,
    texture: GPUTexture,
    width: number,
    height: number,
    baseline: Uint8Array,
    tolerance: number = 5,
    threshold: number = 1.0,
  ): Promise<VisionTestResult> {
    const data = await this.vision.captureTexture(texture, width, height);
    const diff = this.vision.compare(data, baseline, width, height, { tolerance });
    const passed = diff.diffPercentage <= threshold;
    const result: VisionTestResult = {
      name,
      passed,
      diffPercentage: diff.diffPercentage,
      message: passed
        ? `Diff ${diff.diffPercentage.toFixed(2)}% within threshold ${threshold}%`
        : `Diff ${diff.diffPercentage.toFixed(2)}% exceeds threshold ${threshold}% (max pixel diff: ${diff.maxDiff})`,
    };
    this.results.push(result);
    return result;
  }

  getResults(): VisionTestResult[] {
    return this.results;
  }

  getSummary(): { total: number; passed: number; failed: number } {
    const passed = this.results.filter((r) => r.passed).length;
    return {
      total: this.results.length,
      passed,
      failed: this.results.length - passed,
    };
  }

  destroy(): void {
    this.vision.destroy();
  }
}
