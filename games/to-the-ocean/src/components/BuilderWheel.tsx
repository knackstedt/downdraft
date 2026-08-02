import { BUILDER_CELL_OPTIONS } from "@shared/constants";
import React from "react";
import { useGameStore } from "../stores/gameStore";

const BUILDER_GROUPS: { label: string; icon: string; indices: number[] }[] = [
  { label: "Hull", icon: "⬢", indices: [0, 1, 2, 3, 4, 5] },
  { label: "Walls", icon: "▣", indices: [6, 7, 8, 9] },
  { label: "Structures", icon: "⌂", indices: [10, 11, 12, 13, 14] },
  { label: "Floatation", icon: "≈", indices: [15, 16] },
  { label: "Furniture", icon: "🛏", indices: [17, 18] },
  { label: "Templates", icon: "▦", indices: [19, 20, 21] },
];

export default function BuilderWheel() {
  const builderCellType = useGameStore((s) => s.builderCellType);
  const setBuilderCellType = useGameStore((s) => s.setBuilderCellType);
  const setShowBuilderWheel = useGameStore((s) => s.setShowBuilderWheel);
  const renderer = useGameStore((s) => s.renderer);
  const [hoveredIdx, setHoveredIdx] = React.useState<number | null>(null);
  const [expandedGroup, setExpandedGroup] = React.useState<number | null>(null);

  const close = React.useCallback(() => {
    setShowBuilderWheel(false);
    useGameStore.getState().setSuppressPauseMenu(true);
    if (renderer) renderer.lockPointer();
  }, [renderer, setShowBuilderWheel]);

  const selectAndClose = React.useCallback((idx: number) => {
    setBuilderCellType(idx);
    close();
  }, [setBuilderCellType, close]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  // Auto-expand the group containing the currently selected item
  React.useEffect(() => {
    if (expandedGroup === null) {
      for (let g = 0; g < BUILDER_GROUPS.length; g++) {
        if (BUILDER_GROUPS[g].indices.includes(builderCellType)) {
          setExpandedGroup(g);
          break;
        }
      }
    }
  }, []);

  const options = BUILDER_CELL_OPTIONS;
  const currentGroup = expandedGroup !== null ? BUILDER_GROUPS[expandedGroup] : null;

  return (
    <div
      className="absolute inset-0 flex items-center justify-center pointer-events-auto bg-ocean-950/70"
      onClick={close}
      onContextMenu={(e) => { e.preventDefault(); close(); }}
    >
      {/* Flex row: panel + flyout with no gap between them */}
      <div className="flex items-stretch" onClick={(e) => e.stopPropagation()}>
        {/* Left: static-height group list */}
        <div className="hud-panel rounded-l-xl p-4 w-[200px]">
          {/* Header */}
          <div className="flex items-center justify-between mb-3 pb-2 border-b border-ocean-700">
            <div className="flex items-center gap-2">
              <span className="text-amber-400 text-lg">🔨</span>
              <span className="text-ocean-100 font-bold text-sm">Builder</span>
            </div>
            <button
              className="text-ocean-400 hover:text-ocean-200 text-xs px-2 py-1 rounded hover:bg-ocean-700/50"
              onClick={close}
            >
              Esc ✕
            </button>
          </div>

          {/* Static-height group list */}
          <div className="flex flex-col gap-1">
            {BUILDER_GROUPS.map((group, gi) => {
              const isExpanded = expandedGroup === gi;
              const hasSelected = group.indices.includes(builderCellType);

              return (
                <button
                  key={gi}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg transition-colors text-left ${
                    hasSelected
                      ? "bg-ocean-700/60 border border-amber-500/40"
                      : "bg-ocean-800/50 hover:bg-ocean-700/40 border border-ocean-700/50"
                  } ${isExpanded ? "ring-1 ring-amber-400/60" : ""}`}
                  onMouseEnter={() => setExpandedGroup(gi)}
                  onClick={() => setExpandedGroup(isExpanded ? null : gi)}
                >
                  <span className="text-ocean-300 text-base">{group.icon}</span>
                  <span className="text-ocean-100 text-xs font-semibold flex-1">{group.label}</span>
                  {hasSelected && (
                    <span className="text-amber-300 text-[10px]">
                      {options[builderCellType]?.name}
                    </span>
                  )}
                  <span className={`text-ocean-500 text-[10px] transition-transform ${isExpanded ? "rotate-90" : ""}`}>
                    ▶
                  </span>
                </button>
              );
            })}
          </div>

          {/* Footer hint */}
          <div className="text-ocean-500 text-[10px] text-center mt-3 pt-2 border-t border-ocean-700/50">
            Hover to browse · Click to select
          </div>
        </div>

        {/* Right: flyout panel — always rendered, visibility toggled via CSS */}
        {/* No gap: the flyout is directly adjacent to the panel */}
        {currentGroup && (
          <div
            className="hud-panel rounded-r-xl p-2"
            onMouseEnter={() => setExpandedGroup(expandedGroup)}
          >
            <div className="grid grid-cols-3 gap-1.5 min-w-[240px]">
              {currentGroup.indices.map((idx) => {
                const opt = options[idx];
                const isSelected = idx === builderCellType;
                const isHovered = idx === hoveredIdx;

                return (
                  <button
                    key={idx}
                    className={`rounded-lg px-2 py-2.5 text-[11px] font-semibold text-center transition-all ${
                      isSelected
                        ? "bg-amber-600/80 text-white border border-amber-400"
                        : isHovered
                        ? "bg-ocean-600/60 text-ocean-100 border border-ocean-400"
                        : "bg-ocean-800/60 text-ocean-200 border border-ocean-700/50 hover:border-ocean-500"
                    }`}
                    onMouseEnter={() => setHoveredIdx(idx)}
                    onMouseLeave={() => setHoveredIdx(null)}
                    onClick={() => selectAndClose(idx)}
                  >
                    {opt.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
