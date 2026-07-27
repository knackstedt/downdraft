import React from "react";
import { useGameStore } from "../stores/gameStore";

export default function NotificationStack() {
  const { notifications, removeNotification } = useGameStore();

  React.useEffect(() => {
    const timers = notifications.map((n) =>
      setTimeout(() => removeNotification(n.id), 5000)
    );
    return () => timers.forEach(clearTimeout);
  }, [notifications, removeNotification]);

  return (
    <div className="absolute top-16 right-4 flex flex-col gap-2 pointer-events-none">
      {notifications.map((n) => (
        <div
          key={n.id}
          className={`hud-panel px-4 py-2 animate-slide-up ${
            n.type === "error" ? "border-coral-500/50" :
            n.type === "success" ? "border-biome-safe/50" :
            "border-ocean-500/50"
          }`}
        >
          <span className="text-ocean-100 text-sm">{n.text}</span>
        </div>
      ))}
    </div>
  );
}
