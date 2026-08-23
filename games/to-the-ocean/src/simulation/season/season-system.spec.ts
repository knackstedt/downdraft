import { describe, expect, it } from "bun:test";
import { SEASON_LENGTH_DAYS, SeasonSystem } from "./season-system";

describe("SeasonSystem", () => {
  it("starts in spring at day 0", () => {
    const s = new SeasonSystem({ dayDurationSeconds: 100 });
    s.tick(0);
    expect(s.getSeason()).toBe("spring");
    expect(s.getDay()).toBe(0);
  });

  it("advances through seasons deterministically", () => {
    const s = new SeasonSystem({ dayDurationSeconds: 100 });
    const D = 100;
    s.tick(D * SEASON_LENGTH_DAYS * 0.5); // mid-spring
    expect(s.getSeason()).toBe("spring");
    s.tick(D * SEASON_LENGTH_DAYS * 1); // start of summer
    expect(s.getSeason()).toBe("summer");
    s.tick(D * SEASON_LENGTH_DAYS * 2); // autumn
    expect(s.getSeason()).toBe("autumn");
    s.tick(D * SEASON_LENGTH_DAYS * 3); // winter
    expect(s.getSeason()).toBe("winter");
    s.tick(D * SEASON_LENGTH_DAYS * 4); // back to spring
    expect(s.getSeason()).toBe("spring");
  });

  it("isColdSeason true for autumn/winter", () => {
    const s = new SeasonSystem({ dayDurationSeconds: 100 });
    const D = 100;
    // Tick to mid-winter (3.5 seasons in)
    s.tick(D * SEASON_LENGTH_DAYS * 3.5);
    expect(s.getSeason()).toBe("winter");
    expect(s.isColdSeason()).toBe(true);
    // Tick to mid-spring of next year
    s.tick(D * SEASON_LENGTH_DAYS * 4.5);
    expect(s.getSeason()).toBe("spring");
    expect(s.isColdSeason()).toBe(false);
  });

  it("sheltered plants never take cold/heat stress", () => {
    const s = new SeasonSystem({ dayDurationSeconds: 100 });
    s.tick(100 * SEASON_LENGTH_DAYS * 3); // winter
    expect(s.getColdStress(0, true, true)).toBe(0);
    expect(s.getHeatStress(0, true, true)).toBe(0);
  });

  it("cold-sensitive tropical crop takes winter stress in cold biome", () => {
    const s = new SeasonSystem({ dayDurationSeconds: 100 });
    s.tick(100 * SEASON_LENGTH_DAYS * 3); // winter
    const stress = s.getColdStress(0.2, true, false);
    expect(stress).toBeGreaterThan(0);
  });

  it("cold-tolerant crop in preferred season takes no stress", () => {
    const s = new SeasonSystem({ dayDurationSeconds: 100 });
    s.tick(0); // spring
    const stress = s.getColdStress(0.8, false, false);
    expect(stress).toBe(0);
  });

  it("setDays round-trips", () => {
    const s = new SeasonSystem();
    s.setDays(12.5);
    expect(s.getDay()).toBe(12.5);
  });
});
