// ============================================================================
// Game Mode Manager — creative, survival, hardcore, custom
// ============================================================================

import { GameMode, GameRules } from "../../shared/types";
import { DEFAULT_GAME_RULES, GAMEMODE_RULES } from "../../shared/constants";

export class GameModeManager {
  private gamemode: GameMode;
  rules: Record<string, number | boolean>;

  constructor(gamemode: GameMode, rules: Record<string, number | boolean>) {
    this.gamemode = gamemode;
    this.rules = { ...DEFAULT_GAME_RULES, ...GAMEMODE_RULES[gamemode], ...rules };
  }

  setGamemode(mode: GameMode): void {
    this.gamemode = mode;
    // Apply gamemode-specific rule overrides
    const modeRules = GAMEMODE_RULES[mode] ?? {};
    this.rules = { ...DEFAULT_GAME_RULES, ...modeRules, ...this.getCustomOverrides() };
  }

  updateRules(rules: Record<string, number | boolean>): void {
    this.rules = { ...this.rules, ...rules };
  }

  getGamemode(): GameMode {
    return this.gamemode;
  }

  isCreative(): boolean {
    return this.gamemode === GameMode.Creative;
  }

  isHardcore(): boolean {
    return this.gamemode === GameMode.Hardcore;
  }

  isCustom(): boolean {
    return this.gamemode === GameMode.Custom;
  }

  // In hardcore mode, death = camera only, no respawn
  canRespawn(): boolean {
    return this.gamemode !== GameMode.Hardcore;
  }

  // In creative mode, unlimited resources
  hasUnlimitedResources(): boolean {
    return this.gamemode === GameMode.Creative;
  }

  private getCustomOverrides(): Record<string, number | boolean> {
    if (this.gamemode !== GameMode.Custom) return {};
    // Custom mode uses whatever rules were set
    return {};
  }
}
