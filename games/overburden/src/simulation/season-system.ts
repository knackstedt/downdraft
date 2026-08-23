// ============================================================================
// Overburden — season system
//
// Overburden has a day/night cycle (18000 ticks = 10 minutes at 30tps).
// A season is 4 game days (72000 ticks). The year cycles:
// spring → summer → autumn → winter → spring ...
//
// The season affects crop growth (crops only grow in their growSeasons) and
// winter can kill cold-sensitive crops. The season is derived from the tick
// count, so it's deterministic and requires no save/load.
// ============================================================================

import type { Season } from "../shared/crops";
import { TICK_RATE } from "../shared/constants";

/** Ticks per game day (18000 at 30tps = 10 minutes real time). */
export const DAY_TICKS = 18000;
/** Ticks per season (4 game days = 72000 ticks = 40 minutes real time). */
export const SEASON_TICKS = DAY_TICKS * 4;
/** Ticks per year (4 seasons = 288000 ticks = ~2.7 hours real time). */
export const YEAR_TICKS = SEASON_TICKS * 4;

const SEASONS: Season[] = ["spring", "summer", "autumn", "winter"];

/** Get the current season from the tick count. */
export function getSeason(tick: number): Season {
  const seasonIndex = Math.floor(tick / SEASON_TICKS) % 4;
  return SEASONS[seasonIndex];
}

/** Get the current day within the season (0-3). */
export function getDayInSeason(tick: number): number {
  return Math.floor((tick % SEASON_TICKS) / DAY_TICKS);
}

/** Get the progress through the current season (0-1). */
export function getSeasonProgress(tick: number): number {
  return (tick % SEASON_TICKS) / SEASON_TICKS;
}

/** Get the current year (0-indexed). */
export function getYear(tick: number): number {
  return Math.floor(tick / YEAR_TICKS);
}

/** Is it currently winter? */
export function isWinter(tick: number): boolean {
  return getSeason(tick) === "winter";
}

/** Is it currently a cold season (autumn or winter)? */
export function isColdSeason(tick: number): boolean {
  const s = getSeason(tick);
  return s === "autumn" || s === "winter";
}

/** Human-readable season info for UI display. */
export function getSeasonInfo(tick: number): {
  season: Season;
  dayInSeason: number;
  progress: number;
  year: number;
} {
  return {
    season: getSeason(tick),
    dayInSeason: getDayInSeason(tick),
    progress: getSeasonProgress(tick),
    year: getYear(tick),
  };
}
