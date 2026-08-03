import { TransientStateRegistry } from "./transient-state-registry.ts";

describe("TransientStateRegistry", () => {
  it("should strip transient flags from serialized state arrays", () => {
    const registry = new TransientStateRegistry();
    const PILOTING = 1 << 0;
    const CLIMBING = 1 << 1;
    const ONBOARD = 1 << 2;
    const HEALTHY = 1 << 3;
    registry.registerTransientFlags("players", PILOTING | CLIMBING | ONBOARD);

    const state = {
      players: [
        { flags: PILOTING | HEALTHY, name: "alice" },
        { flags: CLIMBING | ONBOARD | HEALTHY, name: "bob" },
        { flags: HEALTHY, name: "carol" },
      ],
    };

    registry.stripTransientFlags(state as Record<string, unknown>);

    expect((state.players[0] as any).flags).toBe(HEALTHY);
    expect((state.players[1] as any).flags).toBe(HEALTHY);
    expect((state.players[2] as any).flags).toBe(HEALTHY);
  });

  it("should not affect categories that are not registered", () => {
    const registry = new TransientStateRegistry();
    registry.registerTransientFlags("players", 0xFF);

    const state = {
      players: [{ flags: 0xFF }],
      entities: [{ flags: 0xFF }],
    };

    registry.stripTransientFlags(state as Record<string, unknown>);

    expect((state.players[0] as any).flags).toBe(0);
    expect((state.entities[0] as any).flags).toBe(0xFF);
  });

  it("should handle missing category gracefully", () => {
    const registry = new TransientStateRegistry();
    registry.registerTransientFlags("nonexistent", 0xFF);

    const state = { players: [{ flags: 0xFF }] };
    expect(() => registry.stripTransientFlags(state as Record<string, unknown>)).not.toThrow();
  });

  it("should handle items without flags property", () => {
    const registry = new TransientStateRegistry();
    registry.registerTransientFlags("players", 0xFF);

    const state = { players: [{ name: "alice" }, { flags: 0xFF }] };
    expect(() => registry.stripTransientFlags(state as Record<string, unknown>)).not.toThrow();
    expect((state.players[1] as any).flags).toBe(0);
  });

  it("should call all reset callbacks", () => {
    const registry = new TransientStateRegistry();
    let called1 = false;
    let called2 = false;
    registry.registerResetCallback(() => { called1 = true; });
    registry.registerResetCallback(() => { called2 = true; });

    registry.resetAll();

    expect(called1).toBe(true);
    expect(called2).toBe(true);
  });

  it("should isolate reset callback errors", () => {
    const registry = new TransientStateRegistry();
    let calledAfterThrow = false;
    registry.registerResetCallback(() => { throw new Error("boom"); });
    registry.registerResetCallback(() => { calledAfterThrow = true; });

    registry.resetAll();

    expect(calledAfterThrow).toBe(true);
  });

  it("should clear all registrations", () => {
    const registry = new TransientStateRegistry();
    registry.registerTransientFlags("players", 0xFF);
    registry.registerResetCallback(() => {});
    registry.registerResetCallback(() => {});

    registry.clear();

    expect(registry.getTransientFlagCount()).toBe(0);
    expect(registry.getResetCallbackCount()).toBe(0);
  });

  it("defense in depth: reset callbacks run even if no flags registered", () => {
    const registry = new TransientStateRegistry();
    let resetCalled = false;
    registry.registerResetCallback(() => { resetCalled = true; });

    const state = { players: [{ flags: 0xFF }] };
    registry.stripTransientFlags(state as Record<string, unknown>);
    registry.resetAll();

    expect(resetCalled).toBe(true);
    expect((state.players[0] as any).flags).toBe(0xFF);
  });
});
