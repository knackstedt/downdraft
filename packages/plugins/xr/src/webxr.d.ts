// Minimal WebXR type declarations (global)
// These types are not included in TypeScript's DOM lib

declare global {
  type XRReferenceSpaceType = "viewer" | "local" | "local-floor" | "bounded-floor" | "unbounded";
  type XRSessionMode = "inline" | "immersive-vr" | "immersive-ar";
  type XRVisibilityState = "visible" | "visible-blurred" | "hidden";
  type XRFrameRequestCallback = (time: number, frame: XRFrame) => void;
  type XRSessionFeature = "local" | "local-floor" | "bounded-floor" | "unbounded" | "hit-test" | "dom-overlay" | "layers" | "anchors";
  type XREye = "none" | "left" | "right";

  interface XRSessionInit {
    requiredFeatures?: XRSessionFeature[];
    optionalFeatures?: XRSessionFeature[];
  }

  interface XRRenderState {
    depthNear: number;
    depthFar: number;
    inlineVerticalFieldOfView?: number;
    baseLayer?: XRWebGLLayer | null;
  }

  interface XRRenderStateInit {
    depthNear?: number;
    depthFar?: number;
    inlineVerticalFieldOfView?: number;
    baseLayer?: XRWebGLLayer | null;
  }

  interface XRWebGLLayerInit {
    antialias?: boolean;
    depth?: boolean;
    stencil?: boolean;
    alpha?: boolean;
    multiview?: boolean;
  }

  class XRWebGLLayer {
    constructor(session: XRSession, gl: WebGLRenderingContext | WebGL2RenderingContext, init?: XRWebGLLayerInit);
    readonly antialias: boolean;
    readonly depth: boolean;
    readonly stencil: boolean;
    readonly alpha: boolean;
    readonly multiview: boolean;
    getViewport(view: XRView): XRViewport | null;
    requestViewportScaling(viewportScaleFactor: number): void;
  }

  interface XRViewport {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  interface XRView {
    readonly eye: XREye;
    readonly projectionMatrix: Float32Array;
    readonly transform: XRRigidTransform;
    readonly viewport?: XRViewport;
  }

  interface XRViewerPose {
    readonly transform: XRRigidTransform;
    readonly emulatedPosition: boolean;
    readonly views: XRView[];
  }

  interface XRFrame {
    readonly session: XRSession;
    getViewerPose(referenceSpace: XRReferenceSpace): XRViewerPose | null;
    getPose(space: XRSpace, referenceSpace: XRReferenceSpace): XRPose | null;
    getJointPose(jointSpace: XRJointSpace, referenceSpace: XRReferenceSpace): XRJointPose | null;
    fillPoses(spaces: XRSpace[], referenceSpace: XRReferenceSpace, transforms: Float32Array): boolean;
    fillJointRadii(jointSpaces: XRJointSpace[], radii: Float32Array): boolean;
  }

  interface XRPose {
    readonly transform: XRRigidTransform;
    readonly emulatedPosition: boolean;
  }

  class XRRigidTransform {
    constructor(x?: number, y?: number, z?: number, w?: number);
    readonly position: DOMPointReadOnly;
    readonly orientation: DOMPointReadOnly;
    readonly matrix: Float32Array;
    readonly inverse: XRRigidTransform;
  }

  class XRReferenceSpace extends EventTarget {
    readonly type: XRReferenceSpaceType;
    getOffsetReferenceSpace(offset: XRRigidTransform): XRReferenceSpace;
  }

  class XRReferenceSpaceEvent extends Event {
    constructor(type: string, eventInitDict: XRReferenceSpaceEventInit);
    readonly referenceSpace: XRReferenceSpace;
  }

  interface XRReferenceSpaceEventInit extends EventInit {
    referenceSpace: XRReferenceSpace;
  }

  class XRSpace {
    // Base class for reference spaces
  }

  class XRJointSpace extends XRSpace {
    readonly jointName: string;
  }

  interface XRJointPose extends XRPose {
    readonly radius: number;
  }

  interface XRInputSource {
    readonly handedness: "none" | "left" | "right";
    readonly targetRayMode: "gaze" | "tracked-pointer" | "screen";
    readonly targetRaySpace: XRSpace;
    readonly gripSpace?: XRSpace;
    readonly gamepad?: Gamepad;
    readonly profiles: string[];
    readonly hand?: XRHand;
  }

  interface XRHand {
    readonly size: number;
    [key: string]: XRJointSpace;
  }

  class XRSession extends EventTarget {
    readonly mode: XRSessionMode;
    readonly visibilityState: XRVisibilityState;
    readonly inputSources: XRInputSource[];
    readonly environmentBlendMode: string;
    renderState: XRRenderState;
    requestReferenceSpace(type: XRReferenceSpaceType): Promise<XRReferenceSpace>;
    updateRenderState(state: XRRenderStateInit): void;
    requestAnimationFrame(callback: XRFrameRequestCallback): number;
    cancelAnimationFrame(id: number): void;
    end(): Promise<void>;
    requestHitTestSource(options: XRHitTestOptionsInit): Promise<XRHitTestSource>;
  }

  interface XRHitTestOptionsInit {
    space: XRSpace;
    offsetRay?: XRRay;
  }

  class XRHitTestSource {
    cancel(): void;
  }

  class XRRay {
    constructor(origin?: DOMPointInit, direction?: DOMPointInit);
    readonly origin: DOMPointReadOnly;
    readonly direction: DOMPointReadOnly;
    readonly matrix: Float32Array;
  }

  class XRLayer {
    // Base class for XR layers
  }

  interface XRVisibilityChangeEvent extends Event {
    readonly visibilityState: XRVisibilityState;
  }

  interface Navigator {
    xr?: XRSystem;
  }

  class XRSystem extends EventTarget {
    isSessionSupported(mode: XRSessionMode): Promise<boolean>;
    requestSession(mode: XRSessionMode, options?: XRSessionInit): Promise<XRSession>;
  }
}

export { };

