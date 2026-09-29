// game-module unit tests — restore-payload selection. Regression coverage for
// the multi-component save wipe: without a componentName, a save with several
// components must forward the WHOLE components map to the sim worker (the
// worker's extractRestoreData/game restore selects its sections). Picking the
// first component (e.g. "world") silently dropped players, boats, inventory,
// and plants in to-the-ocean saves.

import { describe, expect, it } from "bun:test";
import { serializeRestorePayload } from "./game-module";

const components = {
  world: { v: 1, data: { entities: [1, 2] } },
  players: { v: 1, data: { roster: ["a"] } },
  boats: { v: 2, data: { hulls: 4 } },
};

describe("serializeRestorePayload", () => {
  it("forwards the whole map for multi-component saves without componentName", () => {
    const payload = serializeRestorePayload(components, undefined);
    expect(JSON.parse(payload!)).toEqual(components);
  });

  it("unwraps the inner data for single-component saves", () => {
    const payload = serializeRestorePayload({ world: components.world }, undefined);
    expect(JSON.parse(payload!)).toEqual({ entities: [1, 2] });
  });

  it("selects the named component when componentName is set", () => {
    const payload = serializeRestorePayload(components, "boats");
    expect(JSON.parse(payload!)).toEqual({ hulls: 4 });
  });

  it("returns undefined when the named component is missing", () => {
    expect(serializeRestorePayload(components, "nope")).toBeUndefined();
  });

  it("skips null/undefined components when counting", () => {
    const payload = serializeRestorePayload(
      { world: components.world, stale: null },
      undefined,
    );
    expect(JSON.parse(payload!)).toEqual({ entities: [1, 2] });
  });
});
