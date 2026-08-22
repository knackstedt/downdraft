// ============================================================================
// AchievementNotification — toast popup that appears when an achievement is
// unlocked. Shows the achievement icon, name, and description for 5 seconds,
// then fades out. Multiple unlocks stack vertically (only the most recent is
// shown via the store's recentAchievement field; the next one appears after
// the current toast is cleared).
// ============================================================================

import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import { gameStore, actions } from "../stores/game-store";
import type { JSX } from "solid-js";

const TOAST_DURATION_MS = 5000;
const FADE_DURATION_MS = 500;

const containerStyle: JSX.CSSProperties = {
  position: "absolute",
  top: "20px",
  right: "20px",
  "z-index": "30",
  "pointer-events": "none",
  display: "flex",
  "flex-direction": "column",
  gap: "8px",
};

const toastStyle = (opacity: number): JSX.CSSProperties => ({
  display: "flex",
  "align-items": "center",
  gap: "12px",
  padding: "12px 20px",
  background: "linear-gradient(135deg, rgba(20,20,30,0.95), rgba(30,30,45,0.95))",
  border: "2px solid #ffd700",
  "border-radius": "8px",
  "font-family": "monospace",
  color: "#fff",
  "min-width": "280px",
  "max-width": "400px",
  opacity,
  transition: `opacity ${FADE_DURATION_MS}ms ease-out`,
  "box-shadow": "0 4px 20px rgba(255,215,0,0.3)",
});

const iconStyle: JSX.CSSProperties = {
  "font-size": "32px",
  "flex-shrink": "0",
};

const contentStyle: JSX.CSSProperties = {
  display: "flex",
  "flex-direction": "column",
  gap: "2px",
};

const labelStyle: JSX.CSSProperties = {
  "font-size": "10px",
  color: "#ffd700",
  "text-transform": "uppercase",
  "letter-spacing": "2px",
  "font-weight": "bold",
};

const nameStyle: JSX.CSSProperties = {
  "font-size": "15px",
  "font-weight": "bold",
  color: "#fff",
};

const descStyle: JSX.CSSProperties = {
  "font-size": "12px",
  color: "rgba(255,255,255,0.7)",
};

export function AchievementNotification() {
  const [visible, setVisible] = createSignal(false);
  const [opacity, setOpacity] = createSignal(0);

  createEffect(() => {
    const recent = gameStore.recentAchievement;
    if (!recent) return;
    // Slide in
    setVisible(true);
    setOpacity(1);

    // After TOAST_DURATION_MS - FADE_DURATION_MS, start fading out
    const fadeTimer = setTimeout(() => {
      setOpacity(0);
    }, TOAST_DURATION_MS - FADE_DURATION_MS);

    // After TOAST_DURATION_MS, clear the achievement and hide
    const clearTimer = setTimeout(() => {
      actions.clearRecentAchievement();
      setVisible(false);
    }, TOAST_DURATION_MS);

    onCleanup(() => {
      clearTimeout(fadeTimer);
      clearTimeout(clearTimer);
    });
  });

  return (
    <Show when={visible() && gameStore.recentAchievement}>
      <div style={containerStyle}>
        <div style={toastStyle(opacity())}>
          <span style={iconStyle}>{gameStore.recentAchievement!.icon}</span>
          <div style={contentStyle}>
            <span style={labelStyle}>Achievement Unlocked!</span>
            <span style={nameStyle}>{gameStore.recentAchievement!.name}</span>
            <span style={descStyle}>{gameStore.recentAchievement!.description}</span>
          </div>
        </div>
      </div>
    </Show>
  );
}
