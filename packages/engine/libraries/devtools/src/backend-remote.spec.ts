import { describe, test, expect } from "bun:test";
import { DevtoolsBackend } from "./backend";

// attachRemote fans the backend's event stream out to a second transport —
// how an embedded devtools surface (or external viewer) exposes a docked
// Blitz backend over the DevToolsServer WS without a second data engine.

function stubBackend() {
  return new DevtoolsBackend({
    emit: () => {},
    hasClient: () => false,
    cdp: {} as never,
    renderer: null,
    profilingSAB: null,
  });
}

describe("DevtoolsBackend.attachRemote", () => {
  test("remote sink receives emitted events", () => {
    const b = stubBackend();
    const got: { event: string; data: unknown }[] = [];
    b.attachRemote({ emit: (event, data) => got.push({ event, data }), hasClient: () => false });
    b.registerProvider("gpu", () => ({ status: "ok", sections: [] }));
    b.refreshPanel("gpu");
    expect(got.some((e) => e.event === "snapshot")).toBe(true);
    b.dispose();
  });

  test("both host emit and remote sink fire", () => {
    let host = 0;
    const b = new DevtoolsBackend({
      emit: () => { host++; },
      hasClient: () => false,
      cdp: {} as never,
      renderer: null,
      profilingSAB: null,
    });
    let remote = 0;
    b.attachRemote({ emit: () => { remote++; }, hasClient: () => false });
    b.registerProvider("sim", () => ({ status: "ok", sections: [] }));
    b.refreshPanel("sim");
    expect(host).toBeGreaterThan(0);
    expect(remote).toBe(host);
    b.dispose();
  });

  test("detach stops the fan-out", () => {
    const b = stubBackend();
    let remote = 0;
    const detach = b.attachRemote({ emit: () => { remote++; }, hasClient: () => false });
    b.registerProvider("gpu", () => ({ status: "ok", sections: [] }));
    b.refreshPanel("gpu");
    const n = remote;
    detach();
    b.refreshPanel("gpu");
    expect(remote).toBe(n);
    b.dispose();
  });

  test("a throwing sink does not poison the host emit", () => {
    let host = 0;
    const b = new DevtoolsBackend({
      emit: () => { host++; },
      hasClient: () => false,
      cdp: {} as never,
      renderer: null,
      profilingSAB: null,
    });
    b.attachRemote({
      emit: () => { throw new Error("dead client"); },
      hasClient: () => false,
    });
    b.registerProvider("gpu", () => ({ status: "ok", sections: [] }));
    b.refreshPanel("gpu");
    expect(host).toBeGreaterThan(0);
    b.dispose();
  });
});
