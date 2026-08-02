import { DEFAULT_XR_CONFIG, type XRSessionConfig, type XRSessionState, type XRReferenceSpaceType } from "./types.ts";

type SessionEndCallback = () => void;
type VisibilityChangeCallback = (visible: boolean) => void;
type ResetCallback = () => void;

export class XRSessionManager {
  private session: XRSession | null = null;
  private referenceSpace: XRReferenceSpace | null = null;
  private state: XRSessionState = "idle";

  private sessionEndCallbacks: SessionEndCallback[] = [];
  private visibilityChangeCallbacks: VisibilityChangeCallback[] = [];
  private resetCallbacks: ResetCallback[] = [];

  private onSessionEndHandler: (() => void) | null = null;
  private onVisibilityChangeHandler: ((e: XRVisibilityChangeEvent) => void) | null = null;
  private onReferenceSpaceResetHandler: ((e: XRReferenceSpaceEvent) => void) | null = null;

  async requestSession(
    mode: "immersive-vr" = "immersive-vr",
    config: XRSessionConfig = DEFAULT_XR_CONFIG,
  ): Promise<XRSession> {
    if (this.state !== "idle") {
      throw new Error(`Cannot request session in state: ${this.state}`);
    }
    if (!navigator.xr) {
      throw new Error("WebXR not available");
    }

    this.state = "requesting";
    try {
      const session = await navigator.xr.requestSession(mode, {
        requiredFeatures: config.requiredFeatures as XRSessionFeature[],
        optionalFeatures: config.optionalFeatures as XRSessionFeature[],
      });

      this.session = session;
      this.state = "active";

      this.onSessionEndHandler = () => {
        this.cleanup();
        for (const cb of this.sessionEndCallbacks) cb();
      };
      this.onVisibilityChangeHandler = (e: XRVisibilityChangeEvent) => {
        const visible = e.visible;
        for (const cb of this.visibilityChangeCallbacks) cb(visible);
      };

      session.addEventListener("end", this.onSessionEndHandler);
      session.addEventListener("visibilitychange", this.onVisibilityChangeHandler);

      return session;
    } catch (err) {
      this.state = "idle";
      throw err;
    }
  }

  async setReferenceSpace(type: XRReferenceSpaceType): Promise<void> {
    if (!this.session) throw new Error("No active session");

    this.referenceSpace = await this.session.requestReferenceSpace(type);

    this.onReferenceSpaceResetHandler = (e: XRReferenceSpaceEvent) => {
      this.referenceSpace = e.referenceSpace;
      for (const cb of this.resetCallbacks) cb();
    };
    this.referenceSpace.addEventListener("reset", this.onReferenceSpaceResetHandler);
  }

  async endSession(): Promise<void> {
    if (!this.session || this.state === "ending") return;
    this.state = "ending";
    try {
      await this.session.end();
    } finally {
      this.cleanup();
    }
  }

  getSession(): XRSession | null {
    return this.session;
  }

  getReferenceSpace(): XRReferenceSpace | null {
    return this.referenceSpace;
  }

  getState(): XRSessionState {
    return this.state;
  }

  isActive(): boolean {
    return this.state === "active" && this.session !== null;
  }

  onSessionEnd(cb: SessionEndCallback): void {
    this.sessionEndCallbacks.push(cb);
  }

  onVisibilityChange(cb: VisibilityChangeCallback): void {
    this.visibilityChangeCallbacks.push(cb);
  }

  onReset(cb: ResetCallback): void {
    this.resetCallbacks.push(cb);
  }

  private cleanup(): void {
    if (this.onSessionEndHandler && this.session) {
      this.session.removeEventListener("end", this.onSessionEndHandler);
    }
    if (this.onVisibilityChangeHandler && this.session) {
      this.session.removeEventListener("visibilitychange", this.onVisibilityChangeHandler);
    }
    if (this.onReferenceSpaceResetHandler && this.referenceSpace) {
      this.referenceSpace.removeEventListener("reset", this.onReferenceSpaceResetHandler);
    }

    this.onSessionEndHandler = null;
    this.onVisibilityChangeHandler = null;
    this.onReferenceSpaceResetHandler = null;
    this.session = null;
    this.referenceSpace = null;
    this.state = "idle";
  }
}

export function isXRAvailable(): boolean {
  return typeof navigator !== "undefined" && !!navigator.xr;
}

export async function isVRSupported(): Promise<boolean> {
  if (!navigator.xr) return false;
  try {
    return await navigator.xr.isSessionSupported("immersive-vr");
  } catch {
    return false;
  }
}

export function isXRGPUBindingAvailable(): boolean {
  return typeof globalThis !== "undefined" && "XRGPUBinding" in globalThis;
}
