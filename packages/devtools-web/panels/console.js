// Console panel: streamed log/console entries + per-thread REPL eval.
import { call, on } from "/app.js";

const MAX_ROWS = 2000;

export function initConsolePanel(root) {
  root.innerHTML = `
    <div class="panel-toolbar">
      <button data-act="clear">Clear</button>
      <span class="spacer"></span>
      <select class="flt">
        <option value="0">All</option><option value="1">Info+</option>
        <option value="2">Warn+</option><option value="3">Errors</option>
      </select>
    </div>
    <div class="console-log"></div>
    <div class="console-repl">
      <select class="repl-thread"><option value="main">main</option></select>
      <input class="repl-input" placeholder="evaluate JS (⏎ to run)" spellcheck="false">
    </div>`;

  const logEl = root.querySelector(".console-log");
  const repl = root.querySelector(".repl-input");
  const threadSel = root.querySelector(".repl-thread");
  const filter = root.querySelector(".flt");
  let minSev = 0;
  const rows = [];

  const addRow = (e) => {
    const div = document.createElement("div");
    div.className = `console-row sev-${e.severity ?? 0}`;
    const th = document.createElement("span");
    th.className = "th";
    th.textContent = `[${e.thread ?? "main"}]`;
    div.appendChild(th);
    div.appendChild(document.createTextNode(e.text ?? ""));
    div.dataset.sev = e.severity ?? 0;
    if ((e.severity ?? 0) < minSev) div.style.display = "none";
    logEl.appendChild(div);
    rows.push(div);
    if (rows.length > MAX_ROWS) rows.shift().remove();
    logEl.scrollTop = logEl.scrollHeight;
  };

  const offConsole = on("console", addRow);
  const offClear = on("console.clear", () => { logEl.innerHTML = ""; rows.length = 0; });
  const offThreads = on("threads", (threads) => {
    const cur = threadSel.value;
    threadSel.innerHTML = "";
    (threads ?? []).forEach((t) => {
      const o = document.createElement("option");
      o.value = t.id; o.textContent = t.name;
      threadSel.appendChild(o);
    });
    if ([...threadSel.options].some((o) => o.value === cur)) threadSel.value = cur;
  });

  root.querySelector('[data-act="clear"]').onclick = () => call("console.clear");
  filter.onchange = () => {
    minSev = Number(filter.value);
    rows.forEach((r) => { r.style.display = Number(r.dataset.sev) >= minSev ? "" : "none"; });
  };

  const history = [];
  let histIdx = -1;
  repl.onkeydown = async (ev) => {
    if (ev.key === "Enter" && repl.value.trim()) {
      const expr = repl.value;
      history.push(expr); histIdx = history.length;
      repl.value = "";
      addRow({ text: `> ${expr}`, severity: 0, thread: threadSel.value });
      try {
        const res = await call("eval", { thread: threadSel.value, expr });
        if (res?.error) addRow({ text: res.error, severity: 3, thread: threadSel.value });
        else addRow({
          text: typeof res?.result === "string" ? res.result : JSON.stringify(res?.result, null, 2),
          severity: 0, thread: threadSel.value,
        });
      } catch (e) {
        addRow({ text: String(e), severity: 3, thread: "devtools" });
      }
    } else if (ev.key === "ArrowUp" && histIdx > 0) {
      repl.value = history[--histIdx]; ev.preventDefault();
    } else if (ev.key === "ArrowDown" && histIdx < history.length - 1) {
      repl.value = history[++histIdx]; ev.preventDefault();
    }
  };

  return () => { offConsole(); offClear(); offThreads(); };
}
