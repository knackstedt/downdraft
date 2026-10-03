import { describe, expect, it } from "bun:test";

import { EditorContext } from "../editor-context";
import { EditorCommandError, EditorCommandRegistry } from "./registry";

function makeCtx(): EditorContext {
  return new EditorContext({ fs: null });
}

describe("EditorCommandRegistry", () => {
  it("dispatches a registered command and returns its value", async () => {
    const ctx = makeCtx();
    const reg = new EditorCommandRegistry(ctx);
    reg.register({
      id: "test.ping",
      title: "Ping",
      mutating: false,
      apply: () => ({ value: { pong: true } }),
    });
    const v = await reg.dispatch("test.ping", {});
    expect(v).toEqual({ pong: true });
  });

  it("rejects unknown commands", async () => {
    const reg = new EditorCommandRegistry(makeCtx());
    await expect(reg.dispatch("nope.missing")).rejects.toThrow(EditorCommandError);
  });

  it("validates required params and primitive types", async () => {
    const reg = new EditorCommandRegistry(makeCtx());
    reg.register({
      id: "test.typed",
      title: "Typed",
      mutating: false,
      params: {
        type: "object",
        properties: {
          name: { type: "string" },
          count: { type: "integer" },
        },
        required: ["name"],
      },
      apply: (_c, p) => ({ value: p }),
    });
    await expect(reg.dispatch("test.typed", {})).rejects.toThrow(/missing required param "name"/);
    await expect(reg.dispatch("test.typed", { name: "x", count: "nope" })).rejects.toThrow(/expected integer/);
    expect(await reg.dispatch("test.typed", { name: "x", count: 3 })).toEqual({ name: "x", count: 3 });
  });

  it("journals mutating commands with inverses to the undo stack", async () => {
    const ctx = makeCtx();
    const reg = new EditorCommandRegistry(ctx);
    let flag = false;
    reg.register({
      id: "test.mutate",
      title: "Mutate",
      mutating: true,
      apply: () => {
        const old = flag;
        flag = true;
        return {
          value: { flag },
          inverse: [{ command: "test.restore", params: { old } }],
          description: "mutate flag",
        };
      },
    });
    reg.register({
      id: "test.restore",
      title: "Restore",
      mutating: true,
      apply: (_c, p) => {
        flag = p.old as boolean;
        return { value: { flag }, inverse: [{ command: "test.mutate", params: {} }] };
      },
    });

    await reg.dispatch("test.mutate");
    expect(flag).toBe(true);
    expect(reg.canUndo()).toBe(true);
    expect(reg.getJournal()).toHaveLength(1);

    await reg.undo();
    expect(flag).toBe(false);
    expect(reg.canUndo()).toBe(false);
    expect(reg.canRedo()).toBe(true);

    await reg.redo();
    expect(flag).toBe(true);
    expect(reg.canUndo()).toBe(true);
  });

  it("non-mutating commands land in the event log only", async () => {
    const reg = new EditorCommandRegistry(makeCtx());
    reg.register({ id: "test.read", title: "Read", mutating: false, apply: () => ({ value: 1 }) });
    await reg.dispatch("test.read");
    expect(reg.canUndo()).toBe(false);
    expect(reg.getEventLog()).toHaveLength(1);
    expect(reg.getEventLog()[0]!.command).toBe("test.read");
  });

  it("transactions merge N commands into one undo entry", async () => {
    const ctx = makeCtx();
    const reg = new EditorCommandRegistry(ctx);
    let v = 0;
    reg.register({
      id: "test.inc",
      title: "Inc",
      mutating: true,
      apply: (_c, p) => {
        const old = v;
        v += p.by as number;
        return {
          value: v,
          inverse: [{ command: "test.set", params: { v: old } }],
        };
      },
    });
    reg.register({
      id: "test.set",
      title: "Set",
      mutating: true,
      apply: (_c, p) => {
        v = p.v as number;
        return { value: v, inverse: [{ command: "test.inc", params: { by: 0 } }] };
      },
    });

    reg.beginTransaction("drag");
    await reg.dispatch("test.inc", { by: 1 });
    await reg.dispatch("test.inc", { by: 1 });
    await reg.dispatch("test.inc", { by: 1 });
    reg.endTransaction();

    expect(v).toBe(3);
    expect(reg.getJournal()).toHaveLength(1);
    expect(reg.getJournal()[0]!.command).toBe("__transaction__");

    await reg.undo();
    expect(v).toBe(0);           // first member's inverse restored the start

    await reg.redo();            // transaction replays each member
    expect(v).toBe(3);
  });

  it("notifies listeners on dispatch", async () => {
    const reg = new EditorCommandRegistry(makeCtx());
    reg.register({ id: "test.x", title: "X", mutating: false, apply: () => ({ value: null }) });
    const seen: string[] = [];
    const off = reg.onDispatched((e) => seen.push(e.command));
    await reg.dispatch("test.x");
    await reg.dispatch("test.x");
    off();
    await reg.dispatch("test.x");
    expect(seen).toEqual(["test.x", "test.x"]);
  });
});
