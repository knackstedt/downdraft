// ============================================================================
// layout-channel.spec — tests the hot-path layout SAB channel.
//
// Verifies that the main-side writer and worker-side reader communicate
// zero-copy, that viewport metrics are fresh, that element subscription
// (track/untrack) works, and that the seqlock change detection fires.
// ============================================================================

import { describe, expect, it } from "bun:test";
import {
  allocateLayoutSab,
  LayoutReader,
  LayoutWriter,
  validateLayoutSab,
} from "../sab/layout-channel";

describe("layout-channel", () => {
  it("allocates and validates", () => {
    const sab = allocateLayoutSab();
    expect(validateLayoutSab(sab)).toBe(true);
  });

  it("viewport metrics round-trip zero-copy", () => {
    const sab = allocateLayoutSab();
    const writer = new LayoutWriter(sab);
    const reader = new LayoutReader(sab);

    writer.updateViewport(1920, 1080, 2, 0, 0);
    writer.publish();

    expect(reader.hasChanged()).toBe(true);
    expect(reader.innerWidth).toBe(1920);
    expect(reader.innerHeight).toBe(1080);
    expect(reader.devicePixelRatio).toBe(2);
    reader.ack();
    expect(reader.hasChanged()).toBe(false);
  });

  it("element subscription + layout reads", () => {
    const sab = allocateLayoutSab();
    const writer = new LayoutWriter(sab);
    const reader = new LayoutReader(sab);

    // Subscribe to handle 42.
    const slot = writer.track(42);
    expect(slot).toBeGreaterThanOrEqual(0);

    // Write layout metrics.
    writer.updateElement(42, 300, 200, 10, 20, 300, 200);
    writer.publish();

    expect(reader.getElementClientWidth(42)).toBe(300);
    expect(reader.getElementClientHeight(42)).toBe(200);
    const rect = reader.getElementRect(42);
    expect(rect).not.toBeNull();
    expect(rect!.x).toBe(10);
    expect(rect!.y).toBe(20);
    expect(rect!.width).toBe(300);
    expect(rect!.height).toBe(200);
  });

  it("untrack removes the element", () => {
    const sab = allocateLayoutSab();
    const writer = new LayoutWriter(sab);
    const reader = new LayoutReader(sab);

    writer.track(99);
    writer.updateElement(99, 100, 50, 0, 0, 100, 50);
    writer.publish();
    expect(reader.getElementClientWidth(99)).toBe(100);

    writer.untrack(99);
    writer.publish();
    expect(reader.findSlot(99)).toBe(-1);
  });

  it("untracked element returns -1 / null", () => {
    const sab = allocateLayoutSab();
    const reader = new LayoutReader(sab);
    expect(reader.getElementClientWidth(123)).toBe(-1);
    expect(reader.getElementRect(123)).toBeNull();
  });

  it("seqlock detects updates", () => {
    const sab = allocateLayoutSab();
    const writer = new LayoutWriter(sab);
    const reader = new LayoutReader(sab);

    reader.ack(); // ack initial state
    expect(reader.hasChanged()).toBe(false);

    writer.updateViewport(800, 600, 1, 0, 0);
    writer.publish();
    expect(reader.hasChanged()).toBe(true);
    reader.ack();
    expect(reader.hasChanged()).toBe(false);
  });
});
