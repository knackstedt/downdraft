// ============================================================================
// Player constants shared across sim + renderer threads.
// The default player model id is here (not in the renderer-only player-models
// registry) so the sim worker can read it without importing DOM/glob modules.
// ============================================================================

/** Default player model id used when no save or selection exists. */
export const DEFAULT_PLAYER_MODEL = "aisha";
