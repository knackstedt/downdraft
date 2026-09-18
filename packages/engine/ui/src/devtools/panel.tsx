import React, { useState } from "react";
import { AssetLoader } from "./asset-loader";
import { EntityInspector, type EntityInfo } from "./inspector";
import { ProfilerPanel } from "./profiler";
import { TelemetryGraphs, type TelemetryData } from "./telemetry";
import { DebugToggles, DEFAULT_TOGGLES, type DebugToggleState } from "./toggles";

export interface DevToolsPanelProps {
  telemetry: TelemetryData;
  frameHistory: number[];
  entities: EntityInfo[];
  toggles: DebugToggleState;
  onTogglesChange: (toggles: DebugToggleState) => void;
}

type Tab = "overview" | "profiler" | "inspector" | "assets" | "toggles";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "profiler", label: "Profiler" },
  { id: "inspector", label: "Inspector" },
  { id: "assets", label: "Assets" },
  { id: "toggles", label: "Toggles" },
];

export const DevToolsPanel: React.FC<DevToolsPanelProps> = ({
  telemetry,
  frameHistory,
  entities,
  toggles,
  onTogglesChange,
}) => {
  const [activeTab, setActiveTab] = useState<Tab>("overview");

  return (
    <div
      style={{
        position: "absolute",
        top: 50,
        right: 12,
        width: 320,
        background: "rgba(0, 0, 0, 0.85)",
        color: "#ccc",
        border: "1px solid #333",
        borderRadius: 6,
        fontFamily: "monospace",
        fontSize: 12,
        pointerEvents: "auto",
        zIndex: 2,
        maxHeight: "calc(100% - 70px)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ fontWeight: "bold", padding: "8px 12px 4px", color: "#fff" }}>Devtools</div>
      {/* Tab bar */}
      <div style={{ display: "flex", gap: 0, borderBottom: "1px solid #333", padding: "0 4px" }}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: "4px 8px",
              background: activeTab === tab.id ? "rgba(60, 60, 80, 0.6)" : "transparent",
              color: activeTab === tab.id ? "#fff" : "#888",
              border: "none",
              borderBottom: activeTab === tab.id ? "2px solid #8af" : "2px solid transparent",
              cursor: "pointer",
              fontSize: 11,
              borderRadius: 0,
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ padding: 12, overflowY: "auto", flex: 1 }}>
        {activeTab === "overview" && (
          <>
            <div style={{ marginBottom: 4 }}>Entity Count: {entities.length}</div>
            <hr style={{ borderColor: "#333", margin: "8px 0" }} />
            <TelemetryGraphs data={telemetry} frameHistory={frameHistory} />
          </>
        )}
        {activeTab === "profiler" && (
          <ProfilerPanel />
        )}
        {activeTab === "inspector" && (
          <EntityInspector entities={entities} />
        )}
        {activeTab === "assets" && (
          <AssetLoader />
        )}
        {activeTab === "toggles" && (
          <DebugToggles toggles={toggles} onChange={onTogglesChange} />
        )}
      </div>
    </div>
  );
};

export { DEFAULT_TOGGLES };
export type { DebugToggleState, EntityInfo, TelemetryData };

