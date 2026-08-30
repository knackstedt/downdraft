import type { GCStats } from "@downdraft/core";
import { useDebugStore, type CollisionLogEntry } from "@downdraft/module-devtools";
import { motion } from "framer-motion";
import { X } from "lucide-react";

function GCStatsRow({ stats }: { stats: GCStats }) {
  const { interval, overall } = stats;
  const intervalPct = overall.wallMs > 0
    ? ((interval.totalTime / 2000) * 100).toFixed(1)
    : "0.0";
  const overallPct = overall.wallMs > 0
    ? ((overall.totalTime / overall.wallMs) * 100).toFixed(1)
    : "0.0";
  const avgMs = interval.count > 0
    ? (interval.totalTime / interval.count).toFixed(2)
    : "0.00";
  const overallAvg = overall.count > 0
    ? (overall.totalTime / overall.count).toFixed(2)
    : "0.00";

  return (
    <div className="border border-ocean-700/50 rounded-lg p-3 bg-ocean-900/40">
      <div className="flex items-center justify-between mb-2">
        <span className="text-ocean-200 font-bold text-sm">{stats.label}</span>
        <span className="text-ocean-400 text-xs">
          {interval.count} events / 2s
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-ocean-300">
        <div>Interval: <span className="text-ocean-100">{interval.totalTime.toFixed(1)}ms</span> ({intervalPct}% of wall)</div>
        <div>Overall: <span className="text-ocean-100">{overall.totalTime.toFixed(1)}ms</span> ({overallPct}% of wall)</div>
        <div>Avg/event: <span className="text-ocean-100">{avgMs}ms</span> (interval), <span className="text-ocean-100">{overallAvg}ms</span> (overall)</div>
        <div>Total events: <span className="text-ocean-100">{overall.count}</span></div>
        <div className="col-span-2 mt-1 flex gap-4">
          <span className="text-green-400">Scavenge: {interval.scavengeCount} ({interval.scavengeTime.toFixed(1)}ms)</span>
          <span className="text-orange-400">Major: {interval.majorCount} ({interval.majorTime.toFixed(1)}ms)</span>
          <span className="text-blue-400">Other: {interval.otherCount} ({interval.otherTime.toFixed(1)}ms)</span>
        </div>
      </div>
    </div>
  );
}

function CollisionRow({ entry }: { entry: CollisionLogEntry }) {
  const ago = ((Date.now() - entry.lastCollisionTime) / 1000).toFixed(1);
  return (
    <div className="flex items-center justify-between text-xs text-ocean-300 py-1 border-b border-ocean-800/50 last:border-0">
      <span className="text-ocean-100 font-mono">{entry.label}</span>
      <span className="flex gap-3">
        <span className="text-yellow-400">×{entry.count}</span>
        <span className="text-ocean-400">{ago}s ago</span>
      </span>
    </div>
  );
}

export default function DebugPage() {
  const { gcStats, rendererStats, collisionLog, setDebugPage } = useDebugStore();

  const gcEntries = Object.values(gcStats).sort((a, b) =>
    a.label.localeCompare(b.label),
  );

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute top-0 right-0 bottom-0 w-[420px] pointer-events-auto bg-ocean-950/90 backdrop-blur-md border-l border-ocean-800 overflow-y-auto z-50"
    >
      <div className="sticky top-0 bg-ocean-950/95 backdrop-blur-md border-b border-ocean-800 px-4 py-3 flex items-center justify-between z-10">
        <h2 className="text-ocean-100 font-bold text-lg">Debug</h2>
        <button
          onClick={() => setDebugPage(false)}
          className="text-ocean-400 hover:text-ocean-100 transition-colors"
        >
          <X size={20} />
        </button>
      </div>

      <div className="p-4 space-y-4">
        {/* GC Stats */}
        <div>
          <h3 className="text-ocean-200 font-semibold text-sm mb-2 uppercase tracking-wide">Garbage Collection</h3>
          <div className="space-y-2">
            {gcEntries.length === 0 && (
              <div className="text-ocean-500 text-xs italic">Waiting for GC stats...</div>
            )}
            {gcEntries.map((stats) => (
              <GCStatsRow key={stats.label} stats={stats} />
            ))}
          </div>
        </div>

        {/* Renderer Stats */}
        <div>
          <h3 className="text-ocean-200 font-semibold text-sm mb-2 uppercase tracking-wide">Renderer</h3>
          {rendererStats ? (
            <div className="border border-ocean-700/50 rounded-lg p-3 bg-ocean-900/40 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-ocean-300">
              <div>FPS: <span className="text-ocean-100 font-bold">{rendererStats.fps}</span></div>
              <div>Tick: <span className="text-ocean-100">{rendererStats.tick}</span></div>
              <div>Entities: <span className="text-ocean-100">{rendererStats.entityCount}</span></div>
              <div>Players: <span className="text-ocean-100">{rendererStats.playerCount}</span></div>
              <div>Canvas: <span className="text-ocean-100">{rendererStats.canvasW}x{rendererStats.canvasH}</span></div>
              <div>Viewport: <span className="text-ocean-100">{rendererStats.viewportW}x{rendererStats.viewportH}</span></div>
              {(() => { const x = rendererStats.extra ?? {}; return (<>
              <div>Water: <span className="text-ocean-100">{x.waterValid ? `valid (${x.waterGrid})` : "invalid"}</span></div>
              <div>Cam mode: <span className="text-ocean-100">{x.cameraMode}</span></div>
              <div className="col-span-2">Player pos: <span className="text-ocean-100">({x.playerPos[0].toFixed(1)}, {x.playerPos[1].toFixed(1)}, {x.playerPos[2].toFixed(1)})</span></div>
              <div className="col-span-2">Cam pos: <span className="text-ocean-100">({x.cameraPos[0].toFixed(1)}, {x.cameraPos[1].toFixed(1)}, {x.cameraPos[2].toFixed(1)})</span></div>
              <div className="col-span-2">Cam target: <span className="text-ocean-100">({x.cameraTarget[0].toFixed(1)}, {x.cameraTarget[1].toFixed(1)}, {x.cameraTarget[2].toFixed(1)})</span></div>
              <div>Heading: <span className="text-ocean-100">{x.heading.toFixed(2)}</span></div>
              <div>Pitch: <span className="text-ocean-100">{x.pitch.toFixed(2)}</span></div>
              <div className="col-span-2">Keys: <span className="text-ocean-100">[{x.keys}]</span></div>
              </>); })()}
            </div>
          ) : (
            <div className="text-ocean-500 text-xs italic">Waiting for renderer stats...</div>
          )}
        </div>

        {/* Collision Log */}
        <div>
          <h3 className="text-ocean-200 font-semibold text-sm mb-2 uppercase tracking-wide">Collisions</h3>
          <div className="border border-ocean-700/50 rounded-lg p-3 bg-ocean-900/40">
            {collisionLog.length === 0 ? (
              <div className="text-ocean-500 text-xs italic">No collisions recorded yet...</div>
            ) : (
              collisionLog.map((entry) => (
                <CollisionRow key={entry.label} entry={entry} />
              ))
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
