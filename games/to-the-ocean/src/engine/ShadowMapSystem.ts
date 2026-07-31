// Re-export ShadowMapSystem from @downdraft/core with game's depth format
import { ShadowMapSystem as CoreShadowMapSystem } from "@downdraft/core";
import { DEPTH_FORMAT } from "./graphicsConfig";

export class ShadowMapSystem extends CoreShadowMapSystem {
  constructor(device: GPUDevice) {
    super(device, { depthFormat: DEPTH_FORMAT });
  }
}

