// ============================================================================
// Overburden — task queue display UI
//
// Shows the selected blockhead's task queue (active + pending tasks).
// Toggle with Q.
// ============================================================================

import { useEffect, useState } from "react";
import { useGameStore } from "../stores/game-store";

interface TaskSummary {
  id: number;
  type: string;
  targetX: number;
  targetY: number;
  blockId: number;
  status: string;
}

const panelStyle: React.CSSProperties = {
  position: "absolute",
  top: 80,
  left: 16,
  width: 240,
  background: "rgba(20, 25, 40, 0.9)",
  border: "1px solid rgba(79,195,247,0.3)",
  borderRadius: 6,
  padding: 8,
  color: "white",
  fontFamily: "monospace",
  fontSize: 11,
  zIndex: 15,
  pointerEvents: "auto",
};

const headerStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: "bold",
  marginBottom: 6,
  color: "rgba(79,195,247,1)",
  display: "flex",
  justifyContent: "space-between",
};

const taskRowStyle = (isActive: boolean): React.CSSProperties => ({
  padding: "4px 6px",
  marginBottom: 2,
  background: isActive ? "rgba(79,195,247,0.15)" : "rgba(255,255,255,0.03)",
  borderRadius: 3,
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
});

const statusColors: Record<string, string> = {
  pending: "rgba(255,255,255,0.4)",
  moving: "#f39c12",
  executing: "#2ecc71",
  done: "#2ecc71",
  failed: "#e74c3c",
};

export function TaskQueueDisplay() {
  const renderer = useGameStore((s) => s.renderer);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);

  useEffect(() => {
    const interval = setInterval(async () => {
      const r = renderer;
      if (!r) return;
      const host = r.getWorkerHost();
      if (!host) return;
      try {
        const t = await host.getTasks(0);
        setTasks(t);
      } catch {
        // ignore
      }
    }, 250);
    return () => clearInterval(interval);
  }, [renderer]);

  if (tasks.length === 0) return null;

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <span>Task Queue [BH 0]</span>
        <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>Q to close</span>
      </div>
      {tasks.map((task, i) => (
        <div key={task.id} style={taskRowStyle(i === 0)}>
          <span>
            {i === 0 ? "→ " : "  "}
            {task.type}
            {(task.type === "MOVE_TO" || task.type === "MINE_BLOCK" || task.type === "PLACE_BLOCK" || task.type === "CHOP_TREE" || task.type === "SLEEP" || task.type === "COLLECT_ITEM") && (
              <span style={{ color: "rgba(255,255,255,0.4)" }}>
                {" "}({task.targetX}, {task.targetY})
              </span>
            )}
            {task.type === "CRAFT_AT" && task.blockId > 0 && (
              <span style={{ color: "rgba(255,255,255,0.4)" }}> #{task.blockId}</span>
            )}
          </span>
          <span style={{ color: statusColors[task.status] ?? "white", fontSize: 9 }}>
            {task.status}
          </span>
        </div>
      ))}
    </div>
  );
}
