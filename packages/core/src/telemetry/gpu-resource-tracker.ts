// ============================================================================
// GPUResourceTracker — wraps GPUDevice to track texture/buffer allocations
// Provides live VRAM usage visibility for the DevTools GPU tab
// ============================================================================

export interface TrackedResource {
  id: number;
  type: "texture" | "buffer";
  label: string;
  size: number; // bytes
  callsite?: string; // file:line where the resource was created (if no label)
  // Texture-specific
  width?: number;
  height?: number;
  depthOrArrayLayers?: number;
  format?: string;
  mipLevelCount?: number;
  sampleCount?: number;
  usage?: number;
  // Buffer-specific
  usageFlags?: number;
}

export interface GPUResourceStats {
  textureCount: number;
  bufferCount: number;
  totalBytes: number;
  textureBytes: number;
  bufferBytes: number;
  resources: TrackedResource[];
}

function getCallsite(): string {
  const stack = new Error().stack;
  if (!stack) return "";
  const lines = stack.split("\n");
  // Walk the stack and return the first frame that is NOT inside GPUResourceTracker.
  // This is more robust than a fixed skip count because Vite/dev mode may add
  // extra wrapper frames (module system, HMR, etc.).
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.includes("GPUResourceTracker")) continue;
    // Extract the file:line:col part from the stack line
    // Chrome format: "at FunctionName (file:line:col)" or "at file:line:col"
    const match = line.match(/\((.*?):(\d+):(\d+)\)/) || line.match(/at\s+(.*?):(\d+):(\d+)/);
    if (match) {
      let file = match[1];
      // Strip Vite query params (e.g. "file.ts?t=1682345678" -> "file.ts")
      file = file.split("?")[0];
      const lineNum = match[2];
      // Shorten to just the filename + line
      const shortFile = file.split("/").pop() || file;
      return shortFile + ":" + lineNum;
    }
    return line;
  }
  return "";
}

let nextResourceId = 1;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1048576).toFixed(2) + " MB";
}

function textureByteSize(
  format: GPUTextureFormat,
  width: number,
  height: number,
  depthOrArrayLayers: number,
  mipLevelCount: number,
): number {
  // Bytes per pixel for common WebGPU formats
  const bppMap: Record<string, number> = {
    "r8unorm": 1,
    "r8snorm": 1,
    "r8uint": 1,
    "r8sint": 1,
    "r16uint": 2,
    "r16sint": 2,
    "r16float": 2,
    "rg8unorm": 2,
    "rg8snorm": 2,
    "rg8uint": 2,
    "rg8sint": 2,
    "r32uint": 4,
    "r32sint": 4,
    "r32float": 4,
    "rg16uint": 4,
    "rg16sint": 4,
    "rg16float": 4,
    "rgba8unorm": 4,
    "rgba8unorm-srgb": 4,
    "rgba8snorm": 4,
    "rgba8uint": 4,
    "rgba8sint": 4,
    "bgra8unorm": 4,
    "bgra8unorm-srgb": 4,
    "rgb9e5ufloat": 4,
    "rgb10a2uint": 4,
    "rgb10a2unorm": 4,
    "rg11b10ufloat": 4,
    "rg32uint": 8,
    "rg32sint": 8,
    "rg32float": 8,
    "rgba16uint": 8,
    "rgba16sint": 8,
    "rgba16float": 8,
    "rgba32uint": 16,
    "rgba32sint": 16,
    "rgba32float": 16,
    "stencil8": 1,
    "depth16unorm": 2,
    "depth24plus": 3,
    "depth24plus-stencil8": 4,
    "depth32float": 4,
    "depth32float-stencil8": 5,
    "bc1-rgba-unorm": 0.5,
    "bc1-rgba-unorm-srgb": 0.5,
    "bc2-rgba-unorm": 1,
    "bc2-rgba-unorm-srgb": 1,
    "bc3-rgba-unorm": 1,
    "bc3-rgba-unorm-srgb": 1,
    "bc4-r-unorm": 0.5,
    "bc4-r-snorm": 0.5,
    "bc5-rg-unorm": 1,
    "bc5-rg-snorm": 1,
    "bc6h-rgb-ufloat": 1,
    "bc6h-rgb-float": 1,
    "bc7-rgba-unorm": 1,
    "bc7-rgba-unorm-srgb": 1,
  };

  const bpp = bppMap[format] ?? 4; // default to 4 bytes per pixel
  const bytesPerPixel = typeof bpp === "number" ? bpp : 4;

  let total = 0;
  let w = width;
  let h = height;
  for (let m = 0; m < mipLevelCount; m++) {
    total += Math.max(1, w) * Math.max(1, h) * bytesPerPixel;
    w = Math.max(1, Math.floor(w / 2));
    h = Math.max(1, Math.floor(h / 2));
  }
  return total * depthOrArrayLayers;
}

export class GPUResourceTracker {
  private resources = new Map<number, TrackedResource>();
  private textureBytes = 0;
  private bufferBytes = 0;

  wrapDevice(device: GPUDevice): GPUDevice {
    const self = this;
    const origCreateTexture = device.createTexture.bind(device);
    const origCreateBuffer = device.createBuffer.bind(device);

    (device as any).createTexture = function (descriptor: GPUTextureDescriptor): GPUTexture {
      const tex = origCreateTexture(descriptor);
      const id = nextResourceId++;
      const hasLabel = !!descriptor.label;
      const label = descriptor.label || `texture_${id}`;
      const callsite = hasLabel ? undefined : getCallsite();
      const size = descriptor.size;
      const width = typeof size === "object" && "width" in size ? (size.width ?? 1) : (typeof size === "number" ? size : 1);
      const height = typeof size === "object" && "height" in size ? (size.height ?? 1) : 1;
      const depthOrArrayLayers = typeof size === "object" && "depthOrArrayLayers" in size ? (size.depthOrArrayLayers ?? 1) : 1;
      const mipLevelCount = descriptor.mipLevelCount ?? 1;
      const format = descriptor.format;
      const bytes = textureByteSize(format, width, height, depthOrArrayLayers, mipLevelCount);

      self.resources.set(id, {
        id, type: "texture", label, size: bytes,
        callsite,
        width, height, depthOrArrayLayers, format,
        mipLevelCount, sampleCount: descriptor.sampleCount ?? 1, usage: descriptor.usage,
      });
      self.textureBytes += bytes;

      // Wrap destroy to remove from tracking
      const origDestroy = tex.destroy.bind(tex);
      tex.destroy = function () {
        const r = self.resources.get(id);
        if (r) {
          self.textureBytes -= r.size;
          self.resources.delete(id);
        }
        origDestroy();
      };

      return tex;
    };

    (device as any).createBuffer = function (descriptor: GPUBufferDescriptor): GPUBuffer {
      const buf = origCreateBuffer(descriptor);
      const id = nextResourceId++;
      const hasLabel = !!descriptor.label;
      const label = descriptor.label || `buffer_${id}`;
      const callsite = hasLabel ? undefined : getCallsite();
      const bytes = descriptor.size;

      self.resources.set(id, {
        id, type: "buffer", label, size: bytes,
        callsite,
        usageFlags: descriptor.usage,
      });
      self.bufferBytes += bytes;

      // Wrap destroy to remove from tracking
      const origDestroy = buf.destroy.bind(buf);
      buf.destroy = function () {
        const r = self.resources.get(id);
        if (r) {
          self.bufferBytes -= r.size;
          self.resources.delete(id);
        }
        origDestroy();
      };

      return buf;
    };

    return device;
  }

  getStats(): GPUResourceStats {
    const resources = Array.from(this.resources.values()).sort((a, b) => b.size - a.size);
    return {
      textureCount: resources.filter((r) => r.type === "texture").length,
      bufferCount: resources.filter((r) => r.type === "buffer").length,
      totalBytes: this.textureBytes + this.bufferBytes,
      textureBytes: this.textureBytes,
      bufferBytes: this.bufferBytes,
      resources,
    };
  }

  formatBytes(bytes: number): string {
    return formatBytes(bytes);
  }

  reset(): void {
    this.resources.clear();
    this.textureBytes = 0;
    this.bufferBytes = 0;
  }
}
