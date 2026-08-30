import {
    writeBytesToMemory,
    type WasmPluginExports,
    type WasmPluginImports
} from "@downdraft/core";
import { readFileSync } from "fs";
import { join } from "path";

const WASM_PATH = join(import.meta.dir, "..", "custom_scorer.wasm");

describe("sandjongg-custom-scorer plugin", () => {
  async function instantiate(
    imports: WasmPluginImports,
  ): Promise<WasmPluginExports> {
    const bytes = readFileSync(WASM_PATH);
    const result = await WebAssembly.instantiate(
      bytes,
      imports as unknown as WebAssembly.Imports,
    );
    const exp = result.instance.exports as Record<string, any>;
    return {
      alloc: exp.alloc,
      register: exp.register,
      tick: exp.tick,
      dispose: exp.dispose,
      on_event: exp.on_event,
      memory: exp.memory,
    };
  }

  it("compiles + exports alloc/register/tick/dispose/on_event", async () => {
    const imports: WasmPluginImports = {
      env: {
        log_info: () => {}, log_warn: () => {}, log_error: () => {}, log_debug: () => {},
        state_get: () => 0, state_set: () => {}, state_delete: () => {},
        event_publish: () => {}, event_subscribe: () => 0, event_unsubscribe: () => {},
      },
    };
    const exp = await instantiate(imports);
    expect(typeof exp.alloc).toBe("function");
    expect(typeof exp.register).toBe("function");
    expect(typeof exp.tick).toBe("function");
    expect(typeof exp.dispose).toBe("function");
    expect(typeof exp.on_event).toBe("function");
    expect(exp.memory).toBeDefined();
  });

  it("register resets streak + on_event applies Fibonacci bonus", async () => {
    const logs: string[] = [];
    const published: Array<{ name: string; data: string }> = [];
    const state = new Map<string, unknown>();

    const imports: WasmPluginImports = {
      env: {
        log_info: (ptr, len) => { /* would read string */ },
        log_warn: () => {}, log_error: () => {}, log_debug: () => {},
        state_get: () => 0,
        state_set: (kPtr, kLen, vPtr, vLen) => {},
        state_delete: () => {},
        event_publish: (nPtr, nLen, dPtr, dLen) => {},
        event_subscribe: () => 0, event_unsubscribe: () => {},
      },
    };
    const exp = await instantiate(imports);

    // Register.
    exp.register();

    // Simulate a tile match event: write a float32 score into memory, call on_event.
    // The plugin reads f32 from data_ptr and writes the boosted score back.
    function simulateMatch(score: number): number {
      // Allocate 4 bytes for the score (f32).
      const [ptr] = writeBytesToMemory(exp, new Uint8Array(4)) ?? [0, 0];
      // Write the score as f32.
      const view = new DataView(exp.memory!.buffer, ptr, 4);
      view.setFloat32(0, score, true);
      // Call on_event.
      exp.on_event!(1, ptr, 4);
      // Read back the boosted score.
      return view.getFloat32(0, true);
    }

    // Streak 1 → fib(1) = 1x → score * 1 = 100
    expect(simulateMatch(100)).toBeCloseTo(100, 0);
    // Streak 2 → fib(2) = 2x → score * 2 = 200
    expect(simulateMatch(100)).toBeCloseTo(200, 0);
    // Streak 3 → fib(3) = 3x → score * 3 = 300
    expect(simulateMatch(100)).toBeCloseTo(300, 0);
    // Streak 4 → fib(4) = 5x → score * 5 = 500
    expect(simulateMatch(100)).toBeCloseTo(500, 0);
    // Streak 5 → fib(5) = 8x → score * 8 = 800
    expect(simulateMatch(100)).toBeCloseTo(800, 0);
    // Streak 6 → fib(6) = 13x → score * 13 = 1300
    expect(simulateMatch(100)).toBeCloseTo(1300, 0);

    // Dispose resets streak.
    exp.dispose();
    // After dispose, streak should be 0, so next match → fib(1) = 1x
    expect(simulateMatch(100)).toBeCloseTo(100, 0);
  });
});
