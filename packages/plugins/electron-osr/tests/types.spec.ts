// ============================================================================
// OSR Types Tests — Validate type definitions and BillboardMode enum
// ============================================================================

import { describe, it, expect } from "bun:test";
import { BillboardMode } from "../src/types.ts";

describe("OSR Types", () => {
  describe("BillboardMode", () => {
    it("should have correct enum values", () => {
      expect(BillboardMode.ScreenAligned).toBe(0);
      expect(BillboardMode.AxisAligned).toBe(1);
      expect(BillboardMode.Fixed).toBe(2);
    });
  });
});
