// ============================================================================
// devtools-web.spec.ts — in-process integration test for the web devtools
// stack: DevToolsServer (HTTP static + WS JSON-RPC) + WebDevtoolsMirror.
// Runs fully headless under Bun (Bun.serve + global WebSocket).
// ============================================================================

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CdpBridge } from "../cdp-bridge";
import { WebDevtoolsMirror } from "./mirror";
import { DevToolsServer } from "./server";

const _dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(_dirname, "../../../../../devtools-web");

let server: DevToolsServer;
let mirror: WebDevtoolsMirror;
let port = 0;
let token = "";

/** Minimal WS client: resolves events + RPC results. */
class TestClient {
  ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  events: { event: string; data: unknown }[] = [];
  private waiters = new Map<string, ((d: unknown) => void)[]>();
  opened: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("ws error"));
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
        }
        return;
      }
      this.events.push({ event: msg.event, data: msg.data });
      const w = this.waiters.get(msg.event);
      if (w) { this.waiters.delete(msg.event); w.forEach((fn) => fn(msg.data)); }
    };
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  waitFor(event: string, timeoutMs = 3000): Promise<unknown> {
    const prior = this.events.find((e) => e.event === event);
    if (prior) return Promise.resolve(prior.data);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
      const arr = this.waiters.get(event) ?? [];
      arr.push((d) => { clearTimeout(t); resolve(d); });
      this.waiters.set(event, arr);
    });
  }

  close(): void { this.ws.close(); }
}

beforeAll(async () => {
  // The dispatcher closure resolves `mirror` lazily — assigned below before
  // any client can connect.
  server = new DevToolsServer({
    webRoot: WEB_ROOT,
    call: (m, p) => mirror.dispatch(m, p),
  });
  const cdp = new CdpBridge();
  mirror = new WebDevtoolsMirror({
    server, cdp,
    renderer: null,
    gamePixiUi: null,
    profilingSAB: null,
  });
  await server.start();
  const u = new URL(server.url);
  port = Number(u.port);
  token = u.searchParams.get("t") ?? "";
});

afterAll(async () => {
  mirror.dispose();
  await server.stop();
});

describe("DevToolsServer", () => {
  it("serves /health without auth", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("serves the frontend index.html", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("DownDraft DevTools");
  });

  it("serves panel JS assets", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/panels/console.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("initConsolePanel");
  });

  it("blocks path traversal", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/../../etc/passwd`);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects WS without the token", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?t=wrong`);
    await new Promise<void>((resolve) => {
      ws.onerror = () => resolve();
      ws.onclose = () => resolve();
      setTimeout(resolve, 1500);
    });
    expect(ws.readyState).not.toBe(WebSocket.OPEN);
    ws.close();
  });

  it("writes a discovery file", async () => {
    const file = join(process.env.HOME ?? "", ".downdraft", "devtools", `${process.pid}.json`);
    const { existsSync, readFileSync } = await import("node:fs");
    expect(existsSync(file)).toBe(true);
    const d = JSON.parse(readFileSync(file, "utf8"));
    expect(d.port).toBe(port);
    expect(d.token).toBe(token);
  });
});

describe("WebDevtoolsMirror over WS", () => {
  let client: TestClient;

  beforeAll(async () => {
    client = new TestClient(`ws://127.0.0.1:${port}/ws?t=${token}`);
    await client.opened;
  });
  afterAll(() => client.close());

  it("sends hello with panel list", async () => {
    const hello = await client.waitFor("hello") as { version: number; panels: unknown[] };
    expect(hello.version).toBe(1);
    expect(Array.isArray(hello.panels)).toBe(true);
  });

  it("rpc ping → pong", async () => {
    expect(await client.call("ping")).toBe("pong");
  });

  it("snapshot RPC returns registered provider data", async () => {
    mirror.registerProvider("game", () => ({
      sections: [
        { kind: "kv", name: "Test", rows: [{ key: "hp", value: "42" }] },
        { kind: "controls", name: "", controls: [{ type: "button", id: "go", label: "Go" }] },
      ],
    }));
    const snap = await client.call("snapshot", { panel: "game" }) as { sections: { kind: string; rows?: { value: string }[] }[] };
    expect(snap.sections.length).toBe(2);
    expect(snap.sections[0].rows?.[0].value).toBe("42");
  });

  it("snapshot RPC reports unsupported for unregistered panels", async () => {
    const snap = await client.call("snapshot", { panel: "sim" }) as { status: string };
    expect(snap.status).toBe("unsupported");
  });

  it("command RPC dispatches to registered handlers", async () => {
    const got: { action: string; payload: string }[] = [];
    mirror.registerCommandHandler("game", (cmd) => { got.push({ action: cmd.action, payload: cmd.payload }); });
    expect(await client.call("command", { panel: "game", action: "go", payload: "x1" })).toBe(true);
    expect(got[0]).toEqual({ action: "go", payload: "x1" });
  });

  it("command 'refresh' re-pushes the provider snapshot", async () => {
    const waiter = client.waitFor("snapshot");
    await client.call("command", { panel: "game", action: "refresh" });
    const d = await waiter as { panel: string; snap: { sections: unknown[] } };
    expect(d.panel).toBe("game");
    expect(d.snap.sections.length).toBe(2);
  });

  it("eval RPC routes to main CDP (reports unavailability gracefully)", async () => {
    const res = await client.call("eval", { thread: "main", expr: "1+1" }) as { result?: unknown; error?: string };
    // Inspector may or may not be available in Bun; either way the RPC
    // must return a structured result, not throw.
    expect(res.result === 2 || typeof res.error === "string" || res.result === undefined).toBe(true);
  });

  it("eval RPC routes to a registered worker eval fn", async () => {
    mirror.registerThreadEval("sim", async (expr) => ({ result: `sim:${expr}` }));
    const res = await client.call("eval", { thread: "sim", expr: "tick" }) as { result?: string };
    expect(res.result).toBe("sim:tick");
  });

  it("threads RPC lists main + registered eval threads", async () => {
    const threads = await client.call("threads") as { id: string }[];
    expect(threads.some((t) => t.id === "main")).toBe(true);
    expect(threads.some((t) => t.id === "sim")).toBe(true);
  });

  it("inspector.call invokes window.__sceneInspector methods", async () => {
    const g = globalThis as Record<string, unknown>;
    const win = (g.window ??= {}) as Record<string, unknown>;
    win.__sceneInspector = { getVersion: () => "1.2.3", add: (a: number, b: number) => a + b };
    expect(await client.call("inspector.call", { method: "getVersion" })).toBe("1.2.3");
    expect(await client.call("inspector.call", { method: "add", args: [2, 3] })).toBe(5);
  });

  it("inspector.call errors on missing methods", async () => {
    const res = await client.call("inspector.call", { method: "nope" }).then(
      () => null,
      (e: Error) => e,
    );
    expect(String(res)).toContain("not a function");
  });

  it("push events reach clients (mirror.pushSceneTree)", async () => {
    const waiter = client.waitFor("scene");
    mirror.pushSceneTree();
    const rows = await waiter;
    expect(Array.isArray(rows)).toBe(true);
  });

  it("console.clear RPC emits console.clear event", async () => {
    const waiter = client.waitFor("console.clear");
    await client.call("console.clear");
    await waiter;
  });
});
