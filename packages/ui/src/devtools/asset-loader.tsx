import React, { useState } from "react";

interface AssetEntry {
  name: string;
  type: string;
  size: number;
  loaded: boolean;
}

export interface AssetLoaderProps {
  assets?: AssetEntry[];
}

export const AssetLoader: React.FC<AssetLoaderProps> = ({ assets: propAssets }) => {
  const [assets] = useState<AssetEntry[]>(propAssets ?? []);

  return (
    <div>
      <div style={{ fontWeight: "bold", marginBottom: 4, color: "#fff" }}>Assets</div>
      {assets.length === 0 ? (
        <div style={{ color: "#666" }}>No assets loaded</div>
      ) : (
        <div style={{ fontSize: 11, color: "#aaa" }}>
          {assets.map((a) => (
            <div key={a.name} style={{ marginBottom: 2 }}>
              <span style={{ color: a.loaded ? "#0f0" : "#f80" }}>
                {a.loaded ? "✓" : "…"}
              </span>{" "}
              {a.name} ({a.type}, {(a.size / 1024).toFixed(1)}KB)
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
