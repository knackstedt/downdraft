// ============================================================================
// WelcomeBack — shows a brief notification when loading a save.
//
// Displays the player's progress (depth, gold, play time, deaths) for 5
// seconds, then fades out. This gives players context when returning to
// the game.
// ============================================================================

import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import { actions, gameStore } from "../stores/game-store";

export function WelcomeBack() {
  const [visible, setVisible] = createSignal(false);

  createEffect(() => {
    const msg = gameStore.welcomeBack;
    if (msg) {
      setVisible(true);
      const timer = setTimeout(() => {
        setVisible(false);
        setTimeout(() => actions.setWelcomeBack(null), 500);
      }, 5000);
      onCleanup(() => clearTimeout(timer));
    }
  });

  return (
    <Show when={gameStore.welcomeBack}>
      <div
        style={{
          position: "absolute",
          top: "40%",
          left: "50%",
          transform: `translate(-50%, -50%) scale(${visible() ? 1 : 0.8})`,
          opacity: visible() ? 1 : 0,
          transition: "opacity 0.5s, transform 0.5s",
          padding: "16px 32px",
          background: "rgba(0,0,0,0.8)",
          border: "1px solid rgba(255,215,0,0.4)",
          "border-radius": "8px",
          "font-family": "monospace",
          color: "#ffd700",
          "font-size": "14px",
          "text-align": "center",
          "pointer-events": "none",
          "z-index": "20",
          "white-space": "nowrap",
          "box-shadow": "0 0 20px rgba(255,215,0,0.2)",
        }}
      >
        <div style={{ "font-size": "18px", "font-weight": "bold", "margin-bottom": "8px", color: "#fff" }}>
          Welcome Back!
        </div>
        <div style={{ "font-size": "12px", color: "rgba(255,255,255,0.7)" }}>
          {gameStore.welcomeBack}
        </div>
      </div>
    </Show>
  );
}
