// ============================================================================
// Camera System — re-export from @downdraft/core with game-specific config
// The game's CameraMode enum (@shared/types) uses the same numeric values
// as core's CameraMode enum (0=FirstPerson, 1=ThirdPerson, 2=FreeCam).
// ============================================================================

import { CameraSystem as CoreCameraSystem, type CameraState } from "@downdraft/core";
import { PLAYER_EYE_HEIGHT, PLAYER_HEIGHT } from "@shared/constants";

export type { CameraState };

export class CameraSystem extends CoreCameraSystem {
  constructor() {
    super({
      eyeHeight: PLAYER_EYE_HEIGHT,
      playerHeight: PLAYER_HEIGHT,
    });
  }
}
