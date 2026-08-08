// ============================================================================
// Camera Controls Plugin — orbit/pan/zoom camera controller as a renderer plugin
//
// Registers a `CameraController` as the active camera provider on the
// `RendererPluginContext`, wires orbit/pan/zoom input from the shared input
// bus, and disposes cleanly on unload. This is the engine-builtin replacement
// for game-local `OrbitCamera` classes.
//
// For games with bespoke render loops (no `GameRenderer`), use
// `createCameraController(inputBus, opts)` instead — it returns a bare
// `CameraController` wired to a `RendererInputBus` without the plugin wrapper.
// ============================================================================

import {
    Camera,
    CameraController,
    type CameraControllerOptions,
    type OrbitInputOptions,
    type RendererInputBus,
    type RendererPlugin,
} from "@downdraft/core";

export interface CameraControlsOptions {
  /** Camera controller options (lerp, default camera id). */
  controller?: CameraControllerOptions;
  /** Orbit input sensitivity / clamps. */
  orbit?: OrbitInputOptions;
  /** Initial camera setup (applied to the default camera on registration). */
  initialCamera?: {
    /** Camera id; defaults to "main". */
    id?: string;
    position?: [number, number, number];
    target?: [number, number, number];
    fov?: number;
    near?: number;
    far?: number;
  };
}

/**
 * Creates a configured `CameraController` and wires it to a
 * `RendererInputBus` for orbit/pan/zoom input. For games that use
 * `GameRenderer` + `RendererPluginHost`, prefer `createCameraControlsPlugin`
 * instead — it handles registration and disposal automatically.
 *
 * The caller is responsible for:
 *  - calling `controller.setAspect(w, h)` on resize
 *  - calling `controller.update(dt)` each frame (if lerp is enabled)
 *  - calling `controller.unbindOrbit()` + `controller.dispose()` on teardown
 *
 * @example
 * ```ts
 * const inputBus = new RendererInputBusImpl(canvas);
 * const controller = createCameraController(inputBus, {
 *   initialCamera: { position: [0, 5, 10], target: [0, 0, 0], fov: 45 },
 *   orbit: { minDistance: 0.1, maxDistance: 500 },
 * });
 * ```
 */
export function createCameraController(
  inputBus: RendererInputBus,
  opts: CameraControlsOptions = {},
): CameraController {
  const camId = opts.initialCamera?.id ?? "main";
  const cam = new Camera();
  if (opts.initialCamera) {
    const ic = opts.initialCamera;
    if (ic.position) {
      if (ic.position.length !== 3) {
        throw new RangeError(`initialCamera.position must have length 3, got ${ic.position.length}`);
      }
      cam.setPosition(...ic.position);
    }
    if (ic.target) {
      if (ic.target.length !== 3) {
        throw new RangeError(`initialCamera.target must have length 3, got ${ic.target.length}`);
      }
      cam.setTarget(...ic.target);
    }
    if (ic.fov !== undefined) {
      if (!(ic.fov > 0)) {
        throw new RangeError(`initialCamera.fov must be > 0, got ${ic.fov}`);
      }
      cam.setFov(ic.fov);
    }
    if (ic.near !== undefined) {
      if (!(ic.near > 0)) {
        throw new RangeError(`initialCamera.near must be > 0, got ${ic.near}`);
      }
      cam.near = ic.near;
    }
    if (ic.far !== undefined) {
      if (ic.near !== undefined && !(ic.far > ic.near)) {
        throw new RangeError(`initialCamera.far (${ic.far}) must be > near (${ic.near})`);
      }
      cam.far = ic.far;
    }
  }

  const controller = new CameraController({
    ...opts.controller,
    defaultCameraId: camId,
  });
  // The constructor's defaultCameraId creates its own Camera; replace it
  // with our configured one.
  controller.removeCamera(camId);
  controller.addCamera(camId, cam);
  controller.setActive(camId);

  // Wire orbit/pan/zoom input from the supplied input bus.
  controller.bindOrbit(inputBus, opts.orbit);

  return controller;
}

/**
 * Creates a `RendererPlugin` that registers an orbit camera controller.
 * The controller is accessible via `ctx.getCameraController()` after
 * registration, or by capturing the return value of `createCameraControlsPlugin`.
 */
export function createCameraControlsPlugin(
  opts: CameraControlsOptions = {},
): RendererPlugin & { getController: () => CameraController | null } {
  let controller: CameraController | null = null;

  const plugin: RendererPlugin & { getController: () => CameraController | null } = {
    name: "camera-controls",
    version: "0.1.0",

    register(ctx) {
      controller = createCameraController(ctx.getInputBus(), opts);

      // Register as the active camera provider.
      ctx.setCameraController(controller);

      // Clean up on dispose.
      ctx.onDispose(() => {
        controller?.unbindOrbit();
        controller?.dispose();
        controller = null;
        ctx.setCameraController(null);
      });
    },

    getController() {
      return controller;
    },
  };

  return plugin;
}

/**
 * Convenience default instance with sensible orbit defaults. Games that need
 * custom sensitivity/lerp should use `createCameraControlsPlugin(opts)`.
 */
export const CameraControlsPlugin: RendererPlugin = createCameraControlsPlugin();

export { Camera, CameraController } from "@downdraft/core";
export type { CameraControllerOptions, OrbitInputOptions } from "@downdraft/core";

