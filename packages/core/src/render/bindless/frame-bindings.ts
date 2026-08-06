// ============================================================================
// BindlessFrameBindings — builds & caches the single shared material bind group
//
// Convention: the bindless material bind group is @group(3). It binds:
//   binding 0: material SSBO (read-only storage, FRAGMENT)
//   bindings 1..N: texture_2d_array views for each "format slot" the engine uses
//   binding N+1: shared sampler (linear-repeat)
//   binding N+2: shared sampler (linear-clamp)
//
// The bind group is rebuilt only when the texture registry adds a page or the
// material SSBO is reallocated. Otherwise it is set once per frame per pass.
//
// Format slots: the engine standardizes on a small fixed set of texture array
// "slots" keyed by format, so all pipelines can share one bind group layout:
//   slot 0: rgba8unorm color textures (albedo, normal, MR, AO, emissive)
//   slot 1: rgba16float HDR textures (if used)
// Additional slots can be added by the host if a game needs more formats.
// ============================================================================

import { createLogger } from "../../util/logger";
import { BindlessMaterialManager } from "./material-manager";
import { BindlessTextureRegistry, type TextureBucketKey } from "./texture-registry";

const log = createLogger();

const SHADER_STAGE_FRAGMENT = 0x02; // GPUShaderStage.FRAGMENT

export interface BindlessFormatSlot {
  /** Slot index in the bind group (1-based; 0 is the SSBO). */
  slot: number;
  format: GPUTextureFormat;
  /** Canonical bucket dimensions. Textures of other sizes get their own bucket
   * but still bind into this slot's array views — the registry returns one view
   * per page, padded to maxArrayBindingsPerFormat. */
  key: TextureBucketKey;
}

/**
 * Default format slots. Slot 0 is the SSBO; slots 1.. are texture arrays.
 * The host can override via BindlessFrameBindingsOptions.formatSlots.
 */
export const DEFAULT_FORMAT_SLOTS: BindlessFormatSlot[] = [
  // Slot 1: a 1x1 rgba8unorm bucket (defaults + small textures). Most material
  // textures register here or in a same-format larger bucket; the bind group
  // binds the registry's views for whichever bucket key the host requests.
  // We don't pin a single bucket key here — the host passes the active bucket
  // keys at bind-group build time.
];

export interface BindlessFrameBindingsOptions {
  /** Format slots to bind. Defaults to a single rgba8unorm slot. */
  formatSlots?: BindlessFormatSlot[];
  /** Override the bind group index (default 3). */
  groupIndex?: number;
}

export class BindlessFrameBindings {
  private device: GPUDevice;
  private registry: BindlessTextureRegistry;
  private materialManager: BindlessMaterialManager;
  private formatSlots: BindlessFormatSlot[];
  groupIndex: number;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private cachedLayoutVersion = -1;
  private cachedBufferVersion = -1;
  private samplerRepeat: GPUSampler;
  private samplerClamp: GPUSampler;

  constructor(
    device: GPUDevice,
    registry: BindlessTextureRegistry,
    materialManager: BindlessMaterialManager,
    options: BindlessFrameBindingsOptions = {},
  ) {
    this.device = device;
    this.registry = registry;
    this.materialManager = materialManager;
    this.formatSlots = options.formatSlots ?? DEFAULT_FORMAT_SLOTS;
    this.groupIndex = options.groupIndex ?? 3;
    this.samplerRepeat = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "repeat",
      addressModeV: "repeat",
    });
    this.samplerClamp = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
  }

  getBindGroupLayout(): GPUBindGroupLayout {
    if (this.bindGroupLayout) return this.bindGroupLayout;
    const maxArrays = this.registry.getMaxArrayBindingsPerFormat();
    const entries: GPUBindGroupLayoutEntry[] = [
      // binding 0: material SSBO
      { binding: 0, visibility: SHADER_STAGE_FRAGMENT, buffer: { type: "read-only-storage" } },
    ];
    // bindings 1..maxArrays: texture_2d_array (one binding per page, flat across all buckets)
    for (let i = 0; i < maxArrays; i++) {
      entries.push({
        binding: 1 + i,
        visibility: SHADER_STAGE_FRAGMENT,
        texture: { sampleType: "float", viewDimension: "2d-array" },
      });
    }
    // shared samplers at bindings maxArrays+1 and maxArrays+2
    entries.push({ binding: maxArrays + 1, visibility: SHADER_STAGE_FRAGMENT, sampler: { type: "filtering" } });
    entries.push({ binding: maxArrays + 2, visibility: SHADER_STAGE_FRAGMENT, sampler: { type: "filtering" } });
    this.bindGroupLayout = this.device.createBindGroupLayout({ entries });
    return this.bindGroupLayout;
  }

  getBindGroup(): GPUBindGroup {
    const layoutVersion = this.registry.getLayoutVersion();
    const bufferVersion = this.materialManager.getBufferVersion();
    if (this.bindGroup && this.cachedLayoutVersion === layoutVersion && this.cachedBufferVersion === bufferVersion) {
      return this.bindGroup;
    }
    const layout = this.getBindGroupLayout();
    const maxArrays = this.registry.getMaxArrayBindingsPerFormat();
    const flatViews = this.registry.getAllArrayViewsFlat();
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: this.materialManager.getBuffer() } },
    ];
    // Bind texture views at bindings 1..maxArrays (null views are allowed —
    // the shader's switch default returns white for unbound indices).
    for (let i = 0; i < maxArrays; i++) {
      const view = flatViews[i];
      if (view) {
        entries.push({ binding: 1 + i, resource: view });
      } else {
        // Bind the first available view as a placeholder for unused slots.
        // WebGPU requires all layout entries to have a bound resource.
        const fallback = flatViews.find((v) => v !== null);
        if (fallback) {
          entries.push({ binding: 1 + i, resource: fallback });
        }
      }
    }
    entries.push({ binding: maxArrays + 1, resource: this.samplerRepeat });
    entries.push({ binding: maxArrays + 2, resource: this.samplerClamp });
    this.bindGroup = this.device.createBindGroup({ layout, entries });
    this.cachedLayoutVersion = layoutVersion;
    this.cachedBufferVersion = bufferVersion;
    log.debug("Bindless", `material bind group rebuilt (layout v${layoutVersion}, buffer v${bufferVersion})`);
    return this.bindGroup;
  }

  /** Flush material SSBO writes and return the bind group ready for a frame. */
  prepareFrame(): GPUBindGroup {
    this.materialManager.flush();
    return this.getBindGroup();
  }

  destroy(): void {
    this.bindGroup = null;
    this.bindGroupLayout = null;
  }
}
