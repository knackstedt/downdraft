// ============================================================================
// WelcomeBack — shows a brief notification when loading a save.
//
// Displays the player's progress (depth, gold, play time, deaths) for 5
// seconds, then fades out. This gives players context when returning to
// the game.
// ============================================================================

import { useEffect, useState } from "react";
import { useGameStore } from "../stores/game-store";

export function WelcomeBack() {
  const { welcomeBack, setWelcomeBack } = useGameStore();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (welcomeBack) {
      setVisible(true);
      const timer = setTimeout(() => {
        setVisible(false);
        setTimeout(() => setWelcomeBack(null), 500);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [welcomeBack, setWelcomeBack]);

  if (!welcomeBack) return null;

  return (
    <div
      style={{
        position: "absolute",
        top: "40%",
        left: "50%",
        transform: `translate(-50%, -50%) scale(${visible ? 1 : 0.8})`,
        opacity: visible ? 1 : 0,
        transition: "opacity 0.5s, transform 0.5s",
        padding: "16px 32px",
        background: "rgba(0,0,0,0.8)",
        border: "1px solid rgba(255,215,0,0.4)",
        borderRadius: 8,
        fontFamily: "monospace",
        color: "#ffd700",
        fontSize: 14,
        textAlign: "center",
        pointerEvents: "none",
        zIndex: 20,
        whiteSpace: "nowrap",
        boxShadow: "0 0 20px rgba(255,215,0,0.2)",
      }}
    >
      <div style={{ fontSize: 18, fontWeight: "bold", marginBottom: 8, color: "#fff" }}>
        Welcome Back!
      </div>
      <div style={{ fontSize: 12, color: "rgba(255,255,255,0.7)" }}>
        {welcomeBack}
      </div>
    </div>
  );
}
