import React, { useState, useEffect } from "react";

interface AssetEntry {
  name: string;
  type: string;
  size: number;
  loaded: boolean;
}

export const AssetLoader: React.FC = () => {
  const [assets, setAssets] = useState<AssetEntry[]>([]);

  useEffect(() => {
    if (window.downdraft?.rpc) {
      window.downdraft.rpc.call("getAssets").then((data) => {
        if (Array.isArray(data)) {
          setAssets(data as AssetEntry[]);
        }
      }).catch(() => {});
    }
  }, []);

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
