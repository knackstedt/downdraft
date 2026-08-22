// ============================================================================
// AchievementsPanel — full achievement list, toggled with the A key.
//
// Shows all achievements grouped by category, with locked/unlocked status.
// Unlocked achievements show their icon in full color; locked ones are
// dimmed with a lock icon. A progress bar at the top shows the overall
// completion percentage.
// ============================================================================

import type { JSX } from "solid-js";
import { For, Show } from "solid-js";
import { ACHIEVEMENTS, type Achievement } from "../../shared/achievements";
import { gameStore } from "../stores/game-store";

const panelStyle: JSX.CSSProperties = {
  position: "absolute",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  color: "rgba(255,255,255,0.9)",
  "font-family": "monospace",
  "font-size": "13px",
  padding: "20px 28px",
  background: "rgba(0,0,0,0.88)",
  "border-radius": "8px",
  border: "1px solid rgba(255,255,255,0.15)",
  "z-index": "20",
  "min-width": "420px",
  "max-width": "560px",
  "max-height": "80vh",
  "overflow-y": "auto",
  "pointer-events": "auto",
  "scrollbar-width": "thin",
  "scrollbar-color": "rgba(255,215,0,0.3) rgba(255,255,255,0.05)",
};

const titleStyle: JSX.CSSProperties = {
  "font-size": "18px",
  "font-weight": "bold",
  "margin-bottom": "8px",
  "padding-bottom": "8px",
  "border-bottom": "1px solid rgba(255,255,255,0.15)",
  "text-align": "center",
  "letter-spacing": "2px",
  color: "#a0a0c0",
};

const progressContainerStyle: JSX.CSSProperties = {
  display: "flex",
  "align-items": "center",
  gap: "8px",
  "margin-bottom": "16px",
};

const progressBarOuter: JSX.CSSProperties = {
  flex: "1",
  height: "12px",
  background: "rgba(255,255,255,0.1)",
  "border-radius": "6px",
  overflow: "hidden",
};

const progressBarInner = (pct: number): JSX.CSSProperties => ({
  width: `${pct}%`,
  height: "100%",
  background: "linear-gradient(90deg, #ffd700, #ffaa00)",
  "border-radius": "6px",
  transition: "width 0.3s",
});

const categoryTitleStyle: JSX.CSSProperties = {
  "font-size": "12px",
  "font-weight": "bold",
  "margin-top": "16px",
  "margin-bottom": "6px",
  color: "rgba(255,215,0,0.7)",
  "text-transform": "uppercase",
  "letter-spacing": "1px",
  "border-bottom": "1px solid rgba(255,255,255,0.08)",
  "padding-bottom": "4px",
};

const achievementRowStyle = (unlocked: boolean): JSX.CSSProperties => ({
  display: "flex",
  "align-items": "center",
  gap: "12px",
  padding: "6px 8px",
  "border-radius": "4px",
  background: unlocked ? "rgba(255,215,0,0.06)" : "transparent",
  opacity: unlocked ? 1 : 0.5,
});

const iconStyle = (unlocked: boolean): JSX.CSSProperties => ({
  "font-size": "24px",
  "flex-shrink": "0",
  filter: unlocked ? "none" : "grayscale(100%)",
});

const contentStyle: JSX.CSSProperties = {
  display: "flex",
  "flex-direction": "column",
  gap: "1px",
  flex: "1",
};

const nameStyle = (unlocked: boolean): JSX.CSSProperties => ({
  "font-size": "13px",
  "font-weight": "bold",
  color: unlocked ? "#ffd700" : "rgba(255,255,255,0.6)",
});

const descStyle: JSX.CSSProperties = {
  "font-size": "11px",
  color: "rgba(255,255,255,0.5)",
};

const statusStyle: JSX.CSSProperties = {
  "font-size": "16px",
  "flex-shrink": "0",
};

const closeHintStyle: JSX.CSSProperties = {
  "text-align": "center",
  "margin-top": "16px",
  "padding-top": "8px",
  "border-top": "1px solid rgba(255,255,255,0.1)",
  "font-size": "11px",
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
  const unlockedSet = () => new Set(gameStore.unlockedAchievements);
  const unlockedCount = () => unlockedSet().size;
  const totalCount = ACHIEVEMENTS.length;
  const pct = () => totalCount > 0 ? (unlockedCount() / totalCount) * 100 : 0;

  // Group achievements by category
  const byCategory = () => {
    const map = new Map<Achievement["category"], Achievement[]>();
    for (const ach of ACHIEVEMENTS) {
      const list = map.get(ach.category) ?? [];
      list.push(ach);
      map.set(ach.category, list);
    }
    return map;
  };

  return (
    <Show when={gameStore.showAchievements}>
      <div style={panelStyle} class="dd-ach-scroll">
        <style>{`
          .dd-ach-scroll::-webkit-scrollbar { width: 8px; }
          .dd-ach-scroll::-webkit-scrollbar-track { background: rgba(255,255,255,0.05); border-radius: 4px; }
          .dd-ach-scroll::-webkit-scrollbar-thumb { background: rgba(255,215,0,0.3); border-radius: 4px; }
          .dd-ach-scroll::-webkit-scrollbar-thumb:hover { background: rgba(255,215,0,0.5); }
        `}</style>
        <div style={titleStyle}>ACHIEVEMENTS</div>

        <div style={progressContainerStyle}>
          <span style={{ "font-size": "12px", color: "rgba(255,255,255,0.6)" }}>
            {unlockedCount()}/{totalCount}
          </span>
          <div style={progressBarOuter}>
            <div style={progressBarInner(pct())} />
          </div>
          <span style={{ "font-size": "12px", color: "#ffd700", "font-weight": "bold" }}>
            {pct().toFixed(0)}%
          </span>
        </div>

        {/* Category summary */}
        <div style={{ display: "flex", "flex-wrap": "wrap", gap: "6px", "margin-bottom": "8px", "font-size": "10px", color: "rgba(255,255,255,0.4)" }}>
          <For each={Array.from(byCategory().entries())}>
            {([cat, list]) => {
              const unlocked = list.filter((a) => unlockedSet().has(a.id)).length;
              return (
                <span style={{
                  padding: "2px 6px",
                  "border-radius": "3px",
                  background: "rgba(255,255,255,0.05)",
                  "text-transform": "capitalize",
                }}>
                  {cat}: {unlocked}/{list.length}
                </span>
              );
            }}
          </For>
        </div>

        <For each={CATEGORY_ORDER}>
          {(category) => {
            const achievements = byCategory().get(category);
            if (!achievements || achievements.length === 0) return null;
            return (
              <div>
                <div style={categoryTitleStyle}>{CATEGORY_LABELS[category]}</div>
                <For each={achievements}>
                  {(ach) => {
                    const unlocked = unlockedSet().has(ach.id);
                    return (
                      <div style={achievementRowStyle(unlocked)}>
                        <span style={iconStyle(unlocked)}>{ach.icon}</span>
                        <div style={contentStyle}>
                          <span style={nameStyle(unlocked)}>{ach.name}</span>
                          <span style={descStyle}>{ach.description}</span>
                        </div>
                        <span style={statusStyle}>{unlocked ? "✓" : "🔒"}</span>
                      </div>
                    );
                  }}
                </For>
              </div>
            );
          }}
        </For>

        <div style={closeHintStyle}>Press F4 to close</div>
      </div>
    </Show>
  );
}
