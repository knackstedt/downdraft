// ============================================================================
// mcp-types-shim — local MCP tool types + helpers for @downdraft/library-pixi-ui.
//
// The library doesn't depend on @downdraft/app (engine libraries are lower
// in the dependency graph). These types are structurally compatible with
// McpToolRegistration from @downdraft/app/renderer, so games can pass the
// result of createPixiUiMcpTools() directly to createMcpHarness({ tools }).
// ============================================================================

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolRegistration {
  def: McpToolDef;
  handler: (params: Record<string, unknown>) => Promise<unknown> | unknown;
}

/** Convert a Blob to a base64 string (without the data: prefix). */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      const base64 = result.split(",")[1];
      resolve(base64 ?? "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
