// ============================================================================
// AchievementsPanel — full achievement list, toggled with the A key.
//
// Shows all achievements grouped by category, with locked/unlocked status.
// Unlocked achievements show their icon in full color; locked ones are
// dimmed with a lock icon. A progress bar at the top shows the overall
// completion percentage.
// ============================================================================

import { ACHIEVEMENTS, type Achievement } from "../shared/achievements";
import { useGameStore } from "../stores/game-store";

const panelStyle: React.CSSProperties = {
  position: "absolute",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  color: "rgba(255,255,255,0.9)",
  fontFamily: "monospace",
  fontSize: 13,
  padding: "20px 28px",
  background: "rgba(0,0,0,0.88)",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.15)",
  zIndex: 20,
  minWidth: 420,
  maxWidth: 560,
  maxHeight: "80vh",
  overflowY: "auto",
  pointerEvents: "auto",
};

const titleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: "bold",
  marginBottom: 8,
  paddingBottom: 8,
  borderBottom: "1px solid rgba(255,255,255,0.15)",
  textAlign: "center",
  letterSpacing: 2,
  color: "#a0a0c0",
};

const progressContainerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginBottom: 16,
};

const progressBarOuter: React.CSSProperties = {
  flex: 1,
  height: 12,
  background: "rgba(255,255,255,0.1)",
  borderRadius: 6,
  overflow: "hidden",
};

const progressBarInner = (pct: number): React.CSSProperties => ({
  width: `${pct}%`,
  height: "100%",
  background: "linear-gradient(90deg, #ffd700, #ffaa00)",
  borderRadius: 6,
  transition: "width 0.3s",
});

const categoryTitleStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: "bold",
  marginTop: 16,
  marginBottom: 6,
  color: "rgba(255,215,0,0.7)",
  textTransform: "uppercase",
  letterSpacing: 1,
  borderBottom: "1px solid rgba(255,255,255,0.08)",
  paddingBottom: 4,
};

const achievementRowStyle = (unlocked: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "6px 8px",
  borderRadius: 4,
  background: unlocked ? "rgba(255,215,0,0.06)" : "transparent",
  opacity: unlocked ? 1 : 0.5,
});

const iconStyle = (unlocked: boolean): React.CSSProperties => ({
  fontSize: 24,
  flexShrink: 0,
  filter: unlocked ? "none" : "grayscale(100%)",
});

const contentStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 1,
  flex: 1,
};

const nameStyle = (unlocked: boolean): React.CSSProperties => ({
  fontSize: 13,
  fontWeight: "bold",
  color: unlocked ? "#ffd700" : "rgba(255,255,255,0.6)",
});

const descStyle: React.CSSProperties = {
  fontSize: 11,
  color: "rgba(255,255,255,0.5)",
};

const statusStyle: React.CSSProperties = {
  fontSize: 16,
  flexShrink: 0,
};

const closeHintStyle: React.CSSProperties = {
  textAlign: "center",
  marginTop: 16,
  paddingTop: 8,
  borderTop: "1px solid rgba(255,255,255,0.1)",
  fontSize: 11,
  color: "rgba(255,255,255,0.4)",
};

const CATEGORY_LABELS: Record<Achievement["category"], string> = {
  depth: "Depth Milestones",
  collection: "Collection Milestones",
  economy: "Economic Milestones",
  discovery: "Discovery Milestones",
  combat: "Combat & Survival",
  upgrade: "Upgrade Milestones",
};

const CATEGORY_ORDER: Achievement["category"][] = [
  "depth", "collection", "economy", "discovery", "combat", "upgrade",
];

export function AchievementsPanel() {
  const { showAchievements, unlockedAchievements } = useGameStore();

  if (!showAchievements) return null;

  const unlockedCount = unlockedAchievements.size;
  const totalCount = ACHIEVEMENTS.length;
  const pct = totalCount > 0 ? (unlockedCount / totalCount) * 100 : 0;

  // Group achievements by category
  const byCategory = new Map<Achievement["category"], Achievement[]>();
  for (const ach of ACHIEVEMENTS) {
    const list = byCategory.get(ach.category) ?? [];
    list.push(ach);
    byCategory.set(ach.category, list);
  }

  return (
    <div style={panelStyle}>
      <div style={titleStyle}>ACHIEVEMENTS</div>

      <div style={progressContainerStyle}>
        <span style={{ fontSize: 12, color: "rgba(255,255,255,0.6)" }}>
          {unlockedCount}/{totalCount}
        </span>
        <div style={progressBarOuter}>
          <div style={progressBarInner(pct)} />
        </div>
        <span style={{ fontSize: 12, color: "#ffd700", fontWeight: "bold" }}>
          {pct.toFixed(0)}%
        </span>
      </div>

      {CATEGORY_ORDER.map((category) => {
        const achievements = byCategory.get(category);
        if (!achievements || achievements.length === 0) return null;
        return (
          <div key={category}>
            <div style={categoryTitleStyle}>{CATEGORY_LABELS[category]}</div>
            {achievements.map((ach) => {
              const unlocked = unlockedAchievements.has(ach.id);
              return (
                <div key={ach.id} style={achievementRowStyle(unlocked)}>
                  <span style={iconStyle(unlocked)}>{ach.icon}</span>
                  <div style={contentStyle}>
                    <span style={nameStyle(unlocked)}>{ach.name}</span>
                    <span style={descStyle}>{ach.description}</span>
                  </div>
                  <span style={statusStyle}>{unlocked ? "✓" : "🔒"}</span>
                </div>
              );
            })}
          </div>
        );
      })}

      <div style={closeHintStyle}>Press A to close</div>
    </div>
  );
}
