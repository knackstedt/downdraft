// ============================================================================
// Market System — re-exports from @downdraft/plugin-economy
// ============================================================================
// The game's constants are passed as EconomyConfig to the plugin's MarketSystem.
//

import { DEFAULT_ECONOMY_CONFIG, MarketSystem as PluginMarketSystem, type EconomyConfig } from "@downdraft/plugin-economy";
import { BARGE_INVENTORY_MULTIPLIER, PRICE_MAX_MODIFIER, PRICE_MIN_MODIFIER, PRICE_RECOVERY_HOURS, SIM_TICK_RATE } from "../../shared/constants";

export type { MarketListing } from "@downdraft/plugin-economy";

const GAME_ECONOMY_CONFIG: EconomyConfig = {
  ...DEFAULT_ECONOMY_CONFIG,
  priceRecoveryHours: PRICE_RECOVERY_HOURS,
  priceMaxModifier: PRICE_MAX_MODIFIER,
  priceMinModifier: PRICE_MIN_MODIFIER,
  bargeInventoryMultiplier: BARGE_INVENTORY_MULTIPLIER,
  simTickRate: SIM_TICK_RATE,
};

export class MarketSystem extends PluginMarketSystem {
  constructor() {
    super(GAME_ECONOMY_CONFIG);
  }
}
