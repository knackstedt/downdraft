import React, { useState } from "react";

export interface EntityInfo {
  id: number;
  name: string;
  components: Array<{ name: string; data: Record<string, unknown> }>;
}

export const EntityInspector: React.FC<{
  entities: EntityInfo[];
}> = ({ entities }) => {
  const [selected, setSelected] = useState<number | null>(null);
  const entity = selected !== null ? entities[selected] : null;

  return (
    <div>
      <div style={{ fontWeight: "bold", marginBottom: 4, color: "#fff" }}>Entity Inspector</div>
      <div style={{ marginBottom: 4 }}>
        {entities.length} entit{entities.length === 1 ? "y" : "ies"}
      </div>
      {entities.length === 0 ? (
        <div style={{ color: "#666" }}>No entities</div>
      ) : (
        <>
          <select
            value={selected ?? -1}
            onChange={(e) => setSelected(Number(e.target.value))}
            style={{
              width: "100%",
              background: "#222",
              color: "#ccc",
              border: "1px solid #444",
              borderRadius: 3,
              padding: 4,
              marginBottom: 4,
            }}
          >
            <option value={-1}>— Select entity —</option>
            {entities.map((e, i) => (
              <option key={e.id} value={i}>
                #{e.id}: {e.name}
              </option>
            ))}
          </select>
          {entity && (
            <div style={{ fontSize: 11, color: "#aaa" }}>
              {entity.components.map((c) => (
                <div key={c.name} style={{ marginBottom: 2 }}>
                  <span style={{ color: "#8af" }}>{c.name}</span>:{" "}
                  {JSON.stringify(c.data).slice(0, 60)}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};
