import { describe, expect, it } from "bun:test";
import { applyEditCommand, generateDesignId } from "./schema";
import { BoatClass, BoatDesign, SymmetryMode } from "./types";

function makeDesign(): BoatDesign {
  const id = generateDesignId("Test Boat", 1000);
  return {
    metadata: {
      id,
      schemaVersion: "1.0.0",
      name: "Test Boat",
      description: "A test boat",
      class: BoatClass.Custom,
      createdAt: 1000,
      updatedAt: 1000,
    },
    hullBodies: [],
    decks: [],
    hardpoints: [],
    modules: [],
    symmetry: SymmetryMode.None,
  };
}

describe("applyEditCommand validation", () => {
  it("rejects null command and returns unchanged clone", () => {
    const design = makeDesign();
    const result = applyEditCommand(design, null);
    expect(result.metadata.name).toBe("Test Boat");
    expect(result.hullBodies.length).toBe(0);
  });

  it("rejects non-object command and returns unchanged clone", () => {
    const design = makeDesign();
    const result = applyEditCommand(design, "not an object");
    expect(result.metadata.name).toBe("Test Boat");
  });

  it("rejects command with invalid type field", () => {
    const design = makeDesign();
    const result = applyEditCommand(design, { type: "invalid_command" });
    expect(result.metadata.name).toBe("Test Boat");
    expect(result.hullBodies.length).toBe(0);
  });

  it("rejects command missing type field", () => {
    const design = makeDesign();
    const result = applyEditCommand(design, { name: "bad" });
    expect(result.metadata.name).toBe("Test Boat");
  });

  it("accepts valid rename command", () => {
    const design = makeDesign();
    const result = applyEditCommand(design, { type: "rename", name: "New Name" });
    expect(result.metadata.name).toBe("New Name");
  });

  it("returns a clone, not the same object reference", () => {
    const design = makeDesign();
    const result = applyEditCommand(design, null);
    expect(result).not.toBe(design);
  });
});
