// Re-export PostProcessStack from @downdraft/core with game's depth format
import { PostProcessStack as CorePostProcessStack } from "@downdraft/core";
import { DEPTH_FORMAT } from "./graphics-config";

export interface ViewportRect { x: number; y: number; w: number; h: number; }

export class PostProcessStack extends CorePostProcessStack {
  constructor(device: GPUDevice, format: GPUTextureFormat) {
    super(device, format, { depthFormat: DEPTH_FORMAT });
  }
}
