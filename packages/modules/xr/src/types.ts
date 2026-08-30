export type XRSessionState = "idle" | "requesting" | "active" | "ending";

export type XRReferenceSpaceType = "local" | "local-floor" | "bounded-floor" | "unbounded";

export interface XRSessionConfig {
  requiredFeatures: string[];
  optionalFeatures: string[];
}

export interface XREventMap {
  sessionEnd: () => void;
  visibilityChange: (visible: boolean) => void;
  reset: () => void;
}

export type XREventKey = keyof XREventMap;

export interface XRWorldOrigin {
  position: [number, number, number];
  quaternion: [number, number, number, number];
}

export interface XRPoseData {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  matrix: Float32Array;
}

export const DEFAULT_XR_CONFIG: XRSessionConfig = {
  requiredFeatures: ["local-floor"],
  optionalFeatures: ["depth-sensing", "hand-tracking"],
};
