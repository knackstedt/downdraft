// ============================================================================
// QuickJS bridge — host↔QuickJS value marshaling + interrupt/timeout.
//
// QuickJS plugins run in-process on the renderer thread inside a QuickJS WASM
// VM (via quickjs-emscripten). The VM provides hard isolation by construction:
// only the host-bridged globals exist. This module:
//   - creates a QuickJS runtime + context,
//   - sets an interrupt handler for per-tick instruction-budget enforcement,
//   - bridges the ScriptPluginContext API into QuickJS functions,
//   - marshals values between host and VM (primitives + plain objects via JSON),
//   - evaluates the plugin entry and calls its register().
// ============================================================================

import type { QuickJSContext, QuickJSWASMModule } from "quickjs-emscripten";
import { getQuickJS as _getQuickJS } from "quickjs-emscripten";
import { getWarningEngine, METRIC_TASK_LATENCY, recordTaskLatency } from "../profiling/worker-prelude";

/** Re-export getQuickJS so consumers don't need a direct dep on quickjs-emscripten. */
export const getQuickJS = _getQuickJS;

/** Maximum instructions per eval/tick before the interrupt handler fires. */
const DEFAULT_INSTRUCTION_BUDGET = 1_000_000;

export interface QuickjsBridgeOptions {
  /** Instruction budget per eval/tick. Exceeding → throws a budget error. */
  instructionBudget?: number;
  /** The plugin id (for logging + error messages). */
  pluginId: string;
}

export interface QuickjsBridge {
  /** The QuickJS context. */
  ctx: QuickJSContext;
  /** Evaluate code in the VM. Returns the result marshaled to a host value. */
  eval(code: string, filename?: string): unknown;
  /** Call a global function by name with marshaled args. */
  callGlobal(fnName: string, ...args: unknown[]): unknown;
  /** Drain pending jobs (promises). */
  drainJobs(): void;
  /** Dispose the VM (runtime + context). */
  dispose(): void;
}

/** Marshal a host value into a QuickJS handle. Caller must dispose. */
function marshalToVm(ctx: QuickJSContext, value: unknown): any {
  if (value === undefined || value === null) return ctx.undefined;
  if (typeof value === "number") return ctx.newNumber(value);
  if (typeof value === "string") return ctx.newString(value);
  if (typeof value === "boolean") return value ? ctx.true : ctx.false;
  // Objects + arrays → JSON round-trip (simple, safe, no live sharing).
  if (typeof value === "object") {
    const result = ctx.evalCode(`JSON.parse(${JSON.stringify(JSON.stringify(value))})`);
    if (result.error) {
      result.error.dispose();
      return ctx.undefined;
    }
    // unwrapResult transfers ownership — caller must dispose.
    return ctx.unwrapResult(result);
  }
  return ctx.undefined;
}

/** Marshal a QuickJS handle to a host value. Does NOT consume the handle. */
function marshalFromVm(ctx: QuickJSContext, handle: any): unknown {
  try {
    return ctx.dump(handle);
  } catch {
    return undefined;
  }
}

/**
 * Create a QuickJS bridge with a runtime + context, interrupt handler, and
 * bridged host functions. The `hostApi` object provides the actual
 * ScriptPluginContext methods; the bridge wraps them as QuickJS functions.
 */
export function createQuickjsBridge(
  module: QuickJSWASMModule,
  hostApi: {
    id: string;
    events: {
      subscribe(event: string, handler: (data: unknown) => void): () => void;
      publish(event: string, data: unknown): void;
    };
    state: {
      get(key: string): unknown;
      set(key: string, value: unknown): void;
      delete(key: string): void;
      keys(): string[];
    };
    tick: { onTick(fn: (dt: number, t: number) => void): () => void };
    log: { info(m: string): void; warn(m: string): void; error(m: string): void; debug(m: string): void };
    onDispose(fn: () => void): void;
  },
  opts: QuickjsBridgeOptions,
): QuickjsBridge {
  const runtime = module.newRuntime();
  const budget = opts.instructionBudget ?? DEFAULT_INSTRUCTION_BUDGET;
  let instructions = 0;
  runtime.setInterruptHandler(() => {
    instructions++;
    if (instructions > budget) {
      return true; // interrupt — throws "interrupted" in the VM
    }
    return false;
  });

  const ctx = runtime.newContext();

  // Track all persistent handles so we can dispose them before the context.
  const handles: any[] = [];
  const track = <T>(h: T): T => { handles.push(h); return h; };
  const unsubFns: Array<() => void> = [];
  const disposeCbs: Array<() => void> = [];

  // Bridge the host API into the VM global as `ddPlugin`.
  const ddPlugin = track(ctx.newObject());

  // ── events ──
  const events = track(ctx.newObject());
  ctx.setProp(
    events,
    "subscribe",
    track(ctx.newFunction("subscribe", (eventHandle, handlerHandle) => {
      const event = ctx.getString(eventHandle as any);
      // Dup the handler handle so it stays alive after this callback returns.
      const handlerDup = (handlerHandle as any).dup();
      handles.push(handlerDup);
      const handler = (data: unknown) => {
        try {
          const dataHandle = marshalToVm(ctx, data);
          ctx.unwrapResult(ctx.callFunction(handlerDup, ctx.undefined, dataHandle));
          dataHandle.dispose();
          runtime.executePendingJobs();
        } catch { /* swallow */ }
      };
      unsubFns.push(hostApi.events.subscribe(event, handler));
      return ctx.undefined;
    })),
  );
  ctx.setProp(
    events,
    "publish",
    track(ctx.newFunction("publish", (eventHandle, dataHandle) => {
      hostApi.events.publish(ctx.getString(eventHandle as any), marshalFromVm(ctx, dataHandle));
      return ctx.undefined;
    })),
  );
  ctx.setProp(ddPlugin, "events", events);

  // ── state ──
  const state = track(ctx.newObject());
  ctx.setProp(
    state,
    "get",
    track(ctx.newFunction("get", (keyHandle) => marshalToVm(ctx, hostApi.state.get(ctx.getString(keyHandle as any))))),
  );
  ctx.setProp(
    state,
    "set",
    track(ctx.newFunction("set", (keyHandle, valueHandle) => {
      hostApi.state.set(ctx.getString(keyHandle as any), marshalFromVm(ctx, valueHandle));
      return ctx.undefined;
    })),
  );
  ctx.setProp(
    state,
    "delete",
    track(ctx.newFunction("delete", (keyHandle) => { hostApi.state.delete(ctx.getString(keyHandle as any)); return ctx.undefined; })),
  );
  ctx.setProp(
    state,
    "keys",
    track(ctx.newFunction("keys", () => marshalToVm(ctx, hostApi.state.keys()))),
  );
  ctx.setProp(ddPlugin, "state", state);

  // ── tick ──
  const tick = track(ctx.newObject());
  ctx.setProp(
    tick,
    "onTick",
    track(ctx.newFunction("onTick", (fnHandle) => {
      const fnDup = (fnHandle as any).dup();
      handles.push(fnDup);
      const cb = (dt: number, t: number) => {
        try {
          const tickStart = performance.now();
          ctx.unwrapResult(ctx.callFunction(fnDup, ctx.undefined, ctx.newNumber(dt), ctx.newNumber(t)));
          runtime.executePendingJobs();
          const durationUs = (performance.now() - tickStart) * 1000;
          recordTaskLatency("quickjs", durationUs, "tick");
          getWarningEngine()?.checkInstant(METRIC_TASK_LATENCY, durationUs);
        } catch { /* swallow */ }
      };
      unsubFns.push(hostApi.tick.onTick(cb));
      return ctx.undefined;
    })),
  );
  ctx.setProp(ddPlugin, "tick", tick);

  // ── log ──
  const log = track(ctx.newObject());
  ctx.setProp(log, "info", track(ctx.newFunction("info", (m) => { hostApi.log.info(ctx.getString(m as any)); return ctx.undefined; })));
  ctx.setProp(log, "warn", track(ctx.newFunction("warn", (m) => { hostApi.log.warn(ctx.getString(m as any)); return ctx.undefined; })));
  ctx.setProp(log, "error", track(ctx.newFunction("error", (m) => { hostApi.log.error(ctx.getString(m as any)); return ctx.undefined; })));
  ctx.setProp(log, "debug", track(ctx.newFunction("debug", (m) => { hostApi.log.debug(ctx.getString(m as any)); return ctx.undefined; })));
  ctx.setProp(ddPlugin, "log", log);

  // ── onDispose ──
  ctx.setProp(
    ddPlugin,
    "onDispose",
    track(ctx.newFunction("onDispose", (fnHandle) => {
      const fnDup = (fnHandle as any).dup();
      handles.push(fnDup);
      // Register the dispose callback directly — the bridge calls these
      // in dispose() while the VM is still alive.
      disposeCbs.push(() => {
        try {
          ctx.unwrapResult(ctx.callFunction(fnDup, ctx.undefined));
          runtime.executePendingJobs();
        } catch { /* swallow */ }
      });
      // Also notify the host API (for external tracking).
      hostApi.onDispose(() => {});
      return ctx.undefined;
    })),
  );

  // ── id ──
  ctx.setProp(ddPlugin, "id", track(ctx.newString(hostApi.id)));

  // Expose ddPlugin as a global.
  ctx.setProp(ctx.global, "ddPlugin", ddPlugin);

  return {
    ctx,
    eval(code, filename) {
      instructions = 0;
      const evalStart = performance.now();
      const result = ctx.evalCode(code, filename);
      const durationUs = (performance.now() - evalStart) * 1000;
      recordTaskLatency("quickjs", durationUs, "eval");
      getWarningEngine()?.checkInstant(METRIC_TASK_LATENCY, durationUs);
      if (result.error) {
        const err = ctx.dump(result.error);
        result.error.dispose();
        throw new Error(`QuickJS eval error in "${opts.pluginId}": ${err}`);
      }
      const val = marshalFromVm(ctx, result.value);
      result.value.dispose();
      return val;
    },
    callGlobal(fnName, ...args) {
      instructions = 0;
      const fn = ctx.getProp(ctx.global, fnName);
      if (ctx.typeof(fn) !== "function") {
        fn.dispose();
        throw new Error(`QuickJS: global "${fnName}" is not a function`);
      }
      const argHandles = args.map((a) => marshalToVm(ctx, a));
      const callStart = performance.now();
      const result = ctx.callFunction(fn, ctx.undefined, ...argHandles);
      const durationUs = (performance.now() - callStart) * 1000;
      recordTaskLatency("quickjs", durationUs, fnName);
      getWarningEngine()?.checkInstant(METRIC_TASK_LATENCY, durationUs);
      fn.dispose();
      for (const h of argHandles) { try { h.dispose?.(); } catch { /* */ } }
      if (result.error) {
        const err = ctx.dump(result.error);
        result.error.dispose();
        throw new Error(`QuickJS call error in "${opts.pluginId}": ${err}`);
      }
      const val = marshalFromVm(ctx, result.value);
      result.value.dispose();
      return val;
    },
    drainJobs() {
      runtime.executePendingJobs();
    },
    dispose() {
      // Run dispose callbacks while the VM is still alive.
      for (const cb of disposeCbs) cb();
      disposeCbs.length = 0;
      for (const unsub of unsubFns) unsub();
      // Dispose all tracked handles before the context.
      for (const h of handles) { try { h.dispose?.(); } catch { /* */ } }
      handles.length = 0;
      ctx.dispose();
      runtime.dispose();
    },
  };
}
