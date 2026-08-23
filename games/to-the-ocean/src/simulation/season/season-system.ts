// ============================================================================
// Season System — drives a 4-season cycle from elapsed game days
// ============================================================================
// A "year" is SEASON_LENGTH_DAYS * 4 game days. Each season modifies the
// effective ambient temperature for a biome and determines whether crops are
// in their preferred growing season. Plants use isColdSeason()/getTempStress()
// to decide whether an unsheltered crop takes damage (see PlantSystem).
//
// The system is deterministic from simTime (no internal random state) so it
// round-trips through save/load by persisting only `simTime` (already saved).
// `dayDuration` must match the rule used by the day/night cycle so that one
// game day advances the season counter at the same rate as timeOfDay wraps.

export type Season = "spring" | "summer" | "autumn" | "winter";

export const SEASON_ORDER: Season[] = ["spring", "summer", "autumn", "winter"];

/** Game days per season. 7 => a full year is 28 game days. */
export const SEASON_LENGTH_DAYS = 7;

export interface SeasonConfig {
  /** Game days per season. */
  seasonLengthDays: number;
  /** Real seconds per game day (must match DAY_DURATION_SECONDS / dayDuration rule). */
  dayDurationSeconds: number;
  /** Temperature offset (degrees) applied per season on top of biome base. */
  seasonTempOffset: Record<Season, number>;
}

export const DEFAULT_SEASON_CONFIG: SeasonConfig = {
  seasonLengthDays: SEASON_LENGTH_DAYS,
  dayDurationSeconds: 1200,
  seasonTempOffset: {
    spring: 0,
    summer: 8,
    autumn: -2,
    winter: -15,
  },
};

export class SeasonSystem {
  private config: SeasonConfig;
  /** Total elapsed game days (fractional). */
  private days = 0;

  constructor(config: Partial<SeasonConfig> = {}) {
    this.config = { ...DEFAULT_SEASON_CONFIG, ...config };
  }

  /** Advance the season clock. `simTime` is total elapsed sim seconds. */
  tick(simTime: number): void {
    this.days = simTime / this.config.dayDurationSeconds;
  }

  getDay(): number {
    return this.days;
  }

  /** Current day-of-season (1..seasonLengthDays). */
  getDayOfSeason(): number {
    const len = this.config.seasonLengthDays;
    return (Math.floor(this.days) % len) + 1;
  }

  getSeason(): Season {
    const idx = Math.floor(this.days / this.config.seasonLengthDays) % 4;
    return SEASON_ORDER[idx < 0 ? idx + 4 : idx];
  }

  getSeasonIndex(): number {
    const idx = Math.floor(this.days / this.config.seasonLengthDays) % 4;
    return idx < 0 ? idx + 4 : idx;
  }

  /** Progress through the current season, 0..1. */
  getSeasonProgress(): number {
    const len = this.config.seasonLengthDays;
    return (this.days % len) / len;
  }

  isColdSeason(): boolean {
    const s = this.getSeason();
    return s === "winter" || s === "autumn";
  }

  isHotSeason(): boolean {
    return this.getSeason() === "summer";
  }

  /** Seasonal temperature delta (degrees) to add to a biome's ambient temp. */
  getSeasonTempOffset(): number {
    return this.config.seasonTempOffset[this.getSeason()];
  }

  /**
   * Crop stress from cold, in 0..1 rate-per-second.
   * Returns 0 when the crop is comfortable. Higher = faster damage.
   * `coldTolerance` is the crop's 0..1 resistance (1 = immune to cold).
   * `biomeIsCold` and `sheltered` modify the result: a sheltered plant never
   * takes cold stress (greenhouse effect).
   */
  getColdStress(coldTolerance: number, biomeIsCold: boolean, sheltered: boolean): number {
    if (sheltered) return 0;
    const season = this.getSeason();
    let coldIntensity = 0;
    if (season === "winter") coldIntensity = 1.0;
    else if (season === "autumn") coldIntensity = 0.4;
    else if (season === "spring") coldIntensity = 0.15;
    if (biomeIsCold) coldIntensity += 0.5;
    // tolerance reduces effective cold; clamp.
    const effective = Math.max(0, coldIntensity - coldTolerance);
    return effective * 0.02; // up to ~0.03/s stress → dies in ~30s of harsh winter
  }

  /** Crop stress from heat, in 0..1 rate-per-second (mirrors cold). */
  getHeatStress(heatTolerance: number, biomeIsHot: boolean, sheltered: boolean): number {
    if (sheltered) return 0;
    const season = this.getSeason();
    let heatIntensity = 0;
    if (season === "summer") heatIntensity = 0.6;
    if (biomeIsHot) heatIntensity += 0.6;
    const effective = Math.max(0, heatIntensity - heatTolerance);
    return effective * 0.02;
  }

  /** Set the day duration (called when the dayDuration rule changes). */
  setDayDuration(seconds: number): void {
    this.config.dayDurationSeconds = seconds;
  }

  /** For save/load: set absolute elapsed days directly. */
  setDays(days: number): void {
    this.days = days;
  }
}
