// ============================================================================
// Market System — dynamic pricing, supply/demand, price recovery
// ============================================================================

import { MarketListing, PortDef, PortSize } from "../../shared/types";
import {
  PRICE_RECOVERY_HOURS, PRICE_IMPACT_THRESHOLD,
  PRICE_MAX_MODIFIER, PRICE_MIN_MODIFIER, BARGE_INVENTORY_MULTIPLIER,
  SIM_TICK_RATE,
} from "../../shared/constants";

interface PortMarket {
  portId: string;
  listings: Map<string, MarketListing>;
  size: PortSize;
}

export class MarketSystem {
  private markets = new Map<string, PortMarket>();
  private tickCount = 0;

  initPortMarket(portId: string, size: PortSize): void {
    if (this.markets.has(portId)) return;
    this.markets.set(portId, {
      portId,
      size,
      listings: new Map(),
    });
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

  // Calculate buy price for player
  getBuyPrice(portId: string, itemId: string, baseValue: number): number {
    const listing = this.getListing(portId, itemId);
    if (!listing) return baseValue;
    return Math.ceil(baseValue * listing.priceModifier * 1.1); // 10% markup for buying
  }

  // Calculate sell price for player
  getSellPrice(portId: string, itemId: string, baseValue: number, quantity: number, isBarge: boolean): number {
    const listing = this.getListing(portId, itemId);
    if (!listing) return Math.floor(baseValue * 0.9);

    // Impact: how much this transaction moves the price
    // Small boats barely move the price; barges have more impact
    const impactMultiplier = isBarge ? 1 : 1 / BARGE_INVENTORY_MULTIPLIER;
    const supplyImpact = (quantity * impactMultiplier) / Math.max(1, listing.supply);
    const priceDrop = Math.min(0.3, supplyImpact * 0.1); // max 30% drop per transaction

    return Math.floor(baseValue * listing.priceModifier * (1 - priceDrop) * 0.9); // 10% markdown
  }

  // Execute a sale: player selling items to port
  sellToPort(portId: string, itemId: string, baseValue: number, quantity: number, isBarge: boolean): number {
    const market = this.markets.get(portId);
    if (!market) return 0;

    let listing = market.listings.get(itemId);
    if (!listing) {
      listing = {
        itemId,
        buyPrice: baseValue,
        sellPrice: Math.floor(baseValue * 0.9),
        supply: 100,
        demand: 50,
        priceModifier: 1.0,
        lastTradeTime: 0,
      };
      market.listings.set(itemId, listing);
    }

    const price = this.getSellPrice(portId, itemId, baseValue, quantity, isBarge);

    // Update supply and price modifier
    listing.supply += quantity;
    const impactMultiplier = isBarge ? 1 : 1 / BARGE_INVENTORY_MULTIPLIER;
    const supplyImpact = (quantity * impactMultiplier) / Math.max(1, listing.supply);
    listing.priceModifier = Math.max(PRICE_MIN_MODIFIER, listing.priceModifier - supplyImpact * 0.05);
    listing.lastTradeTime = this.tickCount;

    return price * quantity;
  }

  // Execute a purchase: player buying items from port
  buyFromPort(portId: string, itemId: string, baseValue: number, quantity: number): number {
    const market = this.markets.get(portId);
    if (!market) return 0;

    let listing = market.listings.get(itemId);
    if (!listing) {
      listing = {
        itemId,
        buyPrice: baseValue,
        sellPrice: Math.floor(baseValue * 0.9),
        supply: 100,
        demand: 50,
        priceModifier: 1.0,
        lastTradeTime: 0,
      };
      market.listings.set(itemId, listing);
    }

    const price = this.getBuyPrice(portId, itemId, baseValue);
    listing.supply = Math.max(0, listing.supply - quantity);
    // Buying increases price
    listing.priceModifier = Math.min(PRICE_MAX_MODIFIER, listing.priceModifier + (quantity / Math.max(1, listing.supply)) * 0.03);
    listing.lastTradeTime = this.tickCount;

    return price * quantity;
  }

  tick(dt: number): void {
    this.tickCount++;

    // Price recovery: gradually move priceModifier back toward 1.0
    const recoveryRate = 1 / (PRICE_RECOVERY_HOURS * 3600 * SIM_TICK_RATE);
    for (const market of this.markets.values()) {
      for (const listing of market.listings.values()) {
        if (listing.priceModifier < 1.0) {
          listing.priceModifier = Math.min(1.0, listing.priceModifier + recoveryRate * dt * SIM_TICK_RATE);
        } else if (listing.priceModifier > 1.0) {
          listing.priceModifier = Math.max(1.0, listing.priceModifier - recoveryRate * dt * SIM_TICK_RATE);
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
