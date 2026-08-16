import { useEffect, useState } from "react";
import { useGameStore } from "../stores/game-store";
import {
  captureThumbnail, deleteSave, listSaves, loadGame, saveGame, type SaveMetadata,
} from "../stores/save-system";

const panelStyle: React.CSSProperties = {
  position: "absolute", top: 50, left: 300, width: 360,
  background: "rgba(10,10,20,0.92)", borderRadius: 6, padding: 12,
  color: "#e8e8f0", fontFamily: "monospace", fontSize: 12,
  border: "1px solid rgba(192,132,252,0.3)",
  pointerEvents: "auto", maxHeight: "75vh", overflowY: "auto",
};

const titleStyle: React.CSSProperties = {
  color: "#c084fc", fontSize: 14, marginBottom: 8, borderBottom: "1px solid rgba(192,132,252,0.2)",
  paddingBottom: 4, display: "flex", justifyContent: "space-between",
};

const closeBtn: React.CSSProperties = {
  background: "none", border: "none", color: "rgba(255,255,255,0.5)", cursor: "pointer",
  fontSize: 16, padding: 0,
};

const saveCard: React.CSSProperties = {
  display: "flex", gap: 8, padding: 8, marginBottom: 6,
  background: "rgba(255,255,255,0.05)", borderRadius: 4, border: "1px solid rgba(255,255,255,0.1)",
};

const thumbStyle: React.CSSProperties = {
  width: 64, height: 40, borderRadius: 3, objectFit: "cover", flexShrink: 0,
  border: "1px solid rgba(255,255,255,0.15)",
};

const actionBtn: React.CSSProperties = {
  background: "rgba(192,132,252,0.15)", color: "#c084fc", fontSize: 10,
  padding: "2px 8px", borderRadius: 3, border: "1px solid rgba(192,132,252,0.3)",
  cursor: "pointer", fontFamily: "monospace", marginRight: 4,
};

const deleteBtnStyle: React.CSSProperties = {
  ...actionBtn, color: "#f87171", borderColor: "rgba(239,68,68,0.3)", background: "rgba(239,68,68,0.15)",
};

const saveNewBtn: React.CSSProperties = {
  background: "rgba(34,197,94,0.2)", color: "#4ade80", fontSize: 12,
  padding: "6px 14px", borderRadius: 4, border: "1px solid rgba(34,197,94,0.3)",
  cursor: "pointer", fontFamily: "monospace", marginBottom: 10,
};

export function SavesPanel() {
  const { showSaves, renderer, money, ingredientInventory, potions, unlockedTiers, discoveredRecipes } = useGameStore();
  const setShowSaves = useGameStore((s) => s.setShowSaves);
  const loadFullState = useGameStore((s) => s.loadFullState);
  const [saves, setSaves] = useState<SaveMetadata[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (showSaves) refreshSaves();
  }, [showSaves]);

  async function refreshSaves() {
    try {
      const list = await listSaves();
      setSaves(list);
    } catch (e) {
      console.warn("[saves] Failed to list:", e);
    }
  }

  async function doSave() {
    if (!renderer || saving) return;
    setSaving(true);
    try {
      const canvas = renderer.getCanvas();
      const thumb = await captureThumbnail(canvas);
      const { grid, fields, gridW, gridH } = renderer.snapshotGrid();
      const name = `Save ${new Date().toLocaleString()}`;
      await saveGame(name, thumb, gridW, gridH, grid, fields, {
        money, ingredientInventory, potions, unlockedTiers, discoveredRecipes,
      });
      await refreshSaves();
    } catch (e) {
      console.error("[saves] Save failed:", e);
    } finally {
      setSaving(false);
    }
  }

  async function doLoad(id: string) {
    if (!renderer) return;
    try {
      const entry = await loadGame(id);
      if (!entry) return;
      await renderer.loadSave(entry.grid, entry.fields, entry.gridW, entry.gridH);
      loadFullState({
        money: entry.money,
        ingredientInventory: entry.ingredientInventory,
        potions: entry.potions,
        unlockedTiers: entry.unlockedTiers,
        discoveredRecipes: entry.discoveredRecipes,
      });
      setShowSaves(false);
      console.log("[saves] Loaded:", entry.name);
    } catch (e) {
      console.error("[saves] Load failed:", e);
    }
  }

  async function doDelete(id: string) {
    try {
      await deleteSave(id);
      await refreshSaves();
    } catch (e) {
      console.error("[saves] Delete failed:", e);
    }
  }

  if (!showSaves) return null;

  return (
    <div style={panelStyle}>
      <div style={titleStyle}>
        <span>Saves</span>
        <button style={closeBtn} onClick={() => setShowSaves(false)}>✕</button>
      </div>

      <button style={saveNewBtn} onClick={doSave} disabled={saving}>
        {saving ? "Saving..." : "💾 Save current game"}
      </button>

      {saves.length === 0 ? (
        <div style={{ color: "rgba(255,255,255,0.4)" }}>No saved games yet</div>
      ) : (
        saves.map((save) => (
          <div key={save.id} style={saveCard}>
            <img style={thumbStyle} src={save.thumbnailUrl} alt="thumbnail" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {save.name}
              </div>
              <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 10 }}>
                {save.gridW}x{save.gridH} | {new Date(save.timestamp).toLocaleTimeString()}
              </div>
              <div style={{ marginTop: 4 }}>
                <button style={actionBtn} onClick={() => doLoad(save.id)}>Load</button>
                <button style={deleteBtnStyle} onClick={() => doDelete(save.id)}>Delete</button>
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
