/**
 * Shared GPU resource creation utilities.
 *
 * These helpers eliminate the repeated `device.createBuffer` / `device.createTexture`
 * patterns found across render passes, asset loaders, and bindless infrastructure.
 */

/**
 * Create a uniform buffer with `UNIFORM | COPY_DST` usage.
 * @param device - The GPU device
 * @param size - Buffer size in bytes
 */
export function createUniformBuffer(device: GPUDevice, size: number): GPUBuffer {
  return device.createBuffer({
    size,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
}

/**
 * Create a storage buffer with `STORAGE | COPY_DST | COPY_SRC` usage.
 * @param device - The GPU device
 * @param size - Buffer size in bytes
 * @param copySrc - Whether to include COPY_SRC usage (default: true)
 */
export function createStorageBuffer(device: GPUDevice, size: number, copySrc = true): GPUBuffer {
  let usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
  if (copySrc) usage |= GPUBufferUsage.COPY_SRC;
  return device.createBuffer({ size, usage });
}

/**
 * Create a 1x1 white texture view for use as a default sampler input.
 * @param device - The GPU device
 * @param format - Texture format (default: rgba8unorm)
 */
export function createDefaultTextureView(
  device: GPUDevice,
  format: GPUTextureFormat = "rgba8unorm",
): GPUTextureView {
  const tex = device.createTexture({
    size: [1, 1],
    format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const data = new Uint8Array([255, 255, 255, 255]);
  device.queue.writeTexture(
    { texture: tex },
    data,
    { bytesPerRow: 4 },
    { width: 1, height: 1 },
  );
  return tex.createView();
}

/**
 * Create a 1x1 black texture view for use as a default sampler input.
 * @param device - The GPU device
 * @param format - Texture format (default: rgba8unorm)
 */
export function createBlackTextureView(
  device: GPUDevice,
  format: GPUTextureFormat = "rgba8unorm",
): GPUTextureView {
  const tex = device.createTexture({
    size: [1, 1],
    format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const data = new Uint8Array([0, 0, 0, 255]);
  device.queue.writeTexture(
    { texture: tex },
    data,
    { bytesPerRow: 4 },
    { width: 1, height: 1 },
  );
  return tex.createView();
}

/**
 * Create a depth texture with common defaults.
 * @param device - The GPU device
 * @param size - Texture dimensions [width, height]
 * @param format - Depth format (default: depth32float)
 */
export function createDepthTexture(
  device: GPUDevice,
  size: [number, number],
  format: GPUTextureFormat = "depth32float",
): GPUTexture {
  return device.createTexture({
    size,
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
}
