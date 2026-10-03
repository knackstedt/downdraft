import { describe, expect, it } from "bun:test";

import { component } from "@downdraft/engine";

import { EditorContext, type EditorFs } from "../editor-context";
import { registerDefaultCommands } from "./index";

// Register a couple of test components once (the registry is process-global).
component("hp", { current: 100, max: 100 });
component("transform", { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

function makeEditor(files?: Map<string, string>): EditorContext {
  const fs: EditorFs | null = files
    ? {
        readText: async (p) => {
          const t = files.get(p);
          if (t === undefined) throw new Error(`ENOENT: ${p}`);
          return t;
        },
        writeText: async (p, t) => { files.set(p, t); },
        exists: async (p) => files.has(p),
      }
    : null;
  const ctx = new EditorContext({ fs });
  registerDefaultCommands(ctx.commands);
  return ctx;
}

const d = (ctx: EditorContext, id: string, params: Record<string, unknown> = {}) =>
  ctx.commands.dispatch(id, params, "internal") as Promise<any>;

describe("entity commands", () => {
  it("spawn → list → remove → undo/redo", async () => {
    const ctx = makeEditor();
    const { entity } = await d(ctx, "entity.spawn", { name: "crate", components: { hp: { current: 50 } } });
    expect(typeof entity).toBe("string");

    const list = await d(ctx, "entity.list");
    expect(list.count).toBe(1);
    expect(list.entities[0].name).toBe("crate");
    expect(list.entities[0].components).toContain("hp");

    await d(ctx, "entity.remove", { entity });
    expect((await d(ctx, "entity.list")).count).toBe(0);
    expect(ctx.document.isDirty()).toBe(true);

    await ctx.commands.undo();
    const afterUndo = await d(ctx, "entity.list");
    expect(afterUndo.count).toBe(1);
    // Restored entity gets a new key but keeps data + name
    expect(afterUndo.entities[0].name).toBe("crate");
    expect(afterUndo.entities[0].components).toContain("hp");

    await ctx.commands.redo();
    expect((await d(ctx, "entity.list")).count).toBe(0);
  });

  it("rename is journaled and undoable", async () => {
    const ctx = makeEditor();
    const { entity } = await d(ctx, "entity.spawn", { name: "a" });
    await d(ctx, "entity.rename", { entity, name: "b" });
    expect(ctx.document.entityName(entity)).toBe("b");
    await ctx.commands.undo();
    expect(ctx.document.entityName(entity)).toBe("a");
  });

  it("duplicate copies components and marks dirty", async () => {
    const ctx = makeEditor();
    const { entity } = await d(ctx, "entity.spawn", { name: "src", components: { hp: { current: 42 } } });
    const { entity: copy } = await d(ctx, "entity.duplicate", { entity });
    const comps = await d(ctx, "component.list", { entity: copy });
    expect(comps.components.hp).toEqual({ current: 42 });
    expect(ctx.document.entityName(copy)).toBe("src (copy)");
  });
});

describe("component commands", () => {
  it("set merges and undoes to prior data", async () => {
    const ctx = makeEditor();
    const { entity } = await d(ctx, "entity.spawn", { components: { hp: { current: 100, max: 100 } } });
    await d(ctx, "component.set", { entity, component: "hp", changes: { current: 30 } });
    let comps = await d(ctx, "component.list", { entity });
    expect(comps.components.hp).toEqual({ current: 30, max: 100 });
    await ctx.commands.undo();
    comps = await d(ctx, "component.list", { entity });
    expect(comps.components.hp).toEqual({ current: 100, max: 100 });
  });

  it("add/remove round-trip via undo", async () => {
    const ctx = makeEditor();
    const { entity } = await d(ctx, "entity.spawn", {});
    await d(ctx, "component.add", { entity, component: "hp", data: { current: 7, max: 7 } });
    expect((await d(ctx, "component.list", { entity })).components.hp).toBeDefined();
    await d(ctx, "component.remove", { entity, component: "hp" });
    expect((await d(ctx, "component.list", { entity })).components.hp).toBeUndefined();
    await ctx.commands.undo();
    expect((await d(ctx, "component.list", { entity })).components.hp).toEqual({ current: 7, max: 7 });
  });
});

describe("hierarchy commands", () => {
  it("setParent + undo restores prior parent", async () => {
    const ctx = makeEditor();
    const { entity: parent } = await d(ctx, "entity.spawn", { name: "p" });
    const { entity: child } = await d(ctx, "entity.spawn", { name: "c" });
    await d(ctx, "hierarchy.setParent", { entity: child, parent });
    let tree = await d(ctx, "scene.getTree");
    expect(tree.entities.find((e: any) => e.key === child).parent).toBe(parent);
    await ctx.commands.undo();
    tree = await d(ctx, "scene.getTree");
    expect(tree.entities.find((e: any) => e.key === child).parent).toBeNull();
  });

  it("remove parent then undo re-parents children onto restored entity", async () => {
    const ctx = makeEditor();
    const { entity: parent } = await d(ctx, "entity.spawn", { name: "p" });
    const { entity: child } = await d(ctx, "entity.spawn", { name: "c", parent });
    await d(ctx, "entity.remove", { entity: parent });
    await ctx.commands.undo();
    const tree = await d(ctx, "scene.getTree");
    const childNode = tree.entities.find((e: any) => e.name === "c");
    const parentNode = tree.entities.find((e: any) => e.name === "p");
    expect(parentNode).toBeDefined();
    expect(childNode.parent).toBe(parentNode.key);
  });
});

describe("transform commands", () => {
  it("transform.set creates the component and undoes", async () => {
    const ctx = makeEditor();
    const { entity } = await d(ctx, "entity.spawn", {});
    await d(ctx, "transform.set", { entity, position: [1, 2, 3] });
    const t = await d(ctx, "transform.get", { entity });
    expect(t.transform.position).toEqual([1, 2, 3]);
    await ctx.commands.undo();
    const t2 = await d(ctx, "transform.get", { entity });
    expect(t2.transform.position).toEqual([0, 0, 0]);
  });
});

describe("selection commands", () => {
  it("selection is journaled but never undoable", async () => {
    const ctx = makeEditor();
    const { entity } = await d(ctx, "entity.spawn", {});
    const journalDepth = ctx.commands.getJournal().length;
    await d(ctx, "selection.set", { entities: [entity] });
    expect(ctx.selection.get()).toEqual([entity]);
    // spawn is undoable; selection.set must not add to the undo stack
    expect(ctx.commands.getJournal()).toHaveLength(journalDepth);
    expect(ctx.commands.getEventLog().at(-1)!.command).toBe("selection.set");
    await d(ctx, "selection.clear");
    expect(ctx.selection.size).toBe(0);
  });
});

describe("scene io + ddscene", () => {
  it("save → new → open round-trips the document", async () => {
    const files = new Map<string, string>();
    const ctx = makeEditor(files);
    const { entity } = await d(ctx, "entity.spawn", {
      name: "dock",
      components: { transform: { position: [5, 0, 5] } },
    });
    const { entity: child } = await d(ctx, "entity.spawn", { name: "rope", parent: entity });

    ctx.document.name = "harbor";
    await d(ctx, "scene.saveAs", { path: "/scenes/harbor.ddscene" });
    expect(files.has("/scenes/harbor.ddscene")).toBe(true);
    expect(ctx.document.isDirty()).toBe(false);

    await d(ctx, "scene.new", { name: "empty" });
    expect((await d(ctx, "entity.list")).count).toBe(0);

    await d(ctx, "scene.open", { path: "/scenes/harbor.ddscene" });
    const tree = await d(ctx, "scene.getTree");
    expect(tree.name).toBe("harbor");
    expect(tree.entities).toHaveLength(2);
    const rope = tree.entities.find((e: any) => e.name === "rope");
    const dock = tree.entities.find((e: any) => e.name === "dock");
    expect(rope.parent).toBe(dock.key);
    expect(dock.components).toContain("transform");
    expect(ctx.document.isDirty()).toBe(false);
    void child;
  });

  it("scene.diff vs file reports changed entities", async () => {
    const files = new Map<string, string>();
    const ctx = makeEditor(files);
    const { entity } = await d(ctx, "entity.spawn", { name: "a" });
    await d(ctx, "scene.saveAs", { path: "/s.ddscene" });
    await d(ctx, "transform.set", { entity, position: [9, 9, 9] });
    const diff = await d(ctx, "scene.diff");
    expect(diff.changed).toHaveLength(1);
  });

  it("scene.new is undoable — restores prior document", async () => {
    const ctx = makeEditor();
    await d(ctx, "entity.spawn", { name: "kept" });
    await d(ctx, "scene.new", { name: "wiped" });
    expect((await d(ctx, "entity.list")).count).toBe(0);
    await ctx.commands.undo();
    const list = await d(ctx, "entity.list");
    expect(list.count).toBe(1);
    expect(list.entities[0].name).toBe("kept");
  });
});

describe("prefab commands", () => {
  it("create → instantiate → list", async () => {
    const ctx = makeEditor();
    const { entity } = await d(ctx, "entity.spawn", {
      name: "crateProto",
      components: { hp: { current: 10, max: 10 }, transform: { position: [1, 0, 0] } },
    });
    await d(ctx, "prefab.create", { entity, name: "crate" });
    const { entity: inst } = await d(ctx, "prefab.instantiate", { prefab: "crate" });
    const comps = await d(ctx, "component.list", { entity: inst });
    expect(comps.components.hp).toEqual({ current: 10, max: 10 });
    expect((await d(ctx, "prefab.list")).prefabs).toContain("crate");
    await ctx.commands.undo(); // undo instantiate
    expect((await d(ctx, "entity.list")).count).toBe(1);
  });
});
