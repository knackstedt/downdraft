/// <reference path="./webxr.d.ts" />
export { XRCameraRig } from "./camera-rig";
export { checkXRSupport, formatXRDebugInfo, getXRDebugInfo } from "./debug";
export type { XRDebugInfo } from "./debug";
export { XRFrameLoop } from "./frame-loop";
export type { XRFrameLoopOptions } from "./frame-loop";
export { XRInputMapper } from "./input";
export { XRLayerManager } from "./layer";
export type { XREye, XRViewportRect } from "./layer";
export { isVRSupported, isXRAvailable, isXRGPUBindingAvailable, XRSessionManager } from "./session";
export { xrModule } from "./sim-module";
export { DEFAULT_XR_CONFIG } from "./types";
export type { XREventMap, XRPoseData, XRReferenceSpaceType, XRSessionConfig, XRSessionState, XRWorldOrigin } from "./types";
export { XRModule } from "./xr-module";
export type { XRModuleOptions } from "./xr-module";

