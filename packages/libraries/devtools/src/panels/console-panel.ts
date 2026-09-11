// ============================================================================
// console-panel.ts — Console panel backed by CDP Runtime.consoleAPICalled.
//
// Renders a scrollable log list with severity-colored rows, a filter bar
// (All/Errors/Warnings/Info), a Clear button, and a search field. Click
// handling: filter buttons, clear button, row click to expand stack trace.
// ============================================================================

import { Container, Graphics } from "pixi.js";
import type { DebuggerScene } from "../debugger-scene";
import { COLOR_BLUE, COLOR_GREEN, COLOR_RED, COLOR_TEXT, COLOR_TEXT_DIM, COLOR_YELLOW, SEVERITY_COLORS } from "../shared/colors";
import { formatTime, makeButton, makeLabel, makeScrollPanel } from "../shared/widgets";

export function renderConsolePanel(scene: DebuggerScene, x: number, y: number, w: number, h: number): Container {
  const c = new Container();
  c.x = x;
  c.y = y;
  const ctx = scene.getContext();
  const hits = scene.getHits();
  const filter = scene.getConsoleFilter();

  // ── Filter bar (top) ──
  const filterBar = new Graphics();
  filterBar.rect(0, 0, w, 30);
  filterBar.fill({ color: 0x111122, alpha: 0.95 });
  c.addChild(filterBar);

  // Filter buttons
  const filters = [
    { id: "all", label: "All", color: COLOR_TEXT },
    { id: "error", label: "Errors", color: COLOR_RED },
    { id: "warn", label: "Warnings", color: COLOR_YELLOW },
    { id: "info", label: "Info", color: COLOR_BLUE },
  ];
  let fx = 8;
  for (const f of filters) {
    const isActive = filter === f.id;
    const btn = makeButton({
      label: f.label, x: fx, y: 4, width: 70, height: 22,
      color: isActive ? COLOR_GREEN : f.color, active: isActive, fontSize: 11,
    }, hits, () => scene.setConsoleFilter(f.id));
    c.addChild(btn);
    fx += 76;
  }

  // Clear button (right side)
  const clearBtn = makeButton({
    label: "Clear", x: w - 80, y: 4, width: 70, height: 22,
    color: COLOR_RED, fontSize: 11,
  }, hits, () => { ctx.cdp.clear(); });
  c.addChild(clearBtn);

  // ── Log entries ──
  const entries = ctx.cdp.getEntries();
  const exceptions = ctx.cdp.getExceptions();

  // Merge console entries + exceptions into a single sorted list
  type LogItem = {
    id: number;
    type: string;
    text: string;
    timestamp: number;
    stack?: string;
    source: string;
  };
  const items: LogItem[] = [];
  for (const e of entries) {
    items.push({ id: e.id, type: e.type, text: e.text, timestamp: e.timestamp, source: "console" });
  }
  for (const ex of exceptions) {
    items.push({ id: ex.id, type: "error", text: ex.text, timestamp: ex.timestamp, stack: ex.stack, source: "exception" });
  }
  items.sort((a, b) => a.timestamp - b.timestamp);

  // Apply filter
  const filtered = items.filter((item) => {
    if (filter === "all") return true;
    if (filter === "error") return item.type === "error";
    if (filter === "warn") return item.type === "warn" || item.type === "warning";
    if (filter === "info") return item.type === "info" || item.type === "log" || item.type === "debug";
    return true;
  });

  // Show newest last (reverse for display: newest at bottom like a console)
  const display = filtered.slice(-200); // cap to 200 rows for performance

  // ── Scrollable log area ──
  const contentY = 34;
  const contentH = h - contentY - 4;
  const rowH = 18;
  const contentHeight = display.length * rowH + 10;
  const scrollY = scene.getScrollY("console");
  const scroll = makeScrollPanel({ x: 0, y: contentY, width: w, height: contentH, contentHeight, scrollY, hits });
  c.addChild(scroll.container);
  const content = scroll.content;

  // Header row
  content.addChild(makeLabel("Time", 4, 2, COLOR_TEXT_DIM, 10));
  content.addChild(makeLabel("Level", 90, 2, COLOR_TEXT_DIM, 10));
  content.addChild(makeLabel("Message", 150, 2, COLOR_TEXT_DIM, 10));

  let ry = 18;
  for (const item of display) {
    const color = SEVERITY_COLORS[item.type] ?? COLOR_TEXT;

    // Zebra striping
    if (ry % (rowH * 2) === 0) {
      const zebra = new Graphics();
      zebra.rect(0, ry, w, rowH);
      zebra.fill({ color: 0x111122, alpha: 0.3 });
      content.addChild(zebra);
    }

    // Time
    content.addChild(makeLabel(formatTime(item.timestamp).slice(0, 12), 4, ry + 2, COLOR_TEXT_DIM, 10));
    // Level
    content.addChild(makeLabel(item.type.toUpperCase().slice(0, 5), 90, ry + 2, color, 10));
    // Message (truncate to fit)
    const maxLen = Math.floor((w - 160) / 6);
    const text = item.text.length > maxLen ? item.text.slice(0, maxLen) + "…" : item.text;
    content.addChild(makeLabel(text, 150, ry + 2, color, 10));

    // Click to expand stack (if has stack)
    if (item.stack) {
      hits.add(0, ry, w, rowH, () => {
        // Toggle: append stack to console as a new entry
        console.log(`[Stack for #${item.id}]\n${item.stack}`);
      });
    }

    ry += rowH;
  }

  // Empty state
  if (display.length === 0) {
    content.addChild(makeLabel("No console entries. CDP captures console.log/warn/error from the main isolate.", 10, 30, COLOR_TEXT_DIM, 11));
  }

  // CDP status indicator
  const cdpStatus = ctx.cdp.isAvailable ? "CDP: connected" : "CDP: unavailable";
  content.addChild(makeLabel(cdpStatus, 10, Math.max(ry + 4, 40), COLOR_GREEN, 10));
  content.addChild(makeLabel(`Entries: ${entries.length} | Exceptions: ${exceptions.length} | Showing: ${display.length}`, 10, Math.max(ry + 20, 56), COLOR_TEXT_DIM, 10));

  // Pop the scroll panel's hit offset.
  hits.popOffset();

  return c;
}
