// ============================================================================
// Minimal MCP type declarations for the to-the-ocean automation harness.
// These mirror the relevant types from @downdraft/mcp/types so the renderer
// does not have to import the Node-only MCP package.
// ============================================================================

export interface MCPToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, MCPPropertySchema>;
    required?: string[];
  };
}

export interface MCPPropertySchema {
  type: "string" | "number" | "boolean" | "array" | "object";
  description?: string;
  enum?: string[];
  items?: MCPPropertySchema;
  properties?: Record<string, MCPPropertySchema>;
  required?: string[];
  default?: unknown;
}

export interface MCPToolResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
    | { type: "resource"; resource: { uri: string; mimeType?: string; text?: string } }
  >;
  isError?: boolean;
}

export type ToolHandler = (params: Record<string, unknown>) => Promise<MCPToolResult> | MCPToolResult;

export interface ToolRegistration {
  def: MCPToolDef;
  handler: ToolHandler;
}

export function textResult(text: string, isError: boolean = false): MCPToolResult {
  return { content: [{ type: "text", text }], isError };
}

export function jsonResult(data: unknown, isError: boolean = false): MCPToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError };
}

export function errorResult(message: string): MCPToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
