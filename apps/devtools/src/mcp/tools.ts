// ============================================================================
// tools.ts — platinum-devtools MCP toolset.
//
// Standard automation comes from createGameMcp; these are the devtools tools
// that make the viewer fully agent-drivable — the thing Chrome DevTools
// can't do.
// ============================================================================

import type { GameContext } from "@downdraft/engine/app/main";
import type { McpToolRegistration } from "@downdraft/engine/app/main";
import { jsonResult, errorResult } from "@downdraft/engine/app/main";
import { sessions, feedServer } from "../targets/runtime";
import { importArtifact } from "../targets/artifacts";
import { store } from "../app/store";

function session(params: Record<string, unknown>) {
  const id = params.target as string | undefined;
  const s = id ? sessions.sessionById(id) : sessions.active();
  if (!s) throw new Error("no target attached");
  return s;
}

export function mountMcpTools(_ctx: GameContext): McpToolRegistration[] {
  return [
    {
      def: {
        name: "target_list",
        description: "List discovered devtools targets (downdraft apps, agents, CDP endpoints) with channel/capability status.",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => jsonResult([...sessions.sessions.values()].map((s) => ({
        id: s.id, pid: s.pid, name: s.name, status: s.status,
        channels: s.channelFlags(), caps: [...s.caps],
        panels: s.providers.map((p) => p.name),
        threads: s.threads,
      }))),
    },
    {
      def: {
        name: "target_attach",
        description: "Attach to a target by pid (downdraft app), or explicit endpoints (cdpUrl/mirrorUrl/mcpPort).",
        inputSchema: {
          type: "object",
          properties: {
            target: { type: "string", description: "session id like pid-33827" },
            pid: { type: "number" },
            cdpUrl: { type: "string", description: "ws://… CDP endpoint" },
            mirrorUrl: { type: "string", description: "ws://… devtools mirror endpoint" },
            mcpPort: { type: "number" }, mcpToken: { type: "string" },
          },
        },
      },
      handler: async (params) => {
        const pid = (params.pid as number | undefined)
          ?? (params.target ? Number(String(params.target).replace("pid-", "")) : undefined);
        if (pid === undefined && !params.cdpUrl && !params.mirrorUrl && !params.mcpPort) {
          return jsonResult({ error: "pass pid, target, or an explicit endpoint" });
        }
        const s = sessions.attachManual({
          pid,
          cdpUrl: params.cdpUrl as string | undefined,
          mirrorUrl: params.mirrorUrl as string | undefined,
          mcpPort: params.mcpPort as number | undefined,
          mcpToken: params.mcpToken as string | undefined,
        });
        return jsonResult({ id: s.id, pid: s.pid, status: s.status });
      },
    },
    {
      def: {
        name: "target_detach",
        description: "Detach from a target by id or pid.",
        inputSchema: { type: "object", properties: { target: { type: "string" }, pid: { type: "number" } } },
      },
      handler: async (params) => {
        const pid = (params.pid as number) ?? Number(String(params.target ?? "").replace("pid-", ""));
        sessions.detach(pid);
        return jsonResult({ detached: pid });
      },
    },
    {
      def: {
        name: "target_info",
        description: "Full status of one target: channels, caps, threads, providers, inspector methods.",
        inputSchema: { type: "object", properties: { target: { type: "string" } } },
      },
      handler: async (params) => {
        const s = session(params);
        return jsonResult({
          id: s.id, pid: s.pid, name: s.name, status: s.status,
          channels: s.channelFlags(), caps: [...s.caps],
          providers: s.providers, inspectorMethods: s.inspectorMethods,
          threads: s.threads, plugins: s.plugins,
          profiling: s.profiling,
        });
      },
    },
    {
      def: {
        name: "console_eval",
        description: "Evaluate a JS expression in the target (CDP Runtime.evaluate preferred, mirror eval fallback). Supports top-level await.",
        inputSchema: {
          type: "object", required: ["expr"],
          properties: {
            expr: { type: "string" },
            target: { type: "string" },
            thread: { type: "string", description: "thread id (default main)" },
          },
        },
      },
      handler: async (params) => {
        const s = session(params);
        return jsonResult(await s.eval(String(params.expr), String(params.thread ?? "main"), { awaitPromise: true }));
      },
    },
    {
      def: {
        name: "console_entries",
        description: "Recent console entries for a target — filter by severity/thread/text.",
        inputSchema: {
          type: "object",
          properties: {
            target: { type: "string" },
            severity: { type: "number", description: "minimum severity 0-5" },
            thread: { type: "string" },
            match: { type: "string", description: "substring/regex match" },
            limit: { type: "number" },
          },
        },
      },
      handler: async (params) => {
        const s = session(params);
        let list = s.consoleEntries;
        if (params.severity !== undefined) list = list.filter((e) => e.severity >= Number(params.severity));
        if (params.thread) list = list.filter((e) => e.thread === params.thread);
        if (params.match) {
          const re = new RegExp(String(params.match), "i");
          list = list.filter((e) => re.test(e.text));
        }
        const limit = Math.min(Number(params.limit ?? 100), 2000);
        return jsonResult(list.slice(-limit));
      },
    },
    {
      def: {
        name: "console_clear",
        description: "Clear the console buffer for a target (also clears target-side console via mirror).",
        inputSchema: { type: "object", properties: { target: { type: "string" } } },
      },
      handler: async (params) => {
        const s = session(params);
        await s.consoleClear();
        return jsonResult({ cleared: true });
      },
    },
    {
      def: {
        name: "metrics_snapshot",
        description: "Instant metric snapshot per series (latest value per series id) plus series metadata.",
        inputSchema: { type: "object", properties: { target: { type: "string" } } },
      },
      handler: async (params) => {
        const s = session(params);
        const out = [...s.series.values()].map((m) => ({
          id: m.id, label: m.label, unit: m.unit, group: m.group,
          latest: m.v[m.v.length - 1], min: m.min, max: m.max, points: m.v.length,
        }));
        return jsonResult(out);
      },
    },
    {
      def: {
        name: "profile_start",
        description: "Start CPU profiling on the target (CDP Profiler or mirror profile.start).",
        inputSchema: { type: "object", properties: { target: { type: "string" } } },
      },
      handler: async (params) => jsonResult({ started: await session(params).profileStart() }),
    },
    {
      def: {
        name: "profile_stop",
        description: "Stop CPU profiling; returns the captured profile summary.",
        inputSchema: { type: "object", properties: { target: { type: "string" } } },
      },
      handler: async (params) => {
        const s = session(params);
        const prof = await s.profileStop();
        const last = prof ?? s.profiles[s.profiles.length - 1];
        return jsonResult(last
          ? { nodes: last.nodes.length, samples: last.samples.length, us: last.endUs - last.startUs, source: last.source }
          : { error: "no profile" });
      },
    },
    {
      def: {
        name: "profile_result",
        description: "Get the last captured CPU profile (nodes+samples).",
        inputSchema: { type: "object", properties: { target: { type: "string" }, index: { type: "number" } } },
      },
      handler: async (params) => {
        const s = session(params);
        const i = Number(params.index ?? s.profiles.length - 1);
        const p = s.profiles[i];
        return p ? jsonResult(p) : errorResult("no profile captured");
      },
    },
    {
      def: {
        name: "heap_capture",
        description: "Trigger a heap snapshot on the target (agent jsc) and return the summary.",
        inputSchema: { type: "object", properties: { target: { type: "string" } } },
      },
      handler: async (params) => {
        const s = session(params);
        await s.heapSnapshot();
        await new Promise((r) => setTimeout(r, 800));
        const last = s.heapSnapshots[s.heapSnapshots.length - 1];
        return last ? jsonResult(last) : errorResult("no heap snapshot — target has no agent");
      },
    },
    {
      def: {
        name: "heap_latest",
        description: "Latest heap snapshot summary (top constructor classes) for the target.",
        inputSchema: { type: "object", properties: { target: { type: "string" } } },
      },
      handler: async (params) => {
        const s = session(params);
        const last = s.heapSnapshots[s.heapSnapshots.length - 1];
        return last ? jsonResult(last) : errorResult("no heap snapshot — use feed/agent to capture one");
      },
    },
    {
      def: {
        name: "network_events",
        description: "Recent network events for the target.",
        inputSchema: { type: "object", properties: { target: { type: "string" }, limit: { type: "number" } } },
      },
      handler: async (params) => {
        const s = session(params);
        return jsonResult(s.network.slice(-Math.min(Number(params.limit ?? 100), 1000)));
      },
    },
    {
      def: {
        name: "panel_list",
        description: "List provider/custom panels a target exposes.",
        inputSchema: { type: "object", properties: { target: { type: "string" } } },
      },
      handler: async (params) => jsonResult(session(params).providers),
    },
    {
      def: {
        name: "panel_snapshot",
        description: "Fetch a provider panel snapshot (kv/table/series/lines/controls sections).",
        inputSchema: { type: "object", required: ["panel"], properties: { target: { type: "string" }, panel: { type: ["string", "number"] } } },
      },
      handler: async (params) => jsonResult(await session(params).snapshot(params.panel as string | number)),
    },
    {
      def: {
        name: "panel_command",
        description: "Dispatch a provider panel control command (button/checkbox/slider action).",
        inputSchema: {
          type: "object", required: ["panel", "action"],
          properties: { target: { type: "string" }, panel: { type: ["string", "number"] }, action: { type: "string" }, payload: { type: "string" } },
        },
      },
      handler: async (params) => {
        await session(params).panelCommand(params.panel as string | number, String(params.action), String(params.payload ?? ""));
        return jsonResult({ ok: true });
      },
    },
    {
      def: {
        name: "plugin_list",
        description: "List detected downdraft plugins/mods on a target (via its MCP plugin_* tools).",
        inputSchema: { type: "object", properties: { target: { type: "string" } } },
      },
      handler: async (params) => {
        const s = session(params);
        await s.refreshPlugins();
        return jsonResult(s.plugins);
      },
    },
    {
      def: {
        name: "target_mcp_call",
        description: "Call an arbitrary MCP tool on the target's own automation server.",
        inputSchema: {
          type: "object", required: ["tool"],
          properties: { target: { type: "string" }, tool: { type: "string" }, args: { type: "object" } },
        },
      },
      handler: async (params) => jsonResult(await session(params).mcpCall(String(params.tool), (params.args as Record<string, unknown>) ?? {})),
    },
    {
      def: {
        name: "artifact_import",
        description: "Import a profiler artifact file: .cpuprofile/.heapsnapshot/JSC heap snapshot/trace/folded stacks.",
        inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" }, target: { type: "string" } } },
      },
      handler: async (params) => {
        const s = session(params);
        const a = importArtifact(String(params.path));
        if (a.profile) s.profiles.push(a.profile);
        if (a.heap) s.heapSnapshots.push(a.heap);
        (a.network ?? []).forEach((n) => s.pushNetworkEvent(n));
        s.markEvent("snapshot", a.summary);
        return jsonResult({ kind: a.kind, summary: a.summary });
      },
    },
    {
      def: {
        name: "feed_info",
        description: "Feed endpoint details for external tools (port + token + discovery file).",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => jsonResult({
        port: feedServer.feedPort,
        token: feedServer.feedToken,
        discovery: "~/.downdraft/platinum-feed.json",
        example: `curl -X POST http://127.0.0.1:${feedServer.feedPort}/feed -H 'Authorization: Bearer <token>' -d '{"type":"metric","series":{"id":"demo.x","label":"demo"},"points":[[${Date.now() / 1000},1]]}'`,
      }),
    },
    {
      def: {
        name: "ui_state_dump",
        description: "Current viewer layout: docks, tabs, targets, rect sizes.",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => {
        const s = store.getState();
        return jsonResult({
          mainTab: s.mainTab, docks: s.docks, uiZoom: s.uiZoom,
          mainRect: s.mainRect, bottomRect: s.bottomRect, rightRect: s.rightRect,
          activeTarget: s.activeTargetId, targets: s.targets.length,
        });
      },
    },
  ];
}
