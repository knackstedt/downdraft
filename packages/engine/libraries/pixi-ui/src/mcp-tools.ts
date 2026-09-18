// ============================================================================
// MCP automation tools for the PixiUI overlay.
//
// Games call `createPixiUiMcpTools(host)` in their MCP setup to register
// tools that let the in-game MCP harness (and `draft test` e2e specs)
// verify the PixiJS overlay renders and is interactive:
//   - pixi_capture_overlay: capture the overlay canvas alone as PNG base64.
//   - pixi_get_scene_state: query the PixiJS scene-graph summary.
//   - pixi_dispatch_pointer: send a synthetic pointer event to the worker.
//   - pixi_set_interactive: force-toggle interactive mode.
//
// These integrate with the existing createMcpHarness from @downdraft/engine/app/renderer.
// ============================================================================

import { blobToBase64, type McpToolRegistration } from "./mcp-types-shim";
import type { PixiUiHost } from "./host";
import type { SceneStateSummary } from "./bridge-protocol";

/**
 * Create MCP tool registrations for driving the PixiUI overlay.
 * Games pass these to `createMcpHarness({ tools: [...] })`.
 */
export function createPixiUiMcpTools(host: PixiUiHost): McpToolRegistration[] {
  return [
    {
      def: {
        name: "pixi_capture_overlay",
        description:
          "Capture the PixiJS overlay canvas alone (not the game canvas) as a PNG image. " +
          "Returns the image inline as base64. Useful for verifying the UI renders correctly.",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => {
        const result = await host.captureOverlay();
        if (!result.png) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "Capture returned null" }) }] };
        }
        const blob = new Blob([result.png], { type: "image/png" });
        const base64 = await blobToBase64(blob);
        return {
          content: [
            { type: "text", text: JSON.stringify({ width: result.width, height: result.height, sizeBytes: result.png.byteLength }) },
            { type: "image", data: base64, mimeType: "image/png" },
          ],
        };
      },
    },
    {
      def: {
        name: "pixi_get_scene_state",
        description:
          "Query the PixiJS scene-graph state: named containers/sprites, visibility, " +
          "positions, text labels, and bounds. Returns a JSON summary. Used to assert " +
          "UI elements are present and visible without pixel matching.",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => {
        const state: SceneStateSummary = await host.queryScene();
        return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }] };
      },
    },
    {
      def: {
        name: "pixi_dispatch_pointer",
        description:
          "Dispatch a synthetic pointer event to the PixiJS overlay worker for hit-testing. " +
          "The overlay must be in interactive mode (use pixi_set_interactive first). " +
          "Coordinates are in canvas pixels (top-left origin).",
        inputSchema: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["pointerdown", "pointermove", "pointerup", "pointerleave"], description: "Pointer event type" },
            x: { type: "number", description: "X coordinate in canvas pixels" },
            y: { type: "number", description: "Y coordinate in canvas pixels" },
            button: { type: "number", default: 0, description: "Mouse button (0=left, 2=right)" },
          },
          required: ["type", "x", "y"],
        },
      },
      handler: (params: Record<string, unknown>) => {
        // Forward via the host's internal pointer forwarding by temporarily
        // switching to interactive + posting a pointer message.
        const type = params.type as string;
        const x = params.x as number;
        const y = params.y as number;
        const button = (params.button as number) ?? 0;
        // The host's forwardPointer is private; we use postEvent to send a
        // pointer message that the worker handles directly. But the worker's
        // pointer handler expects the main-thread pointer message format.
        // We use the host's setInteractive + a direct worker post via a
        // public method. Since PixiUiHost doesn't expose direct worker
        // access, we add a dispatchPointer method (see host.ts).
        host.dispatchPointer(type as any, x, y, button);
        return { content: [{ type: "text", text: JSON.stringify({ dispatched: true, type, x, y, button }) }] };
      },
    },
    {
      def: {
        name: "pixi_set_interactive",
        description:
          "Force-toggle the PixiJS overlay's interactive mode (pointer-events). " +
          "When true, the overlay canvas captures pointer events for PixiJS hit-testing. " +
          "When false, events pass through to the game canvas.",
        inputSchema: {
          type: "object",
          properties: {
            interactive: { type: "boolean", description: "Whether to enable interactive mode" },
          },
          required: ["interactive"],
        },
      },
      handler: (params: Record<string, unknown>) => {
        const interactive = params.interactive as boolean;
        host.setInteractive(interactive);
        return { content: [{ type: "text", text: JSON.stringify({ interactive }) }] };
      },
    },
  ];
}
