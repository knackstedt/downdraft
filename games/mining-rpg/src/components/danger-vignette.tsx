// ============================================================================
// DangerVignette — screen edge vignettes that appear when the player is in
// danger. Red vignette for low health, blue vignette for low oxygen.
//
// The intensity scales with how low the stat is. Both can be active at the
// same time (blended). Hidden when stats are above threshold.
// ============================================================================

import { OXYGEN_MAX_TICKS } from "../shared/constants";
import { useGameStore } from "../stores/game-store";

export function DangerVignette() {
  const { health, oxygen, gameOver } = useGameStore();

  if (gameOver) return null;

  const lowHealth = health <= 30;
  const lowOxygen = oxygen < OXYGEN_MAX_TICKS && oxygen < OXYGEN_MAX_TICKS * 0.3;

  if (!lowHealth && !lowOxygen) return null;

  // Intensity: 0 at threshold, 1 at 0
  const healthIntensity = lowHealth ? (30 - health) / 30 : 0;
  const oxygenIntensity = lowOxygen ? 1 - oxygen / (OXYGEN_MAX_TICKS * 0.3) : 0;

  const redOpacity = 0.15 + healthIntensity * 0.35;
  const blueOpacity = 0.1 + oxygenIntensity * 0.3;

  // Blend both vignettes
  const redPart = lowHealth ? `rgba(255,0,0,${redOpacity})` : "transparent";
  const bluePart = lowOxygen ? `rgba(0,100,255,${blueOpacity})` : "transparent";

  return (
    <>
      <style>{`
        @keyframes dangerVignettePulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }
      `}</style>
      {lowHealth && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            zIndex: 14,
            background: `radial-gradient(ellipse at center, transparent 40%, ${redPart} 100%)`,
            animation: "dangerVignettePulse 1s ease-in-out infinite",
          }}
        />
      )}
      {lowOxygen && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            zIndex: 14,
            background: `radial-gradient(ellipse at center, transparent 50%, ${bluePart} 100%)`,
            animation: "dangerVignettePulse 0.8s ease-in-out infinite",
          }}
        />
      )}
    </>
  );
}
