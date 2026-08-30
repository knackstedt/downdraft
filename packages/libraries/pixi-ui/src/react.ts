// ============================================================================
// @pixi/react adapter for @downdraft/library-pixi-ui.
//
// Optional module — games that want declarative React components rendering
// to PixiJS (inside the UI worker) add `@pixi/react` + `react` + `react-dom`
// to their deps and use this adapter.
//
// @pixi/react v8 uses `createRoot(canvas)` (like React DOM's createRoot) and
// creates its own PIXI.Application internally. When using @pixi/react, the
// scene factory should use this adapter's `createPixiReactRoot` instead of
// the worker's default PIXI.Application — the adapter calls @pixi/react's
// `createRoot` with the worker's OffscreenCanvas.
//
// Usage (inside the worker scene module):
//
//   import { createPixiReactRoot } from "@downdraft/library-pixi-ui/react";
//   import { Application, Container, Text } from "@pixi/react";
//   import React from "react";
//
//   export default async function createHudScene(ctx) {
//     const root = await createPixiReactRoot(ctx);
//     root.render(
//       <Application width={ctx.width} height={ctx.height} backgroundAlpha={0}>
//         <Text text="Hello PixiUI" x={16} y={16} />
//       </Application>
//     );
//     return {
//       root: ctx.app.stage, // @pixi/react manages the stage
//       update() {},          // React handles updates via re-renders
//       dispose() { root.unmount(); },
//     };
//   }
//
// Games must add `@pixi/react`, `react`, and `react-dom` to their deps and
// ensure `@vitejs/plugin-react` is applied to worker bundles (via
// `workerPlugins` in their vite config) for JSX to compile.
//
// NOTE: When using @pixi/react, the worker entry still creates a
// PIXI.Application on the OffscreenCanvas (for the default scene + SAB
// ticker). The @pixi/react `<Application>` component creates a SECOND
// PIXI.Application on the same canvas — this is not supported. Instead,
// use `createPixiReactRoot` which calls @pixi/react's `createRoot` with
// the existing OffscreenCanvas, and the `<Application>` component will
// reuse it. If your scene uses @pixi/react, do NOT add display objects
// to `ctx.app.stage` directly — let @pixi/react manage the stage.
// ============================================================================

import type { PixiUiSceneContext } from "./scene";

/**
 * Set up @pixi/react inside the UI worker, bound to the worker's
 * OffscreenCanvas. Returns a root with `render()` and `unmount()` methods.
 *
 * Uses @pixi/react v8's `createRoot()` API. The OffscreenCanvas is cast to
 * HTMLCanvasElement (structurally compatible for PIXI's ICanvas interface).
 */
export async function createPixiReactRoot(ctx: PixiUiSceneContext): Promise<PixiReactRoot> {
  // Dynamic import so the core library doesn't depend on @pixi/react.
  const pixiReact = await import("@pixi/react");
  const react = await import("react");

  // @pixi/react v8's createRoot takes HTMLElement | HTMLCanvasElement.
  // In a worker, we have an OffscreenCanvas — cast to the expected type.
  // PIXI accepts ICanvas (which OffscreenCanvas implements), so this works
  // at runtime even though the types don't perfectly match.
  const canvas = ctx.app.canvas as unknown as HTMLCanvasElement;
  const root = pixiReact.createRoot(canvas);

  return {
    render(element: React.ReactElement): void {
      root.render(element);
    },
    unmount(): void {
      root.render(null as any);
    },
    React: react,
    root,
    // Re-export @pixi/react components for convenience.
    components: pixiReact,
  };
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
