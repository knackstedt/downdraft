import { describe, expect, it } from "bun:test";

import { component } from "@downdraft/engine";

import { registerDefaultCommands } from "./commands/index";
import { EditorContext } from "./editor-context";
import { createEditorMcpTools } from "./mcp";

component("hp", { current: 100, max: 100 });

function makeEditor(): EditorContext {
  const ctx = new EditorContext({ fs: null });
  registerDefaultCommands(ctx.commands);
  return ctx;
}

function textOf(result: unknown): unknown {
  const text = (result as { content?: { type: string; text?: string }[] }).content?.[0]?.text ?? "";
  return JSON.parse(text);
}

describe("editor MCP tools", () => {
  it("generates an editor_* tool per command plus meta tools", async () => {
    const ctx = makeEditor();
    const tools = createEditorMcpTools(ctx);
    const names = tools.map((t) => t.def.name);
    expect(names).toContain("editor_entity_spawn");
    expect(names).toContain("editor_component_set");
    expect(names).toContain("editor_transform_set");
    expect(names).toContain("editor_scene_open");
    expect(names).toContain("editor_prefab_instantiate");
    expect(names).toContain("editor_undo");
    expect(names).toContain("editor_commands");
    expect(names).toContain("editor_journal");

    // Param schemas flow through verbatim
    const spawn = tools.find((t) => t.def.name === "editor_entity_spawn")!;
    expect((spawn.def.inputSchema.properties as Record<string, unknown>).name).toBeDefined();
  });

  it("dispatches through the registry with source=mcp", async () => {
    const ctx = makeEditor();
    const tools = createEditorMcpTools(ctx);
    const spawn = tools.find((t) => t.def.name === "editor_entity_spawn")!;
    const res = await spawn.handler({ name: "agent-box", components: { hp: { current: 5 } } });
    const val = textOf(res) as { entity: string };
    expect(val.entity).toBeTruthy();

    const list = tools.find((t) => t.def.name === "editor_entity_list")!;
    const out = textOf(await list.handler({})) as { count: number; entities: { name: string }[] };
    expect(out.count).toBe(1);
    expect(out.entities[0]!.name).toBe("agent-box");

    // The dispatch was attributed to source "mcp" in the event log
    expect(ctx.commands.getEventLog().at(-1)!.source).toBe("mcp");
  });

  it("validation errors surface as MCP error results", async () => {
    const ctx = makeEditor();
    const tools = createEditorMcpTools(ctx);
    const spawn = tools.find((t) => t.def.name === "editor_entity_spawn")!;
    const res = await spawn.handler({ name: 123 as unknown as string });
    const body = textOf(res) as { error?: string };
    expect(body.error).toMatch(/expected string/);
  });

  it("undo via MCP reverts an mcp-applied mutation", async () => {
    const ctx = makeEditor();
    const tools = createEditorMcpTools(ctx);
    const spawn = tools.find((t) => t.def.name === "editor_entity_spawn")!;
    const undo = tools.find((t) => t.def.name === "editor_undo")!;
    const list = tools.find((t) => t.def.name === "editor_entity_list")!;

    await spawn.handler({ name: "tmp" });
    expect((textOf(await list.handler({})) as { count: number }).count).toBe(1);
    await undo.handler({});
    expect((textOf(await list.handler({})) as { count: number }).count).toBe(0);
  });
});
