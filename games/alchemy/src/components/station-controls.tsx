import { useEffect, useState } from "react";
import { useGameStore } from "../stores/game-store";

const stationBarStyle: React.CSSProperties = {
  position: "absolute", bottom: 40, left: "50%", transform: "translateX(-50%)",
  display: "flex", gap: 8, alignItems: "center",
  padding: "8px 12px", background: "rgba(10,10,20,0.85)", borderRadius: 6,
  border: "1px solid rgba(192,132,252,0.3)",
  pointerEvents: "auto",
};

const stationBtnStyle: React.CSSProperties = {
  background: "rgba(192,132,252,0.15)", color: "#e8e8f0", fontSize: 13,
  padding: "6px 16px", borderRadius: 4, border: "1px solid rgba(192,132,252,0.4)",
  cursor: "pointer", fontFamily: "monospace",
};

const stationBtnActive: React.CSSProperties = {
  ...stationBtnStyle,
  background: "rgba(192,132,252,0.4)", border: "1px solid #c084fc",
};

const stationBtnDisabled: React.CSSProperties = {
  ...stationBtnStyle,
  opacity: 0.4, cursor: "not-allowed",
};

const durationLabel: React.CSSProperties = {
  color: "rgba(255,255,255,0.6)", fontSize: 11, fontFamily: "monospace",
};

const progressStyle: React.CSSProperties = {
  width: 120, height: 4, background: "rgba(255,255,255,0.1)", borderRadius: 2, overflow: "hidden",
};

const progressFill: React.CSSProperties = {
  height: "100%", background: "#c084fc", transition: "width 0.1s linear",
};

const STATION_DURATIONS: Record<string, number> = {
  heat: 60,
  cool: 60,
  settle: 90,
};

export function StationControls() {
  const { renderer, activeStation, stationProgress, processHistory } = useGameStore();
  const addProcessStep = useGameStore((s) => s.addProcessStep);
  const setActiveStation = useGameStore((s) => s.setActiveStation);
  const setStationProgress = useGameStore((s) => s.setStationProgress);
  const [, setPolling] = useState(false);

  // Poll station progress while a station is active
  useEffect(() => {
    if (!activeStation || !renderer) return;
    setPolling(true);
    const interval = setInterval(async () => {
      const host = renderer.getWorkerHost();
      if (!host) return;
      const state = await host.getStationState();
      setStationProgress(state.progress);
      if (state.station === null) {
        // Station finished — record the process step
        addProcessStep(activeStation);
        setActiveStation(null);
        setStationProgress(0);
        setPolling(false);
      }
    }, 100);
    return () => {
      clearInterval(interval);
      setPolling(false);
    };
  }, [activeStation, renderer, addProcessStep, setActiveStation, setStationProgress]);

  function runStation(station: "heat" | "cool" | "settle") {
    if (!renderer || activeStation) return;
    const host = renderer.getWorkerHost();
    if (!host) return;
    const duration = STATION_DURATIONS[station];
    host.runStation(station, duration);
    setActiveStation(station);
    setStationProgress(0);
  }

  function cancelStation() {
    if (!renderer) return;
    const host = renderer.getWorkerHost();
    host?.cancelStation();
    setActiveStation(null);
    setStationProgress(0);
  }

  return (
    <div style={stationBarStyle}>
      <button
        style={activeStation === "heat" ? stationBtnActive : activeStation ? stationBtnDisabled : stationBtnStyle}
        onClick={() => runStation("heat")}
        disabled={!!activeStation}
        title="Heat the cauldron — amplifies volatile/reactive, dampens dense"
      >
        🔥 Heat
      </button>
      <button
        style={activeStation === "cool" ? stationBtnActive : activeStation ? stationBtnDisabled : stationBtnStyle}
        onClick={() => runStation("cool")}
        disabled={!!activeStation}
        title="Cool the cauldron — dampens reactive, boosts dense"
      >
        ❄️ Cool
      </button>
      <button
        style={activeStation === "settle" ? stationBtnActive : activeStation ? stationBtnDisabled : stationBtnStyle}
        onClick={() => runStation("settle")}
        disabled={!!activeStation}
        title="Settle the cauldron — concentrates dense, drops volatile"
      >
        ⏳ Settle
      </button>

      {activeStation && (
        <>
          <span style={durationLabel}>{activeStation}…</span>
          <div style={progressStyle}>
            <div style={{ ...progressFill, width: `${stationProgress * 100}%` }} />
          </div>
          <button style={stationBtnStyle} onClick={cancelStation}>✕</button>
        </>
      )}

      {processHistory.length > 0 && (
        <span style={durationLabel}>Process: {processHistory.join(" → ")}</span>
      )}
    </div>
  );
}
