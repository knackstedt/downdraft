// ============================================================================
// App — React UI overlay for the visual test bench
// Left sidebar: test list grouped by category. Right sidebar: controls.
// ============================================================================

import { useEffect, useMemo, useState } from "react";
import type { BenchState } from "./bench-state";
import type { VisualTest } from "./test-registry";

interface AppProps {
  getState: () => BenchState;
  subscribe: (fn: () => void) => () => void;
  onSelectTest: (id: string) => void;
}

export default function App({ getState, subscribe, onSelectTest }: AppProps) {
  const [, setTick] = useState(0);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());

  useEffect(() => {
    return subscribe(() => setTick((t) => t + 1));
  }, [subscribe]);

  const state = getState();

  // Group tests by category.
  const categories = useMemo(() => {
    const map = new Map<string, VisualTest[]>();
    for (const test of state.tests) {
      const list = map.get(test.category) ?? [];
      list.push(test);
      map.set(test.category, list);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [state.tests]);

  const activeTest = state.activeTestId
    ? state.tests.find((t) => t.id === state.activeTestId) ?? null
    : null;

  const toggleCategory = (cat: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  return (
    <div style={overlayStyle}>
      {/* Left sidebar — test list */}
      <div style={sidebarLeftStyle}>
        <div style={headerStyle}>Visual Test Bench</div>
        <div style={{ fontSize: "11px", color: "#888", marginBottom: "8px" }}>
          {state.tests.length} tests | {state.webgpuAvailable ? "WebGPU ✓" : "WebGPU ✗"}
        </div>
        {categories.map(([category, tests]) => {
          const collapsed = collapsedCategories.has(category);
          return (
            <div key={category} style={{ marginBottom: "4px" }}>
              <div
                style={categoryHeaderStyle}
                onClick={() => toggleCategory(category)}
              >
                <span style={{ cursor: "pointer", userSelect: "none" }}>
                  {collapsed ? "▶" : "▼"} {category} ({tests.length})
                </span>
              </div>
              {!collapsed && (
                <div>
                  {tests.map((test) => (
                    <div
                      key={test.id}
                      onClick={() => onSelectTest(test.id)}
                      style={{
                        ...testEntryStyle,
                        ...(state.activeTestId === test.id ? testEntryActiveStyle : {}),
                      }}
                    >
                      {test.name}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Right sidebar — active test info + controls */}
      <div style={sidebarRightStyle}>
        {activeTest ? (
          <>
            <div style={headerStyle}>{activeTest.name}</div>
            <div style={{ fontSize: "11px", color: "#aaa", marginBottom: "12px" }}>
              {activeTest.description}
            </div>
            {!state.rendererReady && !state.error && (
              <div style={{ color: "#ffb400", fontSize: "12px" }}>Initializing...</div>
            )}
            {state.error && (
              <div style={errorStyle}>{state.error}</div>
            )}
            {state.rendererReady && activeTest.getControls && (
              <ControlsPanel test={activeTest} />
            )}
          </>
        ) : (
          <div style={{ color: "#888", fontSize: "13px" }}>
            Select a test from the left panel.
          </div>
        )}
      </div>

      {/* Bottom status bar */}
      <div style={statusBarStyle}>
        FPS: {state.fps} | {activeTest ? activeTest.name : "No test selected"}
      </div>
    </div>
  );
}

function ControlsPanel({ test }: { test: VisualTest }) {
  const controls = test.getControls?.() ?? [];
  if (controls.length === 0) {
    return <div style={{ color: "#888", fontSize: "11px" }}>No controls for this test.</div>;
  }
  return (
    <div>
      <div style={{ ...headerStyle, fontSize: "12px", marginBottom: "8px" }}>Controls</div>
      {controls.map((ctrl) => {
        if (ctrl.type === "slider") {
          return (
            <div key={ctrl.key} style={controlRowStyle}>
              <label style={{ fontSize: "11px", color: "#ccc", display: "flex", justifyContent: "space-between" }}>
                <span>{ctrl.label}</span>
                <span style={{ color: "#4fc3f7" }}>{(ctrl.value as number).toFixed(2)}</span>
              </label>
              <input
                type="range"
                min={ctrl.min ?? 0}
                max={ctrl.max ?? 1}
                step={ctrl.step ?? 0.01}
                value={ctrl.value as number}
                onChange={(e) => ctrl.onChange(parseFloat(e.target.value))}
                style={{ width: "100%", accentColor: "#4fc3f7" }}
              />
            </div>
          );
        }
        if (ctrl.type === "checkbox") {
          return (
            <div key={ctrl.key} style={controlRowStyle}>
              <label style={{ fontSize: "11px", color: "#ccc", display: "flex", alignItems: "center", gap: "6px" }}>
                <input
                  type="checkbox"
                  checked={ctrl.value as boolean}
                  onChange={(e) => ctrl.onChange(e.target.checked)}
                  style={{ accentColor: "#4fc3f7" }}
                />
                {ctrl.label}
              </label>
            </div>
          );
        }
        if (ctrl.type === "button") {
          return (
            <div key={ctrl.key} style={controlRowStyle}>
              <button
                onClick={() => ctrl.onChange(true)}
                style={buttonStyle}
              >
                {ctrl.label}
              </button>
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

// ── Styles ──

const overlayStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  pointerEvents: "none",
  fontFamily: "monospace",
  zIndex: 100,
};

const sidebarLeftStyle: React.CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  bottom: 0,
  width: "240px",
  background: "rgba(10, 10, 18, 0.92)",
  borderRight: "1px solid #222",
  padding: "12px",
  overflowY: "auto",
  pointerEvents: "auto",
};

const sidebarRightStyle: React.CSSProperties = {
  position: "absolute",
  top: 0,
  right: 0,
  bottom: 0,
  width: "260px",
  background: "rgba(10, 10, 18, 0.92)",
  borderLeft: "1px solid #222",
  padding: "12px",
  overflowY: "auto",
  pointerEvents: "auto",
};

const headerStyle: React.CSSProperties = {
  fontSize: "14px",
  color: "#4fc3f7",
  fontWeight: "bold",
  marginBottom: "8px",
};

const categoryHeaderStyle: React.CSSProperties = {
  fontSize: "12px",
  color: "#ffb74d",
  fontWeight: "bold",
  padding: "4px 0",
  cursor: "pointer",
  userSelect: "none",
};

const testEntryStyle: React.CSSProperties = {
  fontSize: "12px",
  color: "#ccc",
  padding: "4px 8px",
  cursor: "pointer",
  borderRadius: "3px",
  marginLeft: "8px",
};

const testEntryActiveStyle: React.CSSProperties = {
  background: "rgba(79, 195, 247, 0.15)",
  color: "#4fc3f7",
};

const controlRowStyle: React.CSSProperties = {
  marginBottom: "10px",
};

const buttonStyle: React.CSSProperties = {
  fontSize: "11px",
  padding: "4px 10px",
  background: "#2563eb",
  color: "#fff",
  border: "none",
  borderRadius: "3px",
  cursor: "pointer",
  width: "100%",
};

const errorStyle: React.CSSProperties = {
  fontSize: "11px",
  color: "#ef5350",
  background: "rgba(239, 83, 80, 0.1)",
  padding: "8px",
  borderRadius: "4px",
  marginBottom: "8px",
  wordBreak: "break-word",
};

const statusBarStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 0,
  left: "240px",
  right: "260px",
  padding: "4px 12px",
  background: "rgba(10, 10, 18, 0.8)",
  fontSize: "11px",
  color: "#888",
  pointerEvents: "none",
  textAlign: "center",
};
