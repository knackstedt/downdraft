// Market pricing and economy constants

import { SIM_TICK_RATE } from "./buffer";

export const PRICE_RECOVERY_HOURS = 3;        // game hours for price to recover
export const PRICE_RECOVERY_PER_TICK = 1 / (PRICE_RECOVERY_HOURS * 3600 * SIM_TICK_RATE);
export const PRICE_IMPACT_THRESHOLD = 0.001;  // fraction of market supply to move price 1%
export const PRICE_MAX_MODIFIER = 2.0;        // price can go up to 2x or down to 0.5x
export const PRICE_MIN_MODIFIER = 0.5;
export const BARGE_INVENTORY_MULTIPLIER = 10; // barge has 10x the inventory of normal ship
