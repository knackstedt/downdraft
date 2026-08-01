// Fishing minigame tuning parameters

export const FISHING_CAST_RANGE = 30;
export const FISHING_MINIGAME_DURATION = 30;  // seconds max
export const FISHING_TENSION_MAX = 100;
export const FISHING_TENSION_BREAK = 0;       // below this = line breaks
export const FISHING_TENSION_SLIP = 100;      // above this = fish escapes
export const FISHING_PERFECT_ZONE = 0.15;     // fraction of bar centered on 50 that's "perfect" (±7.5)
export const FISHING_REEL_POWER = 35;          // tension decrease per second when reeling
export const FISHING_FISH_PULL_MULT = 15;      // multiplier for fish pull force
export const FISHING_GOOD_ZONE_MIN = 30;       // tension above this = progress zone start
export const FISHING_GOOD_ZONE_MAX = 70;       // tension below this = progress zone end
export const FISHING_PROGRESS_RATE = 0.25;     // progress per second in good zone
export const FISHING_PERFECT_PROGRESS_RATE = 0.4; // progress per second in perfect zone
export const FISHING_PROGRESS_DECAY = 0.05;    // progress lost per second outside good zone
export const FISHING_REEL_DIR_MIN_TIME = 2;    // min seconds before reel direction changes
export const FISHING_REEL_DIR_MAX_TIME = 4;    // max seconds before reel direction changes
