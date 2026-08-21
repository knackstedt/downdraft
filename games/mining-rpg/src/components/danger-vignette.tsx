// ============================================================================
// DangerVignette — a red screen edge vignette that appears when the player's
// health is low. The intensity scales with how low the health is.
//
// This is a purely visual effect — a red gradient overlay at the screen edges
// that pulses to create a sense of danger. Hidden when health is above 30%.
// ============================================================================

import { useGameStore } from "../stores/game-store";

export function DangerVignette() {
  const { health, gameOver } = useGameStore();

  if (gameOver) return null;
  if (health > 30) return null;

  // Intensity: 0 at 30% health, 1 at 0% health
  const intensity = (30 - health) / 30;
  const opacity = 0.15 + intensity * 0.35;

  return (
    <>
      <style>{`
        @keyframes dangerVignettePulse {
          0%, 100% { opacity: ${opacity}; }
          50% { opacity: ${opacity * 0.6}; }
        }
      `}</style>
      <div
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          zIndex: 14,
          background: `radial-gradient(ellipse at center, transparent 40%, rgba(255,0,0,${opacity}) 100%)`,
          animation: "dangerVignettePulse 1s ease-in-out infinite",
        }}
      />
    </>
  );
}
