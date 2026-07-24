export interface ScreenshotOptions {
  width?: number;
  height?: number;
  format?: "png" | "jpeg";
}

export interface ScreenshotResult {
  data: Uint8Array;
  width: number;
  height: number;
  format: "png" | "jpeg";
}

export async function captureScreenshot(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  options: ScreenshotOptions = {},
): Promise<ScreenshotResult> {
  const format = options.format ?? "png";
  const width = options.width ?? canvas.width;
  const height = options.height ?? canvas.height;

  if (canvas instanceof HTMLCanvasElement) {
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, `image/${format}`);
    });
    if (!blob) throw new Error("Failed to capture screenshot from canvas");
    const arrayBuffer = await blob.arrayBuffer();
    return {
      data: new Uint8Array(arrayBuffer),
      width,
      height,
      format,
    };
  }

  if (typeof OffscreenCanvas !== "undefined" && canvas instanceof OffscreenCanvas) {
    const blob = await canvas.convertToBlob({ type: `image/${format}` });
    const arrayBuffer = await blob.arrayBuffer();
    return {
      data: new Uint8Array(arrayBuffer),
      width,
      height,
      format,
    };
  }

  throw new Error("Unsupported canvas type for screenshot");
}

export async function captureScreenshotFromGPUTexture(
  device: GPUDevice,
  texture: GPUTexture,
  width: number,
  height: number,
): Promise<ScreenshotResult> {
  const format = "rgba8unorm" as GPUTextureFormat;
  const tempTexture = device.createTexture({
    size: [width, height],
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });

  const encoder = device.createCommandEncoder();
  encoder.copyTextureToTexture(
    { texture },
    { texture: tempTexture },
    { width, height },
  );
  device.queue.submit([encoder.finish()]);

  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const readbackBuffer = device.createBuffer({
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const copyEncoder = device.createCommandEncoder();
  copyEncoder.copyTextureToBuffer(
    { texture: tempTexture },
    { buffer: readbackBuffer, bytesPerRow },
    { width, height },
  );
  device.queue.submit([copyEncoder.finish()]);

  await readbackBuffer.mapAsync(GPUMapMode.READ);
  const range = readbackBuffer.getMappedRange();
  const data = new Uint8Array(range.slice(0));
  readbackBuffer.unmap();
  readbackBuffer.destroy();
  tempTexture.destroy();

  const pngData = encodePNG(data, width, height, bytesPerRow);
  return {
    data: pngData,
    width,
    height,
    format: "png",
  };
}

function encodePNG(
  rgbaData: Uint8Array,
  width: number,
  height: number,
  bytesPerRow: number,
): Uint8Array {
  const pixels: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcIdx = y * bytesPerRow + x * 4;
      pixels.push(rgbaData[srcIdx], rgbaData[srcIdx + 1], rgbaData[srcIdx + 2], rgbaData[srcIdx + 3]);
    }
  }
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;
  const imageData = ctx.createImageData(width, height);
  for (let i = 0; i < pixels.length; i++) {
    imageData.data[i] = pixels[i];
  }
  ctx.putImageData(imageData, 0, 0);
  const pngBlob = canvas.convertToBlob({ type: "image/png" });
  return new Uint8Array(pngBlob as unknown as ArrayBuffer);
}

export async function saveScreenshot(
  result: ScreenshotResult,
  path: string,
): Promise<number> {
  return Bun.write(path, result.data);
}
