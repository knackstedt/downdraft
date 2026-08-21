// ============================================================================
// DepthNotification — shows a banner when the player enters a new depth biome
// for the first time, and shows danger warnings when near hazardous areas.
//
// Biome notifications fire once per biome (tracked in a ref Set). Danger
// warnings fire when the player is near lava, deep water, or low oxygen.
// ============================================================================

import { useEffect, useRef, useState } from "react";
import { useGameStore } from "../stores/game-store";

interface Notification {
  title: string;
  subtitle: string;
  color: string;
  icon: string;
}

const bannerStyle = (color: string): React.CSSProperties => ({
  position: "absolute",
  top: "30%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  zIndex: 18,
  pointerEvents: "none",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 4,
  padding: "16px 40px",
  background: "rgba(0,0,0,0.8)",
  border: `2px solid ${color}`,
  borderRadius: 8,
  fontFamily: "monospace",
  color: "#fff",
  textAlign: "center",
  boxShadow: `0 0 30px ${color}40`,
  animation: "fadeInOut 4s ease-in-out forwards",
});

const iconStyle: React.CSSProperties = {
  fontSize: 32,
};

const titleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: "bold",
  letterSpacing: 2,
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 12,
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
  const { depth, health, oxygen, inventory, nearSignpost, getMaxInventory, getInventoryCount } = useGameStore();
  const [notification, setNotification] = useState<Notification | null>(null);
  const seenBiomes = useRef<Set<number>>(new Set());
  const lastDangerCheck = useRef(0);

  // Biome entry detection + depth milestones every 500m
  useEffect(() => {
    const depthMeters = depth * 128;
    // Check biome entries
    for (let i = BIOMES.length - 1; i >= 0; i--) {
      const biome = BIOMES[i];
      if (depthMeters >= biome.threshold && !seenBiomes.current.has(biome.threshold)) {
        seenBiomes.current.add(biome.threshold);
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
    if (milestone >= 500 && !seenBiomes.current.has(-milestone)) {
      // Don't show milestone if a biome notification was just shown
      const isBiomeThreshold = BIOMES.some((b) => b.threshold === milestone);
      if (!isBiomeThreshold) {
        seenBiomes.current.add(-milestone);
        setNotification({
          title: `${milestone}m DEPTH`,
          subtitle: "New depth milestone reached!",
          color: "#42a5f5",
          icon: "📏",
        });
        setTimeout(() => setNotification(null), 4000);
      } else {
        // Mark as seen so we don't keep checking
        seenBiomes.current.add(-milestone);
      }
    }
  }, [depth]);

  // Danger warning detection (low health / low oxygen / lava proximity / inventory full)
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      if (now - lastDangerCheck.current < 5000) return; // 5s cooldown

      // Low oxygen warning
      if (oxygen < 180 && oxygen > 0) { // < 3 seconds of oxygen
        lastDangerCheck.current = now;
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
      if (health < 25 && health > 0) {
        lastDangerCheck.current = now;
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
      const depthMeters = depth * 128;
      if (depthMeters > 1500 && health < 50) {
        lastDangerCheck.current = now;
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
      const invUsed = getInventoryCount();
      const invMax = getMaxInventory();
      if (!nearSignpost && invMax > 0 && invUsed >= invMax * 0.95) {
        lastDangerCheck.current = now;
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

    return () => clearInterval(interval);
  }, [health, oxygen, depth, inventory, nearSignpost, getMaxInventory, getInventoryCount]);

  if (!notification) return null;

  return (
    <>
      <style>{`
        @keyframes fadeInOut {
          0% { opacity: 0; transform: translate(-50%, -50%) scale(0.9); }
          15% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
          85% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
          100% { opacity: 0; transform: translate(-50%, -50%) scale(1); }
        }
      `}</style>
      <div style={bannerStyle(notification.color)}>
        <div style={iconStyle}>{notification.icon}</div>
        <div style={{ ...titleStyle, color: notification.color }}>{notification.title}</div>
        <div style={subtitleStyle}>{notification.subtitle}</div>
      </div>
    </>
  );
}
