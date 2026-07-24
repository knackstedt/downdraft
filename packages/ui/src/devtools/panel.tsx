import React from "react";
import { DebugToggles, DEFAULT_TOGGLES, type DebugToggleState } from "./toggles.tsx";
import { TelemetryGraphs, type TelemetryData } from "./telemetry.tsx";
import { EntityInspector, type EntityInfo } from "./inspector.tsx";
import { AssetLoader } from "./asset-loader.tsx";

export interface DevToolsPanelProps {
  telemetry: TelemetryData;
  frameHistory: number[];
  entities: EntityInfo[];
  toggles: DebugToggleState;
  onTogglesChange: (toggles: DebugToggleState) => void;
}

export const DevToolsPanel: React.FC<DevToolsPanelProps> = ({
  telemetry,
  frameHistory,
  entities,
  toggles,
  onTogglesChange,
}) => {
  return (
    <div
      style={{
        position: "absolute",
        top: 50,
        right: 12,
        width: 280,
        background: "rgba(0, 0, 0, 0.8)",
        color: "#ccc",
        border: "1px solid #333",
        borderRadius: 6,
        padding: 12,
        fontFamily: "monospace",
        fontSize: 12,
        pointerEvents: "auto",
        maxHeight: "calc(100% - 70px)",
        overflowY: "auto",
      }}
    >
      <div style={{ fontWeight: "bold", marginBottom: 8, color: "#fff" }}>Devtools</div>
      <div style={{ marginBottom: 4 }}>Entity Count: {entities.length}</div>
      <hr style={{ borderColor: "#333", margin: "8px 0" }} />
      <TelemetryGraphs data={telemetry} frameHistory={frameHistory} />
      <hr style={{ borderColor: "#333", margin: "8px 0" }} />
      <DebugToggles toggles={toggles} onChange={onTogglesChange} />
      <hr style={{ borderColor: "#333", margin: "8px 0" }} />
      <EntityInspector entities={entities} />
      <hr style={{ borderColor: "#333", margin: "8px 0" }} />
      <AssetLoader />
    </div>
  );
};

export { DEFAULT_TOGGLES };
export type { DebugToggleState, TelemetryData, EntityInfo };
