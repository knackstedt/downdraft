// Re-export ShadowMapSystem from @downdraft/core with game's depth format
import { ShadowMapSystem as CoreShadowMapSystem, DEPTH_FORMAT } from "@downdraft/core";

export class ShadowMapSystem extends CoreShadowMapSystem {
  constructor(device: GPUDevice) {
    super(device, { depthFormat: DEPTH_FORMAT });
  }
}

