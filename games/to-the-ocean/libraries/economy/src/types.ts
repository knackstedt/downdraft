// ============================================================================
// Economy Module — Types
// ============================================================================

export enum PortSize {
  Small = 0,
  Medium = 1,
  Large = 2,
}

export interface MarketListing {
  itemId: string;
  buyPrice: number;
  sellPrice: number;
  supply: number;
  demand: number;
  priceModifier: number;
  lastTradeTime: number;
}

export interface TradeOffer {
  itemId: string;
  quantity: number;
  pricePerUnit: number;
  totalPrice: number;
  isBuying: boolean;
}

export interface EconomyConfig {
  priceRecoveryHours: number;
  priceImpactThreshold: number;
  priceMaxModifier: number;
  priceMinModifier: number;
  bargeInventoryMultiplier: number;
  simTickRate: number;
}

export const DEFAULT_ECONOMY_CONFIG: EconomyConfig = {
  priceRecoveryHours: 3,
  priceImpactThreshold: 0.001,
  priceMaxModifier: 2.0,
  priceMinModifier: 0.5,
  bargeInventoryMultiplier: 10,
  simTickRate: 60,
};
