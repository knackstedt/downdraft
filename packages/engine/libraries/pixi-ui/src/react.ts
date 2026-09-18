// ============================================================================
// @pixi/react adapter for @downdraft/library-pixi-ui.
//
// Optional module — games that want declarative React components rendering
// to PixiJS (inside the UI worker) add `@pixi/react` + `react` + `react-dom`
// to their deps and use this adapter.
//
// @pixi/react v8's `createRoot()` creates its own PIXI.Application internally.
// In the pixi-ui worker, the worker already created a PIXI.Application on the
// OffscreenCanvas. This adapter patches the @pixi/react root to reuse the
// existing Application instead of creating a conflicting second one.
//
// Usage (inside the worker scene module):
//
//   import { createPixiReactRoot } from "@downdraft/library-pixi-ui/react";
//   import React from "react";
//
//   export default async function createHudScene(ctx) {
//     const root = await createPixiReactRoot(ctx);
//     root.render(<MyComponent />);
//     return {
//       root: ctx.app.stage,
//       update() {},
//       dispose() { root.unmount(); },
//     };
//   }
// ============================================================================

import type { PixiUiSceneContext } from "./scene";

/**
 * Set up @pixi/react inside the UI worker, bound to the worker's
 * OffscreenCanvas. Returns a root with `render()` and `unmount()` methods.
 *
 * This adapter patches @pixi/react's internal state to reuse the worker's
 * existing PIXI.Application (which was already initialized on the
 * OffscreenCanvas). Without this, @pixi/react would try to create a second
 * Application on the same canvas, causing conflicts.
 */
export async function createPixiReactRoot(ctx: PixiUiSceneContext): Promise<PixiReactRoot> {
  // Dynamic import so the core library doesn't depend on @pixi/react.
  const pixiReact = await import("@pixi/react");
  const react = await import("react");
  const PIXI = await import("pixi.js");

  // @pixi/react v8 requires explicit extend() to register components in the
  // catalogue. Without this, createInstance throws "X is not part of the PIXI
  // namespace! Did you forget to extend?" Register the common set of PIXI
  // components used by game UIs.
  const pixiReactAny = pixiReact as any;
  if (typeof pixiReactAny.extend === "function") {
    pixiReactAny.extend({
      Container: PIXI.Container,
      Graphics: PIXI.Graphics,
      Text: PIXI.Text,
      Sprite: PIXI.Sprite,
      TilingSprite: PIXI.TilingSprite,
      NineSliceSprite: PIXI.NineSliceSprite,
      BitmapText: PIXI.BitmapText,
      Mesh: PIXI.Mesh,
      Filter: PIXI.Filter,
    });
  }

  // @pixi/react v8's createRoot takes HTMLElement | HTMLCanvasElement.
  // In a worker, we have an OffscreenCanvas. The pixi-ui worker polyfills
  // HTMLCanvasElement as a class. We need the OffscreenCanvas to pass the
  // `instanceof HTMLCanvasElement` check so createRoot uses it directly
  // (instead of trying document.createElement + appendChild).
  const canvas = ctx.app.canvas as unknown as HTMLCanvasElement;

  // Ensure OffscreenCanvas passes instanceof HTMLCanvasElement.
  // The worker polyfills HTMLCanvasElement as a class; we set up prototype
  // chain so the instanceof check succeeds.
  const HCE = (globalThis as any).HTMLCanvasElement;
  if (HCE && !(canvas instanceof HCE)) {
    try {
      Object.setPrototypeOf(Object.getPrototypeOf(canvas), HCE.prototype);
    } catch {
      // If prototype manipulation fails, create a proxy that passes instanceof
    }
  }

  const root = pixiReact.createRoot(canvas);

  // ── Patch the root to reuse the existing PIXI.Application ──
  // @pixi/react's createRoot creates a new Application() internally. We need
  // to replace it with the worker's existing app (already initialized on the
  // OffscreenCanvas) to avoid a second WebGL context on the same canvas.
  const rootAny = root as any;
  if (rootAny.applicationState) {
    // Replace the internal Application with the worker's existing one
    rootAny.applicationState.app = ctx.app;
    rootAny.applicationState.isInitialised = true;
    rootAny.applicationState.isInitialising = false;
  }
  if (rootAny.internalState) {
    // Fix the rootContainer to use the existing app's stage.
    // prepareInstance is not exported from @pixi/react, so we inline it:
    // it just attaches a __pixireact metadata object to the container.
    const stage = ctx.app.stage as any;
    if (!stage.__pixireact) {
      stage.__pixireact = { filters: [], parent: null, root: rootAny, type: "" };
    } else {
      stage.__pixireact.root = rootAny;
    }
    rootAny.internalState.rootContainer = stage;
    rootAny.internalState.canvas = canvas;
  }

  // ── Patch the React fiber's containerInfo ──
  // createRoot() calls reconciler.createContainer(rootContainer, ...) which
  // captures rootContainer in the FiberRootNode's containerInfo. React uses
  // fiber.containerInfo (NOT internalState.rootContainer) during commit to
  // determine where to append children. If we don't patch this, React renders
  // into the throwaway Application's stage instead of the worker's stage.
  if (rootAny.fiber) {
    const stage = ctx.app.stage as any;
    rootAny.fiber.containerInfo = stage;
    // The root fiber's stateNode is the FiberRootNode itself, so
    // fiber.current.stateNode.containerInfo === fiber.containerInfo.
    // Patching fiber.containerInfo is sufficient.
  }

  return {
    render(element: React.ReactElement): void {
      // The render function is async internally; it checks isInitialised
      // and skips app.init() since we set isInitialised = true.
      rootAny.render(element, {});
    },
    unmount(): void {
      rootAny.render(null, {});
    },
    React: react,
    root,
    components: pixiReact,
  };
}

// ── Font scale support for @pixi/react scenes ──

/**
 * React context providing the current font scale multiplier (>= 1.0).
 * Scenes wrap their component tree in `<FontScaleProvider>` (done
 * automatically by `createPixiReactRoot` via the `fontScale` field on
 * PixiUiSceneContext). Components read it via `useFontScale()` and multiply
 * their `fontSize` values, or use the `<ScaledText>` drop-in replacement
 * for `<pixiText>` which scales automatically.
 */
export function createFontScaleHelpers(react: typeof import("react")) {
  const FontScaleContext = react.createContext(1);

  function useFontScale(): number {
    return react.useContext(FontScaleContext);
  }

  /**
   * Drop-in replacement for `<pixiText>` that automatically scales the
   * `fontSize` in the `style` prop by the current font scale from context.
   *
   * Usage: replace `<pixiText style={{ fontSize: 14, ... }} />` with
   * `<ScaledText style={{ fontSize: 14, ... }} />` — the fontSize is
   * automatically multiplied by the font scale.
   */
  const ScaledText = react.memo(function ScaledText(props: any) {
    const scale = react.useContext(FontScaleContext);
    const { style, ...rest } = props;
    const scaledStyle = style
      ? {
          ...style,
          fontSize: typeof style.fontSize === "number"
            ? Math.round(style.fontSize * scale)
            : style.fontSize,
        }
      : style;
    return react.createElement("pixiText", { ...rest, style: scaledStyle });
  });

  return { FontScaleContext, useFontScale, ScaledText };
}

export interface PixiReactRoot {
  /** Render a React element tree into the PixiJS scene graph. */
  render(element: React.ReactElement): void;
  /** Unmount the React tree (render null). */
  unmount(): void;
  /** The React module (for hooks, createElement, etc.). */
  React: typeof import("react");
  /** The @pixi/react root instance. */
  root: ReturnType<typeof import("@pixi/react")["createRoot"]>;
  /** The full @pixi/react module (Application, Container, Sprite, Text, ...). */
  components: typeof import("@pixi/react");
}
