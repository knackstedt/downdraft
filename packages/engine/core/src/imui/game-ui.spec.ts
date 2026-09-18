import type { RendererModuleContext } from "../module/renderer-module";
import { UIPanel, UIRoot, UIText } from "./element";
import { createGameUi, setUIFontScale, type GameUiContext, type UISubscribable } from "./game-ui";
import { UIInputRouter } from "./input";

/** Minimal RendererModuleContext fake — only the surface createGameUi uses. */
function makeCtx() {
  const uiRoot = new UIRoot(800, 600);
  const router = new UIInputRouter();
  router.setRoot(uiRoot);
  const frameHooks = new Map<string, Array<(dt: number, t: number) => void>>();
  const resizeHooks: Array<(w: number, h: number, dpr: number) => void> = [];
  const disposeFns: Array<() => void> = [];
  let layoutInvalidated = 0;
  const provided = new Map<string, unknown>();

  const ctx = {
    name: "test",
    getUIRoot: () => uiRoot,
    getUIInputRouter: () => router,
    invalidateUILayout: () => { layoutInvalidated++; },
    onFrame: (phase: string, fn: (dt: number, t: number) => void) => {
      const arr = frameHooks.get(phase) ?? [];
      arr.push(fn);
      frameHooks.set(phase, arr);
      return () => {};
    },
    onResize: (fn: (w: number, h: number, dpr: number) => void) => {
      resizeHooks.push(fn);
      return () => {};
    },
    onRenderPass: () => () => {},
    onDispose: (fn: () => void) => { disposeFns.push(fn); },
    provide: (token: { key: string }, value: unknown) => { provided.set(token.key, value); },
    inject: <T,>(token: { key: string }): T => provided.get(token.key) as T,
    injectOptional: <T,>(token: { key: string }): T | undefined => provided.get(token.key) as T | undefined,
  } as unknown as RendererModuleContext;

  const dispatch = (phase: string, dt = 16, t = 100) => {
    for (const fn of frameHooks.get(phase) ?? []) fn(dt, t);
  };
  const dispose = () => { for (const fn of disposeFns) fn(); };

  return { ctx, uiRoot, router, dispatch, dispose, get layoutInvalidated() { return layoutInvalidated; }, provided };
}

function makeStore<S>(initial: S): UISubscribable<S> & { set(s: S): void } {
  let state = initial;
  const listeners: Array<(s: S, p: S) => void> = [];
  return {
    getState: () => state,
    set(s: S) {
      const prev = state;
      state = s;
      for (const l of listeners) l(state, prev);
    },
    subscribe(l) {
      listeners.push(l);
      return () => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); };
    },
  };
}

describe("createGameUi", () => {
  it("mounts a pointerThrough container under the UIRoot and provides GameUiTok", () => {
    const env = makeCtx();
    const mod = createGameUi({ build: () => {} });
    mod.register(env.ctx);
    expect(env.uiRoot.children.length).toBe(1);
    const container = env.uiRoot.children[0] as UIPanel;
    expect(container.pointerThrough).toBe(true);
    expect(env.provided.has("gameUi")).toBe(true);
    expect(env.layoutInvalidated).toBeGreaterThan(0);
  });

  it("runs onUpdate hooks at the afterViewports phase", () => {
    const { ctx, dispatch } = makeCtx();
    let ran = 0;
    createGameUi({
      build(ui) { ui.onUpdate(() => ran++); },
    }).register(ctx);
    dispatch("beforeFrame");
    expect(ran).toBe(0);
    dispatch("afterViewports");
    dispatch("afterViewports");
    expect(ran).toBe(2);
  });

  it("find locates named descendants", () => {
    const { ctx } = makeCtx();
    let ui!: GameUiContext;
    createGameUi({
      build(u) {
        ui = u;
        const p = new UIPanel();
        p.name = "hud";
        const t = new UIText("hi");
        t.name = "label";
        p.addChild(t);
        u.root.addChild(p);
      },
    }).register(ctx);
    expect(ui.find<UIText>("label")?.text).toBe("hi");
    expect(ui.find("missing")).toBeUndefined();
  });

  it("bind applies immediately, on change, and skips equal values", () => {
    const { ctx } = makeCtx();
    const store = makeStore({ hp: 10 });
    const seen: number[] = [];
    createGameUi({
      build(ui) { ui.bind(store, (s) => s.hp, (v) => seen.push(v)); },
    }).register(ctx);
    expect(seen).toEqual([10]);
    store.set({ hp: 10 });
    store.set({ hp: 7 });
    expect(seen).toEqual([10, 7]);
  });

  it("unsubscribes bindings and removes the container on dispose", () => {
    const { ctx, uiRoot, dispose } = makeCtx();
    const store = makeStore({ hp: 10 });
    const seen: number[] = [];
    createGameUi({
      build(ui) { ui.bind(store, (s) => s.hp, (v) => seen.push(v)); },
    }).register(ctx);
    dispose();
    store.set({ hp: 1 });
    expect(seen).toEqual([10]);
    expect(uiRoot.children.length).toBe(0);
  });

  it("isPointerOverUI reflects hit-testing against interactive children", () => {
    const { ctx, router } = makeCtx();
    let ui!: GameUiContext;
    createGameUi({
      build(u) {
        ui = u;
        const btn = new UIPanel(50, 50);
        btn.x = 10;
        btn.y = 10;
        u.root.addChild(btn);
      },
    }).register(ctx);
    router.handleMouseMove(20, 20);
    expect(ui.isPointerOverUI()).toBe(true);
    router.handleMouseMove(500, 500);
    expect(ui.isPointerOverUI()).toBe(false);
  });
});

describe("setUIFontScale", () => {
  it("scales fontSize relative to base sizes across the subtree", () => {
    const root = new UIPanel();
    const a = new UIText("a");
    a.style.fontSize = 12;
    const b = new UIText("b");
    b.style.fontSize = 20;
    root.addChild(a);
    a.addChild(b);
    setUIFontScale(root, 2);
    expect(a.style.fontSize).toBe(24);
    expect(b.style.fontSize).toBe(40);
    setUIFontScale(root, 1);
    expect(a.style.fontSize).toBe(12);
    expect(b.style.fontSize).toBe(20);
  });
});

describe("UIInputRouter pointer-over-UI", () => {
  it("returns false when pointer hits only the root or is untracked", () => {
    const root = new UIRoot();
    root.width = 800;
    root.height = 600;
    const router = new UIInputRouter();
    router.setRoot(root);
    expect(router.isPointerOverUI()).toBe(false);
    router.handleMouseMove(100, 100);
    expect(router.isPointerOverUI()).toBe(false);
  });

  it("pointerThrough containers let children hit-test but not themselves", () => {
    const root = new UIRoot();
    root.width = 800;
    root.height = 600;
    const wrap = new UIPanel(800, 600);
    wrap.pointerThrough = true;
    const btn = new UIPanel(40, 40);
    btn.x = 5;
    btn.y = 5;
    wrap.addChild(btn);
    root.addChild(wrap);
    const router = new UIInputRouter();
    router.setRoot(root);
    router.handleMouseMove(10, 10);
    expect(router.isPointerOverUI()).toBe(true);
    router.handleMouseMove(400, 300);
    expect(router.isPointerOverUI()).toBe(false);
  });
});
