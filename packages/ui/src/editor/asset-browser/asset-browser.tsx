import React, { useCallback, useEffect, useState } from "react";

export interface AssetEntry {
  name: string;
  path: string;
  type: "mesh" | "texture" | "shader" | "audio" | "scene" | "script" | "unknown";
  size: number;
  loaded: boolean;
  thumbnail?: string;
}

export interface AssetBrowserProps {
  assets?: AssetEntry[];
  onImport?: (filePath: string) => void;
  onSelect?: (asset: AssetEntry) => void;
  onRefresh?: () => void;
}

const TYPE_ICONS: Record<AssetEntry["type"], string> = {
  mesh: "📦",
  texture: "🖼",
  shader: "⚙",
  audio: "🔊",
  scene: "🎬",
  script: "📜",
  unknown: "📄",
};

const TYPE_COLORS: Record<AssetEntry["type"], string> = {
  mesh: "#8af",
  texture: "#a8f",
  shader: "#fa8",
  audio: "#8fa",
  scene: "#f8a",
  script: "#aff",
  unknown: "#888",
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const AssetBrowser: React.FC<AssetBrowserProps> = ({
  assets: initialAssets,
  onImport,
  onSelect,
  onRefresh,
}) => {
  const [assets, setAssets] = useState<AssetEntry[]>(initialAssets ?? []);
  const [filter, setFilter] = useState<string>("");
  const [typeFilter, setTypeFilter] = useState<AssetEntry["type"] | "all">("all");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [selected, setSelected] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<"name" | "size" | "type">("name");

  useEffect(() => {
    if (initialAssets !== undefined) {
      setAssets(initialAssets);
    }
  }, [initialAssets]);

  const handleRefresh = useCallback(() => {
    if (onRefresh) {
      onRefresh();
    }
  }, [onRefresh]);

  const handleImport = useCallback(() => {
    if (onImport) {
      onImport("");
    }
  }, [onImport]);

  const handleSelect = useCallback((asset: AssetEntry) => {
    setSelected(asset.name);
    onSelect?.(asset);
  }, [onSelect]);

  const filtered = assets
    .filter((a) => typeFilter === "all" || a.type === typeFilter)
    .filter((a) => a.name.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => {
      switch (sortBy) {
        case "size": return a.size - b.size;
        case "type": return a.type.localeCompare(b.type);
        default: return a.name.localeCompare(b.name);
      }
    });

  const typeCounts = assets.reduce((acc, a) => {
    acc[a.type] = (acc[a.type] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#1a1a1e", color: "#ccc", fontFamily: "monospace" }}>
      {/* Toolbar */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        background: "#252530",
        borderBottom: "1px solid #333",
        fontSize: 12,
      }}>
        <span style={{ fontWeight: "bold", color: "#fff" }}>Asset Browser</span>
        <button onClick={handleImport} style={btnStyle}>+ Import</button>
        <button onClick={handleRefresh} style={btnStyle}>↻ Refresh</button>
        <div style={{ flex: 1 }} />
        <button onClick={() => setViewMode("grid")} style={{ ...btnStyle, background: viewMode === "grid" ? "#3a3a45" : "#333" }}>▦</button>
        <button onClick={() => setViewMode("list")} style={{ ...btnStyle, background: viewMode === "list" ? "#3a3a45" : "#333" }}>☰</button>
      </div>

      {/* Filter bar */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        background: "#1e1e25",
        borderBottom: "1px solid #333",
        fontSize: 12,
      }}>
        <input
          type="text"
          placeholder="Search assets..."
          value={filter}
          maxLength={256}
          onChange={(e) => setFilter(e.target.value)}
          style={{
            flex: 1,
            background: "#1a1a1e",
            color: "#ccc",
            border: "1px solid #444",
            borderRadius: 3,
            padding: "4px 8px",
            fontSize: 12,
          }}
        />
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as AssetEntry["type"] | "all")}
          style={{
            background: "#1a1a1e",
            color: "#ccc",
            border: "1px solid #444",
            borderRadius: 3,
            padding: "4px 6px",
            fontSize: 12,
          }}
        >
          <option value="all">All Types</option>
          <option value="mesh">Meshes ({typeCounts.mesh ?? 0})</option>
          <option value="texture">Textures ({typeCounts.texture ?? 0})</option>
          <option value="shader">Shaders ({typeCounts.shader ?? 0})</option>
          <option value="audio">Audio ({typeCounts.audio ?? 0})</option>
          <option value="scene">Scenes ({typeCounts.scene ?? 0})</option>
          <option value="script">Scripts ({typeCounts.script ?? 0})</option>
        </select>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as "name" | "size" | "type")}
          style={{
            background: "#1a1a1e",
            color: "#ccc",
            border: "1px solid #444",
            borderRadius: 3,
            padding: "4px 6px",
            fontSize: 12,
          }}
        >
          <option value="name">Sort: Name</option>
          <option value="size">Sort: Size</option>
          <option value="type">Sort: Type</option>
        </select>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: 8 }}>
        {filtered.length === 0 ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#666" }}>
            {assets.length === 0 ? "No assets loaded. Click Import to add assets." : "No assets match the filter."}
          </div>
        ) : viewMode === "grid" ? (
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(100px, 1fr))",
            gap: 8,
          }}>
            {filtered.map((asset) => (
              <div
                key={asset.name}
                onClick={() => handleSelect(asset)}
                style={{
                  padding: 8,
                  background: selected === asset.name ? "rgba(60, 80, 120, 0.4)" : "rgba(30, 30, 35, 0.6)",
                  border: selected === asset.name ? "1px solid #8af" : "1px solid #333",
                  borderRadius: 6,
                  cursor: "pointer",
                  textAlign: "center",
                  transition: "background 0.15s",
                }}
                onMouseEnter={(e) => { if (selected !== asset.name) e.currentTarget.style.background = "rgba(40, 40, 50, 0.6)"; }}
                onMouseLeave={(e) => { if (selected !== asset.name) e.currentTarget.style.background = "rgba(30, 30, 35, 0.6)"; }}
              >
                <div style={{ fontSize: 28, marginBottom: 4 }}>{TYPE_ICONS[asset.type]}</div>
                <div style={{
                  fontSize: 11,
                  color: "#ccc",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}>
                  {asset.name}
                </div>
                <div style={{ fontSize: 10, color: "#666" }}>{formatSize(asset.size)}</div>
                <div style={{ fontSize: 10, color: asset.loaded ? "#4a8" : "#a64" }}>
                  {asset.loaded ? "✓ loaded" : "… loading"}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #333", textAlign: "left" }}>
                <th style={{ padding: "4px 8px", color: "#888" }}>Name</th>
                <th style={{ padding: "4px 8px", color: "#888" }}>Type</th>
                <th style={{ padding: "4px 8px", color: "#888" }}>Size</th>
                <th style={{ padding: "4px 8px", color: "#888" }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((asset) => (
                <tr
                  key={asset.name}
                  onClick={() => handleSelect(asset)}
                  style={{
                    cursor: "pointer",
                    background: selected === asset.name ? "rgba(60, 80, 120, 0.3)" : "transparent",
                  }}
                >
                  <td style={{ padding: "4px 8px" }}>
                    {TYPE_ICONS[asset.type]} {asset.name}
                  </td>
                  <td style={{ padding: "4px 8px", color: TYPE_COLORS[asset.type] }}>{asset.type}</td>
                  <td style={{ padding: "4px 8px", color: "#888" }}>{formatSize(asset.size)}</td>
                  <td style={{ padding: "4px 8px", color: asset.loaded ? "#4a8" : "#a64" }}>
                    {asset.loaded ? "✓" : "…"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Status bar */}
      <div style={{
        padding: "4px 12px",
        background: "#252530",
        borderTop: "1px solid #333",
        fontSize: 11,
        color: "#666",
        display: "flex",
        justifyContent: "space-between",
      }}>
        <span>{filtered.length} / {assets.length} assets</span>
        <span>{Object.entries(typeCounts).map(([t, c]) => `${t}: ${c}`).join(" | ")}</span>
      </div>
    </div>
  );
};

const btnStyle: React.CSSProperties = {
  padding: "4px 10px",
  background: "#333",
  color: "#ccc",
  border: "1px solid #444",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 12,
};
