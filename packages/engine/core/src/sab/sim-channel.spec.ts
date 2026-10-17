import { describe, expect, it } from "bun:test";
import { SIM_HDR, SimBufferReader, SimBufferWriter, allocateSimBuffer } from "./sim-channel";

/** The sequence word (SIM_HDR.SEQUENCE = u32 index 2) as a standalone view. */
function seqView(sab: SharedArrayBuffer): Int32Array {
  return new Int32Array(sab, SIM_HDR.SEQUENCE * 4, 1);
}

describe("SimBufferWriter — publish seqlock", () => {
  it("covers prev-sync writes with the write window even on a tick with no mutations", () => {
    const sab = allocateSimBuffer();
    const writer = new SimBufferWriter(sab);
    writer.init();
    writer.setEntityCount(2);
    // Commit the init writes so the sequence is stable/even before the probe.
    writer.incrementTick();

    const seq = seqView(sab);
    const parities: number[] = [];
    const w = writer as unknown as {
      entityPrevSlots: { slot(i: number): { f32: Float32Array } };
      playerPrevSlots: { slot(i: number): { f32: Float32Array } };
    };
    const origSlot = w.entityPrevSlots.slot.bind(w.entityPrevSlots);
    w.entityPrevSlots.slot = (i: number) => {
      parities.push(Atomics.load(seq, 0) & 1);
      return origSlot(i);
    };

    // Idle tick — no entity writes opened the window; incrementTick must open
    // it itself so readers can't observe the prev copy mid-publish.
    writer.incrementTick();

    expect(parities.length).toBe(2); // one prev-slot write per entity
    expect(parities.every((p) => p === 1)).toBe(true);
    expect(Atomics.load(seq, 0) & 1).toBe(0); // window closed after commit
  });

  it("prev slots mirror cur for untouched entities (identity lerp)", () => {
    const sab = allocateSimBuffer();
    const writer = new SimBufferWriter(sab);
    writer.init();
    writer.setEntityCount(1);
    const cur = writer.getEntityF32(0);
    cur[0] = 10; cur[1] = 20; cur[2] = 30; cur[3] = 2;
    cur[4] = 0; cur[5] = 0; cur[6] = 0; cur[7] = 1;
    writer.incrementTick();

    const reader = new SimBufferReader(sab);
    const prev = reader.getEntityPrevSlot(0).f32;
    // First publish after a write: prev = the pre-write value (state t-1),
    // so the renderer lerps from it into the new cur.
    expect(prev[0]).toBe(0);

    // Next tick with no writes: prev re-copies cur — the entity is now
    // stationary, so prev converges to cur for the identity lerp.
    writer.incrementTick();
    expect(prev[0]).toBe(10);
    expect(prev[7]).toBe(1);
  });

  it("written entities keep their pre-write transform as prev", () => {
    const sab = allocateSimBuffer();
    const writer = new SimBufferWriter(sab);
    writer.init();
    writer.setEntityCount(1);

    const cur = writer.getEntityF32(0);
    cur[0] = 1;
    writer.incrementTick();

    // Mutate then commit — prev should hold the transform from the last
    // committed publish (1), not the new value (5).
    const cur2 = writer.getEntityF32(0);
    cur2[0] = 5;
    writer.incrementTick();

    const reader = new SimBufferReader(sab);
    expect(reader.getEntityPrevSlot(0).f32[0]).toBe(1);
    expect(reader.getEntitySlot(0).f32[0]).toBe(5);
  });
});
