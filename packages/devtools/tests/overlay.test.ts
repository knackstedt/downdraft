import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { store } from "../src/app/store";
import { computeLayout, installDockDrag, saveLayout, setLayoutPersistence } from "../src/ui/drawer";
import { PanelHost } from "../src/ui/host";
import { installHotkeys } from "../src/ui/hotkeys";

// Overlay-visibility gating: an embedded devtools surface must cost nothing
// and consume nothing while hidden.

const fakeHome = mkdtempSync(join(tmpdir(), "devtools-overlay-"));
let realHome: string | undefined;
beforeAll(() => { realHome = process.env.HOME; process.env.HOME = fakeHome; });
afterAll(() => { process.env.HOME = realHome; rmSync(fakeHome, { recursive: true, force: true }); });

function reset(): void {
  store.setState({
    overlayVisible: true,
    windowW: 1600, windowH: 1000, sidebarWidth: 230, sidebarVisible: true, topbarHeight: 30,
    mainTab: "console",
    docks: {
      bottom: { tabs: ["perfmon", "events", "network"], active: "perfmon", size: 250, collapsed: false },
      right: { tabs: ["source"], active: null, size: 420, collapsed: true },
    },
  });
  computeLayout();
}

/** Minimal input-bus stub capturing the key handler. */
function fakeKeyBus() {
  const handlers: { h: (e: { key: string; ctrlKey?: boolean }, c: { stopPropagation(): void }) => void }[] = [];
  const bus = {
    onKeyDown: (h: never) => { handlers.push({ h }); return () => {}; },
  };
  const mctx = { getInputBus: () => bus };
  const fire = (e: { key: string; ctrlKey?: boolean }) => {
    let stopped = false;
    handlers.forEach(({ h }) => h(e, { stopPropagation: () => { stopped = true; } }));
    return stopped;
  };
  return { mctx: mctx as never, fire };
}

describe("overlay visibility", () => {
  test("hidden overlay produces no desired panels", () => {
    reset();
    const host = new PanelHost(null as never, null as never);
    const desired = (host as unknown as { desired(): { id: string }[] }).desired;
    expect(desired.call(host).length).toBeGreaterThan(0);
    store.setState({ overlayVisible: false });
    expect(desired.call(host)).toEqual([]);
    store.setState({ overlayVisible: true });
  });

  test("toggleKey fires while hidden; other keys are gated", () => {
    reset();
    let toggled = 0;
    let visible = false;
    const { mctx, fire } = fakeKeyBus();
    const un = installHotkeys(mctx, {
      isVisible: () => visible,
      toggleKey: "F12",
      onToggle: () => { toggled++; },
    });
    // Hidden: F12 fires the toggle; Esc does nothing to the dock.
    expect(fire({ key: "F12" })).toBe(true);
    expect(toggled).toBe(1);
    expect(fire({ key: "Escape" })).toBe(false);
    expect(store.getState().docks.bottom.collapsed).toBe(false);
    // Visible: Esc reaches the drawer toggle again.
    visible = true;
    expect(fire({ key: "Escape" })).toBe(true);
    expect(store.getState().docks.bottom.collapsed).toBe(true);
    un();
  });

  test("dock drag does not start while hidden", () => {
    reset();
    let visible = false;
    const downs: ((e: { clientX: number; clientY: number }, c: { stopPropagation(): void }) => void)[] = [];
    type DownHandler = (e: { clientX: number; clientY: number }, c: { stopPropagation(): void }) => void;
    const bus = {
      onPointerDown: (h: DownHandler) => { downs.push(h); return () => {}; },
      onPointerMove: () => () => {},
      onPointerUp: () => () => {},
    };
    installDockDrag(bus, () => visible);
    // Bottom-dock divider: clientY at bottomRect.y, clientX past the sidebar.
    const y = store.getState().bottomRect.y;
    let stopped = false;
    downs.forEach((h) => h({ clientX: 500, clientY: y }, { stopPropagation: () => { stopped = true; } }));
    expect(stopped).toBe(false);
    visible = true;
    downs.forEach((h) => h({ clientX: 500, clientY: y }, { stopPropagation: () => { stopped = true; } }));
    expect(stopped).toBe(true);
  });

  test("persistLayout:false keeps saveLayout a no-op", () => {
    reset();
    setLayoutPersistence(false);
    saveLayout();
    expect(existsSync(join(fakeHome, ".local", "share", "downdraft-devtools", "layout.json"))).toBe(false);
    setLayoutPersistence(true);
  });
});
