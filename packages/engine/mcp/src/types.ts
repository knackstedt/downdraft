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

export interface MCPResourceDef {
  uri: string;
  name: string;
  description: string;
  mimeType?: string;
}

export interface MCPPromptDef {
  name: string;
  description: string;
  arguments?: Array<{
    name: string;
    description: string;
    required?: boolean;
  }>;
}

export interface MCPToolResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
    | { type: "resource"; resource: { uri: string; mimeType?: string; text?: string } }
  >;
  isError?: boolean;
}

export interface MCPResourceResult {
  contents: Array<{
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  }>;
}

export interface MCPPromptResult {
  messages: Array<{
    role: "user" | "assistant" | "system";
    content: { type: "text"; text: string };
  }>;
}

export type ToolHandler = (params: Record<string, unknown>) => Promise<MCPToolResult> | MCPToolResult;
export type ResourceHandler = (uri: string) => Promise<MCPResourceResult> | MCPResourceResult;
export type PromptHandler = (args: Record<string, string>) => Promise<MCPPromptResult> | MCPPromptResult;

export interface ToolRegistration {
  def: MCPToolDef;
  handler: ToolHandler;
}

export interface ResourceRegistration {
  def: MCPResourceDef;
  handler: ResourceHandler;
}

export interface PromptRegistration {
  def: MCPPromptDef;
  handler: PromptHandler;
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
