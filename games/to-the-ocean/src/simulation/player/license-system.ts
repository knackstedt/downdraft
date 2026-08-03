// ============================================================================
// License System — player-specific licenses for small craft operation
// ============================================================================

import { SmallCraftType } from "../../shared/types";

export class LicenseSystem {
  private playerLicenses = new Map<number, Set<SmallCraftType>>();

  // Grant a license to a player
  grantLicense(playerId: number, type: SmallCraftType): boolean {
    if (!this.playerLicenses.has(playerId)) {
      this.playerLicenses.set(playerId, new Set());
    }
    const licenses = this.playerLicenses.get(playerId)!;
    if (licenses.has(type)) return false;
    licenses.add(type);
    return true;
  }

  // Revoke a license
  revokeLicense(playerId: number, type: SmallCraftType): boolean {
    return this.playerLicenses.get(playerId)?.delete(type) ?? false;
  }

  // Check if player has a license
  hasLicense(playerId: number, type: SmallCraftType): boolean {
    // Rowboats don't need a license
    if (type === SmallCraftType.Rowboat) return true;
    return this.playerLicenses.get(playerId)?.has(type) ?? false;
  }

  // Get all licenses for a player
  getLicenses(playerId: number): SmallCraftType[] {
    return Array.from(this.playerLicenses.get(playerId) ?? []);
  }

  // Check if player can operate a craft type
  canOperate(playerId: number, type: SmallCraftType): boolean {
    return this.hasLicense(playerId, type);
  }

  // Check if player can buy a craft (always true — they just can't operate without license)
  canBuy(_playerId: number, _type: SmallCraftType): boolean {
    return true; // anyone can buy, but not operate without license
  }
}
