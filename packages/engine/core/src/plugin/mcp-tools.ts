// ============================================================================
// MCP automation tools for the plugin system.
//
// Games call `createPluginMcpTools(pluginHost)` in their MCP setup to register
// tools that let the in-game MCP harness (and `draft test` e2e specs) inspect
// and control plugins:
//   - plugin_list: list all discovered plugins with status.
//   - plugin_get_info: get detailed info for a single plugin.
//   - plugin_reload: reload a plugin by id.
//   - plugin_unload: unload a plugin by id.
//   - plugin_get_state: get a plugin's KV state.
//
// These integrate with the existing createMcpHarness from @downdraft/app/renderer.
// ============================================================================

import type { PluginHost } from "./host";

/** MCP tool definition (structurally compatible with McpToolRegistration). */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolRegistration {
  def: McpToolDef;
  handler: (params: Record<string, unknown>) => Promise<unknown> | unknown;
}

function jsonResult(data: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function errorResult(msg: string): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: JSON.stringify({ error: msg }) }] };
}

/**
 * Create MCP tool registrations for plugin management.
 * Games pass these to `createMcpHarness({ tools: [...] })`.
 */
export function createPluginMcpTools(pluginHost: PluginHost): McpToolRegistration[] {
  return [
    {
      def: {
        name: "plugin_list",
        description:
          "List all discovered plugins with their current status, format, tier, and thread. " +
          "Useful for verifying plugins loaded correctly in e2e tests.",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => {
        const snap = pluginHost.snapshot();
        return jsonResult({
          count: snap.length,
          plugins: snap.map((p) => ({
            id: p.id,
            name: p.name,
            version: p.version,
            format: p.format,
            tier: p.tier,
            thread: p.thread,
            status: p.status,
            error: p.error,
            permissions: p.permissions,
          })),
        });
      },
    },
    {
      def: {
        name: "plugin_get_info",
        description:
          "Get detailed info for a single plugin by id, including denied permissions and source.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Plugin id" },
          },
          required: ["id"],
        },
      },
      handler: async (params) => {
        const id = params.id as string;
        const snap = pluginHost.snapshot();
        const info = snap.find((p) => p.id === id);
        if (!info) return errorResult(`Plugin "${id}" not found`);
        return jsonResult(info);
      },
    },
    {
      def: {
        name: "plugin_reload",
        description:
          "Reload a plugin by id. The plugin is unloaded and re-loaded from its source. " +
          "Useful for testing plugin lifecycle in e2e specs.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Plugin id" },
          },
          required: ["id"],
        },
      },
      handler: async (params) => {
        const id = params.id as string;
        try {
          await pluginHost.reload(id);
          const snap = pluginHost.snapshot();
          const info = snap.find((p) => p.id === id);
          return jsonResult({ success: true, status: info?.status, error: info?.error });
        } catch (e) {
          return errorResult(`Failed to reload plugin "${id}": ${(e as Error).message}`);
        }
      },
    },
    {
      def: {
        name: "plugin_unload",
        description:
          "Unload a plugin by id. The plugin is disposed and removed from the active set.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Plugin id" },
          },
          required: ["id"],
        },
      },
      handler: async (params) => {
        const id = params.id as string;
        try {
          pluginHost.unload(id);
          return jsonResult({ success: true });
        } catch (e) {
          return errorResult(`Failed to unload plugin "${id}": ${(e as Error).message}`);
        }
      },
    },
    {
      def: {
        name: "plugin_get_state",
        description:
          "Get a plugin's KV state keys. Returns the list of state keys for the plugin.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Plugin id" },
          },
          required: ["id"],
        },
      },
      handler: async (params) => {
        const id = params.id as string;
        const snap = pluginHost.snapshot();
        const info = snap.find((p) => p.id === id);
        if (!info) return errorResult(`Plugin "${id}" not found`);
        // The PluginHost doesn't expose the per-plugin state store directly,
        // but the snapshot includes the manifest. For full state access, the
        // game would need to expose the context backing. This is a stub.
        return jsonResult({ id, stateKeys: [], note: "State access requires game-side wiring" });
      },
    },
  ];
}
