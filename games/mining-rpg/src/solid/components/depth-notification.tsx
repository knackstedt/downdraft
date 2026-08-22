// ============================================================================
// DepthNotification — shows a banner when the player enters a new depth biome
// for the first time, and shows danger warnings when near hazardous areas.
//
// Biome notifications fire once per biome (tracked in a ref Set). Danger
// warnings fire when the player is near lava, deep water, or low oxygen.
// ============================================================================

import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import { gameStore, actions } from "../stores/game-store";
import type { JSX } from "solid-js";

interface Notification {
  title: string;
  subtitle: string;
  color: string;
  icon: string;
}

const bannerStyle = (color: string): JSX.CSSProperties => ({
  position: "absolute",
  top: "30%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  "z-index": "18",
  "pointer-events": "none",
  display: "flex",
  "flex-direction": "column",
  "align-items": "center",
  gap: "4px",
  padding: "16px 40px",
  background: "rgba(0,0,0,0.8)",
  border: `2px solid ${color}`,
  "border-radius": "8px",
  "font-family": "monospace",
  color: "#fff",
  "text-align": "center",
  "box-shadow": `0 0 30px ${color}40`,
  animation: "fadeInOut 4s ease-in-out forwards",
});

const iconStyle: JSX.CSSProperties = {
  "font-size": "32px",
};

const titleStyle: JSX.CSSProperties = {
  "font-size": "18px",
  "font-weight": "bold",
  "letter-spacing": "2px",
};

const subtitleStyle: JSX.CSSProperties = {
  "font-size": "12px",
  color: "rgba(255,255,255,0.6)",
};

// Biome definitions by depth threshold (meters)
const BIOMES: { threshold: number; title: string; subtitle: string; color: string; icon: string }[] = [
  { threshold: 50, title: "TOPSOIL LAYER", subtitle: "Soft dirt and gravel", color: "#8bc34a", icon: "🌱" },
  { threshold: 200, title: "SHALLOW CAVES", subtitle: "Tin and copper ore await", color: "#ffb74d", icon: "🕳️" },
  { threshold: 500, title: "DEEP CAVES", subtitle: "Iron ore and bauxite deposits", color: "#ff9800", icon: "⛏️" },
  { threshold: 1000, title: "IRON BELT", subtitle: "Rich iron veins and silver traces", color: "#e57373", icon: "🔩" },
  { threshold: 1500, title: "SILVER DEPTHS", subtitle: "Silver ore and dangerous caves", color: "#ba68c8", icon: "🥈" },
  { threshold: 2000, title: "GOLD ZONE", subtitle: "Gold ore — watch for lava!", color: "#ffd700", icon: "👑" },
  { threshold: 3000, title: "COBALT ABYSS", subtitle: "Cobalt ore and extreme danger", color: "#7986cb", icon: "🔷" },
  { threshold: 4000, title: "THE MANTLE", subtitle: "Final frontier — extreme heat", color: "#f44336", icon: "🌋" },
];

export function DepthNotification() {
  const [notification, setNotification] = createSignal<Notification | null>(null);
  const seenBiomes = new Set<number>();
  let lastDangerCheck = 0;
  let lastMaxDepth = gameStore.stats.maxDepthCells;

  // Max depth record notification
  createEffect(() => {
    const maxDepth = gameStore.stats.maxDepthCells;
    if (maxDepth > lastMaxDepth && maxDepth > 0) {
      lastMaxDepth = maxDepth;
      // Only show if it's a significant milestone (every 100m)
      if (maxDepth % 100 === 0 && maxDepth >= 100) {
        setNotification({
          title: "🏆 NEW RECORD!",
          subtitle: `Deepest depth: ${maxDepth}m`,
          color: "#ffd700",
          icon: "🏆",
        });
        setTimeout(() => setNotification(null), 3000);
      }
    }
  });

  // Biome entry detection + depth milestones every 500m
  createEffect(() => {
    const depthMeters = gameStore.depth * 128;
    // Check biome entries
    for (let i = BIOMES.length - 1; i >= 0; i--) {
      const biome = BIOMES[i];
      if (depthMeters >= biome.threshold && !seenBiomes.has(biome.threshold)) {
        seenBiomes.add(biome.threshold);
        setNotification({
          title: biome.title,
          subtitle: biome.subtitle,
          color: biome.color,
          icon: biome.icon,
        });
        setTimeout(() => setNotification(null), 4000);
        return;
      }
    }
    // Check 500m milestones (skip if already covered by a biome notification)
    const milestone = Math.floor(depthMeters / 500) * 500;
    if (milestone >= 500 && !seenBiomes.has(-milestone)) {
      // Don't show milestone if a biome notification was just shown
      const isBiomeThreshold = BIOMES.some((b) => b.threshold === milestone);
      if (!isBiomeThreshold) {
        seenBiomes.add(-milestone);
        setNotification({
          title: `${milestone}m DEPTH`,
          subtitle: "New depth milestone reached!",
          color: "#42a5f5",
          icon: "📏",
        });
        setTimeout(() => setNotification(null), 4000);
      } else {
        // Mark as seen so we don't keep checking
        seenBiomes.add(-milestone);
      }
    }
  });

  // Danger warning detection (low health / low oxygen / lava proximity / inventory full)
  createEffect(() => {
    // Track these reactively so the effect re-runs when they change
    const _health = gameStore.health;
    const _oxygen = gameStore.oxygen;
    const _depth = gameStore.depth;
    const _inv = gameStore.inventory;
    const _near = gameStore.nearSignpost;

    const interval = setInterval(() => {
      const now = Date.now();
      if (now - lastDangerCheck < 5000) return; // 5s cooldown

      // Low oxygen warning
      if (gameStore.oxygen < 180 && gameStore.oxygen > 0) { // < 3 seconds of oxygen
        lastDangerCheck = now;
        setNotification({
          title: "⚠️ LOW OXYGEN",
          subtitle: "Surface immediately!",
          color: "#ef5350",
          icon: "🫁",
        });
        setTimeout(() => setNotification(null), 4000);
        return;
      }

      // Low health warning
      if (gameStore.health < 25 && gameStore.health > 0) {
        lastDangerCheck = now;
        setNotification({
          title: "⚠️ LOW HEALTH",
          subtitle: "Danger nearby — retreat to safety",
          color: "#f44336",
          icon: "❤️",
        });
        setTimeout(() => setNotification(null), 4000);
        return;
      }

      // Lava proximity warning — check depth (lava appears in deep zones)
      const depthMeters = gameStore.depth * 128;
      if (depthMeters > 1500 && gameStore.health < 50) {
        lastDangerCheck = now;
        setNotification({
          title: "⚠️ DANGER ZONE",
          subtitle: "Deep caves — watch for lava and gas",
          color: "#ff5722",
          icon: "🌋",
        });
        setTimeout(() => setNotification(null), 4000);
        return;
      }

      // Inventory full reminder (only when not near signpost)
      const invUsed = actions.getInventoryCount();
      const invMax = actions.getMaxInventory();
      if (!gameStore.nearSignpost && invMax > 0 && invUsed >= invMax * 0.95) {
        lastDangerCheck = now;
        setNotification({
          title: "📦 INVENTORY FULL",
          subtitle: "Return to the surface signpost to sell (E)",
          color: "#ff9800",
          icon: "📦",
        });
        setTimeout(() => setNotification(null), 5000);
        return;
      }
    }, 1000);

    onCleanup(() => clearInterval(interval));
  });

  return (
    <Show when={notification()}>
      {(n) => (
        <>
          <style>{`
            @keyframes fadeInOut {
              0% { opacity: 0; transform: translate(-50%, -50%) scale(0.9); }
              15% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
              85% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
              100% { opacity: 0; transform: translate(-50%, -50%) scale(1); }
            }
          `}</style>
          <div style={bannerStyle(n().color)}>
            <div style={iconStyle}>{n().icon}</div>
            <div style={{ ...titleStyle, color: n().color }}>{n().title}</div>
            <div style={subtitleStyle}>{n().subtitle}</div>
          </div>
        </>
      )}
    </Show>
  );
}
