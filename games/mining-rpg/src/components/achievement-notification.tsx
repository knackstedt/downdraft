// ============================================================================
// AchievementNotification — toast popup that appears when an achievement is
// unlocked. Shows the achievement icon, name, and description for 5 seconds,
// then fades out. Multiple unlocks stack vertically (only the most recent is
// shown via the store's recentAchievement field; the next one appears after
// the current toast is cleared).
// ============================================================================

import { useEffect, useState } from "react";
import { useGameStore } from "../stores/game-store";

const TOAST_DURATION_MS = 5000;
const FADE_DURATION_MS = 500;

const containerStyle: React.CSSProperties = {
  position: "absolute",
  top: 20,
  right: 20,
  zIndex: 30,
  pointerEvents: "none",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const toastStyle = (opacity: number): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "12px 20px",
  background: "linear-gradient(135deg, rgba(20,20,30,0.95), rgba(30,30,45,0.95))",
  border: "2px solid #ffd700",
  borderRadius: 8,
  fontFamily: "monospace",
  color: "#fff",
  minWidth: 280,
  maxWidth: 400,
  opacity,
  transition: `opacity ${FADE_DURATION_MS}ms ease-out`,
  boxShadow: "0 4px 20px rgba(255,215,0,0.3)",
});

const iconStyle: React.CSSProperties = {
  fontSize: 32,
  flexShrink: 0,
};

const contentStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const labelStyle: React.CSSProperties = {
  fontSize: 10,
  color: "#ffd700",
  textTransform: "uppercase",
  letterSpacing: 2,
  fontWeight: "bold",
};

const nameStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: "bold",
  color: "#fff",
};

const descStyle: React.CSSProperties = {
  fontSize: 12,
  color: "rgba(255,255,255,0.7)",
};

export function AchievementNotification() {
  const { recentAchievement, clearRecentAchievement } = useGameStore();
  const [visible, setVisible] = useState(false);
  const [opacity, setOpacity] = useState(0);

  useEffect(() => {
    if (!recentAchievement) return;
    // Slide in
    setVisible(true);
    setOpacity(1);

    // After TOAST_DURATION_MS - FADE_DURATION_MS, start fading out
    const fadeTimer = setTimeout(() => {
      setOpacity(0);
    }, TOAST_DURATION_MS - FADE_DURATION_MS);

    // After TOAST_DURATION_MS, clear the achievement and hide
    const clearTimer = setTimeout(() => {
      clearRecentAchievement();
      setVisible(false);
    }, TOAST_DURATION_MS);

    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(clearTimer);
    };
  }, [recentAchievement, clearRecentAchievement]);

  if (!visible || !recentAchievement) return null;

  return (
    <div style={containerStyle}>
      <div style={toastStyle(opacity)}>
        <span style={iconStyle}>{recentAchievement.icon}</span>
        <div style={contentStyle}>
          <span style={labelStyle}>Achievement Unlocked!</span>
          <span style={nameStyle}>{recentAchievement.name}</span>
          <span style={descStyle}>{recentAchievement.description}</span>
        </div>
      </div>
    </div>
  );
}
