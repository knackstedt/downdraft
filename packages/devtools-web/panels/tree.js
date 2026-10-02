// Generic tree panel (scene graph / DOM / ECS entities).
import { call, on } from "/app.js";

export function initTreePanel(root, rpcMethod, event, hasModeSwitch = false) {
  root.innerHTML = `
    <div class="panel-toolbar">
      <button data-act="refresh">Refresh</button>
      ${hasModeSwitch ? `
        <select class="mode">
          <option value="scene">Scene graph</option>
          <option value="ecs">ECS entities</option>
        </select>` : ""}
      <span class="spacer"></span>
      <span class="count"></span>
    </div>
    <div class="tree"></div>`;

  const treeEl = root.querySelector(".tree");
  const countEl = root.querySelector(".count");
  const modeSel = root.querySelector(".mode");

  const render = (nodes) => {
    countEl.textContent = `${nodes?.length ?? 0} nodes`;
    treeEl.innerHTML = "";
    if (!nodes || nodes.length === 0) {
      treeEl.innerHTML = `<div class="empty-note">no nodes</div>`;
      return;
    }
    const frag = document.createDocumentFragment();
    nodes.forEach((n) => {
      const div = document.createElement("div");
      div.className = "tree-row";
      div.style.paddingLeft = `${4 + n.depth * 14}px`;
      const label = document.createElement("span");
      label.textContent = (n.childCount > 0 ? "▸ " : "  ") + n.label;
      div.appendChild(label);
      if (n.detail) {
        const d = document.createElement("span");
        d.className = "detail";
        d.textContent = n.detail;
        div.appendChild(d);
      }
      if (n.childCount > 0) {
        const k = document.createElement("span");
        k.className = "kids";
        k.textContent = ` (${n.childCount})`;
        div.appendChild(k);
      }
      frag.appendChild(div);
    });
    treeEl.appendChild(frag);
  };

  const refresh = async () => {
    try { render(await call(rpcMethod, modeSel ? { mode: modeSel.value } : {})); }
    catch (e) { treeEl.innerHTML = `<div class="status-banner error">${e}</div>`; }
  };

  const off = on(event, render);
  root.querySelector('[data-act="refresh"]').onclick = refresh;
  if (modeSel) {
    modeSel.onchange = async () => {
      try { await call("domTree.mode", { mode: modeSel.value }); } catch { /* noop */ }
      refresh();
    };
  }
  refresh();
  return () => off();
}
