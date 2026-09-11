// ============================================================================
// console-panel.ts — Console panel with REPL + thread selection + filtering.
//
// Features:
// - Thread selector dropdown (main + all worker threads)
// - Severity filter (All/Errors/Warnings/Info) + thread filter
// - Scrollable log list with timestamps, severity colors, thread tags
// - REPL input field at the bottom (click to focus, type, Enter to evaluate)
// - Command history (Up/Down arrows)
// - Clear button
// ============================================================================

import { Container, Graphics } from "pixi.js";
import type { DebuggerScene } from "../debugger-scene";
import { BG_DARK, BG_INPUT, BG_PANEL, COLOR_BLUE, COLOR_BORDER, COLOR_GREEN, COLOR_RED, COLOR_TEXT, COLOR_TEXT_BRIGHT, COLOR_TEXT_DIM, COLOR_YELLOW, SEVERITY_COLORS, THREAD_COLORS } from "../shared/colors";
import { formatTime, makeButton, makeLabel, makeScrollPanel } from "../shared/widgets";

const REPL_HEIGHT = 28;
const FILTER_BAR_HEIGHT = 32;
const THREAD_DROPDOWN_HEIGHT = 180;

export function renderConsolePanel(scene: DebuggerScene, x: number, y: number, w: number, h: number): Container {
  const c = new Container();
  c.x = x;
  c.y = y;
  const ctx = scene.getContext();
  const hits = scene.getHits();
  const filter = scene.getConsoleFilter();
  const threadFilter = scene.getConsoleThreadFilter();
  const selectedThread = scene.getConsoleSelectedThread();
  const threads = scene.getThreads();
  const replInput = scene.getConsoleReplInput();
  const isFocused = scene.getFocusedWidget() === "console-repl";

  // ── Filter bar (top) ──
  const filterBar = new Graphics();
  filterBar.rect(0, 0, w, FILTER_BAR_HEIGHT);
  filterBar.fill({ color: BG_DARK, alpha: 0.95 });
  filterBar.rect(0, FILTER_BAR_HEIGHT - 1, w, 1);
  filterBar.fill({ color: COLOR_BORDER, alpha: 0.5 });
  c.addChild(filterBar);

  // Thread selector button (shows current thread, click to open dropdown)
  const threadLabel = threads.find((t) => t.id === selectedThread)?.name ?? "main";
  const threadBtnW = 90;
  c.addChild(makeButton({
    label: `▸ ${threadLabel}`, x: 4, y: 4, width: threadBtnW, height: 22,
    color: isThreadDropdownOpen(scene) ? COLOR_GREEN : COLOR_TEXT, active: isThreadDropdownOpen(scene), fontSize: 10,
  }, hits, () => toggleThreadDropdown(scene)));

  // Thread dropdown (if open)
  if (isThreadDropdownOpen(scene)) {
    drawThreadDropdown(c, scene, hits, 4, FILTER_BAR_HEIGHT + 2, threadBtnW, threads, w);
  }

  // Severity filter buttons
  const filters = [
    { id: "all", label: "All", color: COLOR_TEXT },
    { id: "error", label: "Errors", color: COLOR_RED },
    { id: "warn", label: "Warnings", color: COLOR_YELLOW },
    { id: "info", label: "Info", color: COLOR_BLUE },
  ];
  let fx = 4 + threadBtnW + 8;
  for (const f of filters) {
    const isActive = filter === f.id;
    const btn = makeButton({
      label: f.label, x: fx, y: 4, width: 64, height: 22,
      color: isActive ? COLOR_GREEN : f.color, active: isActive, fontSize: 10,
    }, hits, () => scene.setConsoleFilter(f.id));
    c.addChild(btn);
    fx += 68;
  }

  // Clear button (right side)
  const clearBtn = makeButton({
    label: "Clear", x: w - 70, y: 4, width: 60, height: 22,
    color: COLOR_RED, fontSize: 10,
  }, hits, () => { ctx.cdp.clear(); scene.clearConsoleReplResults(); });
  c.addChild(clearBtn);

  // ── Log entries ──
  const entries = ctx.cdp.getEntries();
  const exceptions = ctx.cdp.getExceptions();
  const replResults = scene.getConsoleReplResults();

  type LogItem = {
    id: number;
    type: string;
    text: string;
    timestamp: number;
    stack?: string;
    source: string;
    thread: string;
    isRepl: boolean;
    isError: boolean;
  };

  const items: LogItem[] = [];
  for (const e of entries) {
    items.push({ id: e.id, type: e.type, text: e.text, timestamp: e.timestamp, source: "console", thread: "main", isRepl: false, isError: false });
  }
  for (const ex of exceptions) {
    items.push({ id: ex.id, type: "error", text: ex.text, timestamp: ex.timestamp, stack: ex.stack, source: "exception", thread: "main", isRepl: false, isError: true });
  }
  for (const r of replResults) {
    items.push({ id: -r.timestamp, type: r.isError ? "error" : "log", text: r.text, timestamp: r.timestamp, source: "repl", thread: selectedThread, isRepl: true, isError: r.isError });
  }
  items.sort((a, b) => a.timestamp - b.timestamp);

  // Apply filters
  const filtered = items.filter((item) => {
    if (filter === "error" && item.type !== "error") return false;
    if (filter === "warn" && item.type !== "warn" && item.type !== "warning") return false;
    if (filter === "info" && item.type !== "info" && item.type !== "log" && item.type !== "debug") return false;
    if (threadFilter !== "all" && item.thread !== threadFilter && !item.isRepl) return false;
    return true;
  });

  const display = filtered.slice(-300);

  // ── Scrollable log area ──
  const contentY = FILTER_BAR_HEIGHT + 2;
  const contentH = h - contentY - REPL_HEIGHT - 4;
  const rowH = 18;
  const contentHeight = display.length * rowH + 20;
  const scrollY = scene.getScrollY("console");
  const scroll = makeScrollPanel({ x: 0, y: contentY, width: w, height: contentH, contentHeight, scrollY, hits });
  c.addChild(scroll.container);
  const content = scroll.content;

  // Header row
  content.addChild(makeLabel("Time", 4, 2, COLOR_TEXT_DIM, 9));
  content.addChild(makeLabel("Thread", 70, 2, COLOR_TEXT_DIM, 9));
  content.addChild(makeLabel("Message", 130, 2, COLOR_TEXT_DIM, 9));

  let ry = 18;
  for (const item of display) {
    const color = item.isRepl
      ? (item.isError ? COLOR_RED : COLOR_GREEN)
      : (SEVERITY_COLORS[item.type] ?? COLOR_TEXT);

    // Zebra striping
    if (Math.floor(ry / rowH) % 2 === 0) {
      const zebra = new Graphics();
      zebra.rect(0, ry, w, rowH);
      zebra.fill({ color: 0x111122, alpha: 0.3 });
      content.addChild(zebra);
    }

    // REPL results get a subtle background
    if (item.isRepl) {
      const replBg = new Graphics();
      replBg.rect(0, ry, w, rowH);
      replBg.fill({ color: item.isError ? 0x331111 : 0x113311, alpha: 0.25 });
      content.addChild(replBg);
    }

    // Time
    content.addChild(makeLabel(formatTime(item.timestamp).slice(0, 12), 4, ry + 2, COLOR_TEXT_DIM, 9));
    // Thread tag (colored)
    const threadColor = THREAD_COLORS[Math.abs(hashStr(item.thread)) % THREAD_COLORS.length];
    content.addChild(makeLabel(item.thread.slice(0, 8), 70, ry + 2, threadColor, 9));
    // Message (truncate to fit)
    const maxLen = Math.floor((w - 140) / 6);
    const text = item.text.length > maxLen ? item.text.slice(0, maxLen) + "…" : item.text;
    content.addChild(makeLabel(text, 130, ry + 2, color, 9));

    // Click to expand stack (if has stack)
    if (item.stack) {
      hits.add(0, ry, w, rowH, () => {
        console.log(`[Stack for #${item.id}]\n${item.stack}`);
      });
    }

    ry += rowH;
  }

  // Empty state
  if (display.length === 0) {
    content.addChild(makeLabel("No console entries. Type below to evaluate expressions.", 10, 30, COLOR_TEXT_DIM, 10));
    content.addChild(makeLabel("CDP captures console.log/warn/error from the main isolate.", 10, 46, COLOR_TEXT_DIM, 9));
    content.addChild(makeLabel("Worker threads are evaluated via __devtoolsEval RPC.", 10, 60, COLOR_TEXT_DIM, 9));
  }

  // Pop the scroll panel's hit offset.
  hits.popOffset();

  // ── REPL input bar (bottom) ──
  drawReplInput(c, scene, hits, 0, h - REPL_HEIGHT, w, REPL_HEIGHT, replInput, isFocused, selectedThread, threads);

  return c;
}

// ── REPL input bar ──

function drawReplInput(
  c: Container, scene: DebuggerScene, hits: any,
  x: number, y: number, w: number, h: number,
  input: string, isFocused: boolean,
  selectedThread: string, threads: any[],
): void {
  // Background
  const bg = new Graphics();
  bg.rect(x, y, w, h);
  bg.fill({ color: BG_DARK, alpha: 0.95 });
  bg.rect(x, y, w, 1);
  bg.fill({ color: COLOR_BORDER, alpha: 0.5 });
  c.addChild(bg);

  // Prompt symbol
  const promptColor = threads.find((t) => t.id === selectedThread)?.kind === "main" ? COLOR_GREEN : COLOR_YELLOW;
  c.addChild(makeLabel(">", x + 6, y + 6, promptColor, 12));

  // Input field background
  const inputX = x + 22;
  const inputW = w - 28;
  const inputBg = new Graphics();
  inputBg.roundRect(inputX, y + 4, inputW, h - 8, 3);
  inputBg.fill({ color: BG_INPUT, alpha: 0.95 });
  inputBg.stroke({ color: isFocused ? COLOR_GREEN : COLOR_BORDER, width: 1 });
  c.addChild(inputBg);

  // Input text (or placeholder)
  const displayText = input || (isFocused ? "" : "Click to evaluate expressions...");
  const textColor = input ? COLOR_TEXT_BRIGHT : COLOR_TEXT_DIM;
  c.addChild(makeLabel(displayText, inputX + 6, y + 7, textColor, 11));

  // Cursor (if focused)
  if (isFocused) {
    const cursorX = inputX + 6 + (input ? input.length * 7 : 0);
    const cursor = new Graphics();
    cursor.rect(cursorX, y + 6, 2, h - 12);
    cursor.fill({ color: COLOR_GREEN, alpha: 0.8 });
    c.addChild(cursor);
  }

  // Click to focus
  hits.add(inputX, y + 4, inputW, h - 8, () => {
    scene.setFocus("console-repl");
    // Register text input handler
    scene.setTextInputHandler({
      onText: (text: string) => {
        const current = scene.getConsoleReplInput();
        scene.setConsoleReplInput(current + text);
      },
      onKey: (key: string, _keyCode: number) => {
        const current = scene.getConsoleReplInput();
        if (key === "Backspace") {
          scene.setConsoleReplInput(current.slice(0, -1));
        } else if (key === "Enter") {
          scene.executeRepl(current);
          scene.setConsoleReplInput("");
        } else if (key === "ArrowUp") {
          const history = scene.getConsoleReplHistory();
          const idx = scene.getConsoleReplHistoryIdx();
          if (history.length === 0) return;
          const newIdx = idx < 0 ? history.length - 1 : Math.max(0, idx - 1);
          scene.setConsoleReplHistoryIdx(newIdx);
          scene.setConsoleReplInput(history[newIdx] ?? "");
        } else if (key === "ArrowDown") {
          const history = scene.getConsoleReplHistory();
          const idx = scene.getConsoleReplHistoryIdx();
          if (idx < 0) return;
          const newIdx = idx + 1;
          if (newIdx >= history.length) {
            scene.setConsoleReplHistoryIdx(-1);
            scene.setConsoleReplInput("");
          } else {
            scene.setConsoleReplHistoryIdx(newIdx);
            scene.setConsoleReplInput(history[newIdx]);
          }
        }
      },
    });
  });
}

// ── Thread dropdown ──

function drawThreadDropdown(
  c: Container, scene: DebuggerScene, hits: any,
  x: number, y: number, btnW: number, threads: any[], panelW: number,
): void {
  const dropdownW = Math.max(btnW, 160);
  const dropdownH = Math.min(THREAD_DROPDOWN_HEIGHT, threads.length * 22 + 8);

  // Background
  const bg = new Graphics();
  bg.roundRect(x, y, dropdownW, dropdownH, 4);
  bg.fill({ color: BG_PANEL, alpha: 0.98 });
  bg.stroke({ color: COLOR_BORDER, width: 1 });
  c.addChild(bg);

  // Header
  c.addChild(makeLabel("Select Thread", x + 6, y + 4, COLOR_TEXT_DIM, 9));

  // Thread options
  const selected = scene.getConsoleSelectedThread();
  let ty = y + 22;
  for (const thread of threads) {
    const isSelected = thread.id === selected;
    const color = THREAD_COLORS[Math.abs(hashStr(thread.id)) % THREAD_COLORS.length];

    // Row background (selected)
    if (isSelected) {
      const sel = new Graphics();
      sel.rect(x + 2, ty - 2, dropdownW - 4, 20);
      sel.fill({ color: 0x3a3a5c, alpha: 0.8 });
      c.addChild(sel);
    }

    // Thread color dot
    const dot = new Graphics();
    dot.circle(x + 10, ty + 6, 3);
    dot.fill({ color });
    c.addChild(dot);

    // Thread name + kind
    const label = `${thread.name} (${thread.kind})`;
    c.addChild(makeLabel(label, x + 20, ty, isSelected ? COLOR_TEXT_BRIGHT : COLOR_TEXT, 10));

    // Click handler
    hits.add(x + 2, ty - 2, dropdownW - 4, 20, () => {
      scene.setConsoleSelectedThread(thread.id);
      scene.setConsoleThreadFilter(thread.id);
      // Close dropdown
      scene["_threadDropdownOpen"] = false;
    });

    ty += 20;
  }

  // "All threads" option at the bottom
  const allSelected = scene.getConsoleThreadFilter() === "all";
  if (allSelected) {
    const sel = new Graphics();
    sel.rect(x + 2, ty - 2, dropdownW - 4, 20);
    sel.fill({ color: 0x3a3a5c, alpha: 0.8 });
    c.addChild(sel);
  }
  c.addChild(makeLabel("All threads (filter)", x + 20, ty, allSelected ? COLOR_TEXT_BRIGHT : COLOR_TEXT, 10));
  hits.add(x + 2, ty - 2, dropdownW - 4, 20, () => {
    scene.setConsoleThreadFilter("all");
    scene["_threadDropdownOpen"] = false;
  });
}

// ── Helpers ──

function isThreadDropdownOpen(scene: DebuggerScene): boolean {
  return (scene as any)._threadDropdownOpen === true;
}

function toggleThreadDropdown(scene: DebuggerScene): void {
  (scene as any)._threadDropdownOpen = !isThreadDropdownOpen(scene);
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h;
}
