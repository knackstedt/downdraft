import { describe, expect, it } from "bun:test";
import { getSeason, getDayInSeason, getSeasonProgress, getYear, isWinter, isColdSeason, SEASON_TICKS, DAY_TICKS, YEAR_TICKS } from "./season-system";

describe("season-system", () => {
  it("starts in spring at tick 0", () => {
    expect(getSeason(0)).toBe("spring");
    expect(getDayInSeason(0)).toBe(0);
    expect(getYear(0)).toBe(0);
  });

  it("advances through seasons deterministically", () => {
    expect(getSeason(0)).toBe("spring");
    expect(getSeason(SEASON_TICKS)).toBe("summer");
    expect(getSeason(SEASON_TICKS * 2)).toBe("autumn");
    expect(getSeason(SEASON_TICKS * 3)).toBe("winter");
    expect(getSeason(SEASON_TICKS * 4)).toBe("spring"); // wraps
  });

  it("isWinter true only in winter", () => {
    expect(isWinter(0)).toBe(false);
    expect(isWinter(SEASON_TICKS * 3)).toBe(true);
    expect(isWinter(SEASON_TICKS * 3 + SEASON_TICKS / 2)).toBe(true); // mid-winter
    expect(isWinter(SEASON_TICKS * 4)).toBe(false); // spring again
  });

  it("isColdSeason true for autumn + winter", () => {
    expect(isColdSeason(0)).toBe(false); // spring
    expect(isColdSeason(SEASON_TICKS * 2)).toBe(true); // autumn
    expect(isColdSeason(SEASON_TICKS * 3)).toBe(true); // winter
    expect(isColdSeason(SEASON_TICKS * 4)).toBe(false); // spring
  });

  it("day in season advances correctly", () => {
    expect(getDayInSeason(0)).toBe(0);
    expect(getDayInSeason(DAY_TICKS)).toBe(1);
    expect(getDayInSeason(DAY_TICKS * 2)).toBe(2);
    expect(getDayInSeason(DAY_TICKS * 3)).toBe(3);
    expect(getDayInSeason(DAY_TICKS * 4)).toBe(0); // next season
  });

  it("season progress is 0-1", () => {
    expect(getSeasonProgress(0)).toBe(0);
    expect(getSeasonProgress(SEASON_TICKS / 2)).toBeCloseTo(0.5);
    expect(getSeasonProgress(SEASON_TICKS - 1)).toBeCloseTo(1 - 1 / SEASON_TICKS, 5);
  });

  it("year increments after full year", () => {
    expect(getYear(0)).toBe(0);
    expect(getYear(YEAR_TICKS - 1)).toBe(0);
    expect(getYear(YEAR_TICKS)).toBe(1);
    expect(getYear(YEAR_TICKS * 2)).toBe(2);
  });
});
