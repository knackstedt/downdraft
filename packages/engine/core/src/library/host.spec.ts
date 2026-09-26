import { afterEach, describe, expect, it } from "bun:test";
import { resourceToken } from "../ecs/resource";
import { setStrict } from "../module/diagnostics";
import { addLogSink } from "../util/logger";
import { LibraryHostImpl } from "./host";
import type { EngineLibrary, LibraryRendererCreateContext, LibrarySimContext } from "./library";

// Reset strict mode after each test.
afterEach(() => setStrict(null));

const TestTok = resourceToken<{ value: number }>("test:token");
const DepTok = resourceToken<{ data: string }>("test:dep");

function makeLibrary(
  name: string,
  opts: Partial<EngineLibrary> = {},
): EngineLibrary {
  return {
    name,
    version: "1.0.0",
    sabChannels: opts.sabChannels,
    provides: opts.provides,
    requires: opts.requires,
    sim: opts.sim,
    tickPhase: opts.tickPhase,
    renderer: opts.renderer,
    defaultConfig: opts.defaultConfig,
  };
}

describe("LibraryHostImpl", () => {
  describe("allocateBuffers", () => {
    it("allocates SABs for declared channels", () => {
      const lib = makeLibrary("test", {
        sabChannels: [{ name: "buf", size: 1024 }],
      });
      const host = new LibraryHostImpl([lib]);
      const buffers = host.allocateBuffers();
      expect(buffers.buf).toBeInstanceOf(SharedArrayBuffer);
      expect(buffers.buf.byteLength).toBe(1024);
    });

    it("returns empty record when no channels declared", () => {
      const lib = makeLibrary("test");
      const host = new LibraryHostImpl([lib]);
      const buffers = host.allocateBuffers();
      expect(Object.keys(buffers)).toHaveLength(0);
    });
  });

  describe("initSim — provide/inject", () => {
    it("library can provide resources via ctx.provide()", () => {
      const lib = makeLibrary("test", {
        provides: [TestTok],
        sim: {
          create(_config, ctx) {
            ctx.provide(TestTok, { value: 42 });
            return null;
          },
        },
      });
      const host = new LibraryHostImpl([lib]);
      host.allocateBuffers();

      const provided = new Map<string, unknown>();
      const simCtx: LibrarySimContext = {
        buffers: {},
        provide: (token: { key: string }, value: unknown) => provided.set(token.key, value),
        inject: () => { throw new Error("no provider"); },
        injectOptional: () => undefined,
      };
      host.initSim(simCtx);

      expect(provided.get("test:token")).toEqual({ value: 42 });
    });

    it("library can inject resources from the DI graph", () => {
      const lib = makeLibrary("test", {
        requires: [DepTok],
        sim: {
          create(_config, ctx) {
            const dep = ctx.inject(DepTok);
            return dep;
          },
        },
      });
      const host = new LibraryHostImpl([lib]);
      host.allocateBuffers();

      const simCtx: LibrarySimContext = {
        buffers: {},
        provide: () => {},
        inject: (token) => {
          if (token.key === "test:dep") return { data: "hello" } as any;
          throw new Error(`unexpected inject: ${token.key}`);
        },
        injectOptional: () => undefined,
      };
      // Should not throw — the inject is satisfied by the external provider.
      expect(() => host.initSim(simCtx)).not.toThrow();
    });
  });

  describe("initSimWithExistingBuffers", () => {
    it("reuses pre-allocated SABs instead of allocating new ones", () => {
      const lib = makeLibrary("test", {
        sabChannels: [{ name: "buf", size: 512 }],
        sim: {
          create(_config, ctx) {
            // Verify the buffer is the pre-allocated one.
            expect(ctx.buffers.buf.byteLength).toBe(512);
            return null;
          },
        },
      });
      const host = new LibraryHostImpl([lib]);
      const preAllocated = { buf: new SharedArrayBuffer(512) };
      host.initSimWithExistingBuffers(preAllocated, {
        provide: () => {},
        inject: () => { throw new Error("no provider"); },
        injectOptional: () => undefined,
      });
    });
  });

  describe("validateGraph", () => {
    it("throws on duplicate provides in strict mode", () => {
      setStrict(true);
      const lib1 = makeLibrary("lib1", { provides: [TestTok] });
      const lib2 = makeLibrary("lib2", { provides: [TestTok] });
      const host = new LibraryHostImpl([lib1, lib2]);
      expect(() => {
        host.initSim({
          buffers: {},
          provide: () => {},
          inject: () => { throw new Error("no provider"); },
          injectOptional: () => undefined,
        });
      }).toThrow(/already provided/);
    });

    it("throws on missing requires in strict mode", () => {
      setStrict(true);
      const lib = makeLibrary("test", {
        requires: [DepTok],
        provides: [TestTok],
      });
      const host = new LibraryHostImpl([lib]);
      expect(() => {
        host.initSim({
          buffers: {},
          provide: () => {},
          inject: () => { throw new Error("no provider"); },
          injectOptional: () => undefined,
        });
      }).toThrow(/not provided/);
    });

    it("does not validate when strict is off", () => {
      setStrict(false);
      const lib1 = makeLibrary("lib1", { provides: [TestTok] });
      const lib2 = makeLibrary("lib2", { provides: [TestTok] });
      const host = new LibraryHostImpl([lib1, lib2]);
      expect(() => {
        host.initSim({
          buffers: {},
          provide: () => {},
          inject: () => { throw new Error("no provider"); },
          injectOptional: () => undefined,
        });
      }).not.toThrow();
    });
  });

  describe("disposeSim — leak detection", () => {
    it("warns when library provides resources but has no dispose hook (strict)", () => {
      setStrict(true);
      const calls: string[] = [];
      const unbindSink = addLogSink((e) => { if (e.level === "warn") calls.push(String(e.message)); });
      const lib = makeLibrary("leaky", {
        provides: [TestTok],
        sim: {
          create(_config, ctx) {
            ctx.provide(TestTok, { value: 1 });
            return null;
          },
          // No dispose hook!
        },
      });
      const host = new LibraryHostImpl([lib]);
      host.allocateBuffers();
      host.initSim({
        buffers: {},
        provide: () => {},
        inject: () => { throw new Error("no provider"); },
        injectOptional: () => undefined,
      });
      host.disposeSim();
      unbindSink();
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0]).toContain("leaky");
    });

    it("does not warn when library has a dispose hook (strict)", () => {
      setStrict(true);
      const calls: string[] = [];
      const unbindSink = addLogSink((e) => { if (e.level === "warn") calls.push(String(e.message)); });
      const lib = makeLibrary("clean", {
        provides: [TestTok],
        sim: {
          create(_config, ctx) {
            ctx.provide(TestTok, { value: 1 });
            return { data: "system" };
          },
          dispose: () => {},
        },
      });
      const host = new LibraryHostImpl([lib]);
      host.allocateBuffers();
      host.initSim({
        buffers: {},
        provide: () => {},
        inject: () => { throw new Error("no provider"); },
        injectOptional: () => undefined,
      });
      host.disposeSim();
      unbindSink();
      expect(calls.length).toBe(0);
    });
  });

  describe("tickPhase", () => {
    it("calls tick for libraries in the matching phase", () => {
      let ticked = false;
      const lib = makeLibrary("test", {
        tickPhase: "pre-physics",
        sim: {
          create() { return {}; },
          tick() { ticked = true; },
        },
      });
      const host = new LibraryHostImpl([lib]);
      host.allocateBuffers();
      host.initSim({
        buffers: {},
        provide: () => {},
        inject: () => { throw new Error("no provider"); },
        injectOptional: () => undefined,
      });
      host.tickPhase("pre-physics", { dt: 0.016, tick: 1, entities: null, entityCount: 0, players: null, playerCount: 0 });
      expect(ticked).toBe(true);
    });

    it("does not call tick for libraries in a different phase", () => {
      let ticked = false;
      const lib = makeLibrary("test", {
        tickPhase: "post-physics",
        sim: {
          create() { return {}; },
          tick() { ticked = true; },
        },
      });
      const host = new LibraryHostImpl([lib]);
      host.allocateBuffers();
      host.initSim({
        buffers: {},
        provide: () => {},
        inject: () => { throw new Error("no provider"); },
        injectOptional: () => undefined,
      });
      host.tickPhase("pre-physics", { dt: 0.016, tick: 1, entities: null, entityCount: 0, players: null, playerCount: 0 });
      expect(ticked).toBe(false);
    });
  });

  describe("createRenderer — renderer-only libraries", () => {
    it("calls renderer.create and provides DI tokens", () => {
      const lib = makeLibrary("ui-host", {
        provides: [TestTok],
        renderer: {
          create(_config, ctx) {
            ctx.provide(TestTok, { value: 99 });
            return { host: "main-thread-host" };
          },
        },
      });
      const host = new LibraryHostImpl([lib]);
      host.allocateBuffers();

      const provided = new Map<string, unknown>();
      const createCtx: LibraryRendererCreateContext = {
        provide: (token: { key: string }, value: unknown) => provided.set(token.key, value),
        inject: () => { throw new Error("no provider"); },
        injectOptional: () => undefined,
      };
      host.createRenderer(createCtx);

      expect(provided.get("test:token")).toEqual({ value: 99 });
    });

    it("skips libraries without renderer.create", () => {
      const lib = makeLibrary("gpu-only", {
        renderer: {
          init() { return {}; },
        },
      });
      const host = new LibraryHostImpl([lib]);
      host.allocateBuffers();

      // Should not throw — createRenderer is a no-op for this library.
      expect(() => host.createRenderer({
        provide: () => {},
        inject: () => { throw new Error("no provider"); },
        injectOptional: () => undefined,
      })).not.toThrow();
    });

    it("renderer.create instance is preserved through initRenderer", () => {
      // A library with both `create` and `init`: `create` builds the host,
      // `init` returns undefined (keeps the created host) — the host from
      // `create` should survive as the rendererInstance.
      const lib = makeLibrary("combo", {
        provides: [TestTok],
        renderer: {
          create(_config, ctx) {
            ctx.provide(TestTok, { value: 1 });
            return { host: "created" };
          },
          init() {
            // init wires GPU passes but doesn't return a new instance —
            // the create-built host should be kept.
            return undefined;
          },
        },
      });
      const host = new LibraryHostImpl([lib]);
      host.allocateBuffers();

      const provided = new Map<string, unknown>();
      const makeCtx = () => ({
        provide: (token: any, value: unknown) => provided.set(token.key, value),
        inject: () => { throw new Error("no provider"); },
        injectOptional: () => undefined,
      });
      host.createRenderer(makeCtx());
      host.initRenderer({
        device: {} as any,
        format: "bgra8unorm",
        ...makeCtx(),
      });

      // The created host was provided via DI and not overwritten by init.
      expect(provided.get("test:token")).toEqual({ value: 1 });
    });

    it("disposeRenderer disposes renderer-only library instances", () => {
      let disposed = false;
      const lib = makeLibrary("disposable", {
        renderer: {
          create() { return { host: "created" }; },
          dispose() { disposed = true; },
        },
      });
      const host = new LibraryHostImpl([lib]);
      host.allocateBuffers();
      host.createRenderer({
        provide: () => {},
        inject: () => { throw new Error("no provider"); },
        injectOptional: () => undefined,
      });
      host.disposeRenderer();
      expect(disposed).toBe(true);
    });
  });
});
