// ============================================================================
// Market System — dynamic pricing, supply/demand, price recovery
// Reusable plugin with configurable economy parameters
// ============================================================================

import { PortSize } from "./types";
import type { MarketListing, EconomyConfig } from "./types";
import { DEFAULT_ECONOMY_CONFIG } from "./types";

interface PortMarket {
  portId: string;
  listings: Map<string, MarketListing>;
  size: PortSize;
}

export class MarketSystem {
  private markets = new Map<string, PortMarket>();
  private tickCount = 0;
  private config: EconomyConfig;

  constructor(config?: Partial<EconomyConfig>) {
    this.config = { ...DEFAULT_ECONOMY_CONFIG, ...config };
  }

  initPortMarket(portId: string, size: PortSize): void {
    if (this.markets.has(portId)) return;
    this.markets.set(portId, { portId, size, listings: new Map() });
  }

  getListing(portId: string, itemId: string): MarketListing | null {
    const market = this.markets.get(portId);
    if (!market) return null;
    return market.listings.get(itemId) ?? null;
  }

  getListings(portId: string): MarketListing[] {
    const market = this.markets.get(portId);
    if (!market) return [];
    return Array.from(market.listings.values());
  }

  getBuyPrice(portId: string, itemId: string, baseValue: number): number {
    const listing = this.getListing(portId, itemId);
    if (!listing) return baseValue;
    return Math.ceil(baseValue * listing.priceModifier * 1.1);
  }

  getSellPrice(portId: string, itemId: string, baseValue: number, quantity: number, isBarge: boolean): number {
    const listing = this.getListing(portId, itemId);
    if (!listing) return Math.floor(baseValue * 0.9);

    const impactMultiplier = isBarge ? 1 : 1 / this.config.bargeInventoryMultiplier;
    const supplyImpact = (quantity * impactMultiplier) / Math.max(1, listing.supply);
    const priceDrop = Math.min(0.3, supplyImpact * 0.1);

    return Math.floor(baseValue * listing.priceModifier * (1 - priceDrop) * 0.9);
  }

  sellToPort(portId: string, itemId: string, baseValue: number, quantity: number, isBarge: boolean): number {
    const market = this.markets.get(portId);
    if (!market) return 0;

    let listing = market.listings.get(itemId);
    if (!listing) {
      listing = {
        itemId, buyPrice: baseValue, sellPrice: Math.floor(baseValue * 0.9),
        supply: 100, demand: 50, priceModifier: 1.0, lastTradeTime: 0,
      };
      market.listings.set(itemId, listing);
    }

    const price = this.getSellPrice(portId, itemId, baseValue, quantity, isBarge);
    listing.supply += quantity;
    const impactMultiplier = isBarge ? 1 : 1 / this.config.bargeInventoryMultiplier;
    const supplyImpact = (quantity * impactMultiplier) / Math.max(1, listing.supply);
    listing.priceModifier = Math.max(this.config.priceMinModifier, listing.priceModifier - supplyImpact * 0.05);
    listing.lastTradeTime = this.tickCount;

    return price * quantity;
  }

  buyFromPort(portId: string, itemId: string, baseValue: number, quantity: number): number {
    const market = this.markets.get(portId);
    if (!market) return 0;

    let listing = market.listings.get(itemId);
    if (!listing) {
      listing = {
        itemId, buyPrice: baseValue, sellPrice: Math.floor(baseValue * 0.9),
        supply: 100, demand: 50, priceModifier: 1.0, lastTradeTime: 0,
      };
      market.listings.set(itemId, listing);
    }

    const price = this.getBuyPrice(portId, itemId, baseValue);
    listing.supply = Math.max(0, listing.supply - quantity);
    listing.priceModifier = Math.min(this.config.priceMaxModifier, listing.priceModifier + (quantity / Math.max(1, listing.supply)) * 0.03);
    listing.lastTradeTime = this.tickCount;

    return price * quantity;
  }

  tick(dt: number): void {
    this.tickCount++;
    const recoveryRate = 1 / (this.config.priceRecoveryHours * 3600 * this.config.simTickRate);
    for (const market of this.markets.values()) {
      for (const listing of market.listings.values()) {
        if (listing.priceModifier < 1.0) {
          listing.priceModifier = Math.min(1.0, listing.priceModifier + recoveryRate * dt * this.config.simTickRate);
        } else if (listing.priceModifier > 1.0) {
          listing.priceModifier = Math.max(1.0, listing.priceModifier - recoveryRate * dt * this.config.simTickRate);
        }
      }
    }
  }

  getMarketInfo(portId: string): { listingCount: number; avgModifier: number } | null {
    const market = this.markets.get(portId);
    if (!market) return null;
    const listings = Array.from(market.listings.values());
    if (listings.length === 0) return { listingCount: 0, avgModifier: 1 };
    const avg = listings.reduce((sum, l) => sum + l.priceModifier, 0) / listings.length;
    return { listingCount: listings.length, avgModifier: avg };
  }
}
