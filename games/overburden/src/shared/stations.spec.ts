// ============================================================================
// Overburden — station registry unit tests
// ============================================================================

import { describe, expect, it } from "bun:test";
import { BLOCK_CAMPFIRE, BLOCK_FURNACE, BLOCK_WORKBENCH } from "./constants";
import { getAllStations, getStationByBlock, getStationByType } from "./stations";

describe("station registry", () => {
  it("has 11 stations", () => {
    expect(getAllStations()).toHaveLength(11);
  });

  it("getStationByBlock returns the correct station for workbench", () => {
    const station = getStationByBlock(BLOCK_WORKBENCH);
    expect(station).toBeDefined();
    expect(station!.station).toBe("workbench");
    expect(station!.name).toBe("Workbench");
    expect(station!.fueled).toBe(false);
  });

  it("getStationByBlock returns the correct station for campfire (fueled)", () => {
    const station = getStationByBlock(BLOCK_CAMPFIRE);
    expect(station).toBeDefined();
    expect(station!.station).toBe("campfire");
    expect(station!.fueled).toBe(true);
    expect(station!.fuelSlots).toBe(10);
    expect(station!.acceptsFuel).toContain(1);
    expect(station!.acceptsFuel).toContain(2);
  });

  it("getStationByBlock returns the correct station for furnace (fueled)", () => {
    const station = getStationByBlock(BLOCK_FURNACE);
    expect(station).toBeDefined();
    expect(station!.station).toBe("furnace");
    expect(station!.fueled).toBe(true);
    expect(station!.acceptsFuel).toContain(5); // coal
  });

  it("getStationByType returns the correct station", () => {
    const station = getStationByType("workbench");
    expect(station).toBeDefined();
    expect(station!.blockId).toBe(BLOCK_WORKBENCH);
  });

  it("getStationByBlock returns undefined for non-station blocks", () => {
    expect(getStationByBlock(0)).toBeUndefined(); // air
    expect(getStationByBlock(1)).toBeUndefined(); // dirt
  });

  it("getStationByType returns undefined for unknown station types", () => {
    expect(getStationByType("hand" as never)).toBeUndefined();
    expect(getStationByType("nonexistent" as never)).toBeUndefined();
  });

  it("round-trip: getStationByBlock(getStationByType(s).blockId) === getStationByType(s)", () => {
    for (const station of getAllStations()) {
      const byBlock = getStationByBlock(station.blockId);
      expect(byBlock).toBe(station);
      const byType = getStationByType(station.station);
      expect(byType).toBe(station);
    }
  });
});
