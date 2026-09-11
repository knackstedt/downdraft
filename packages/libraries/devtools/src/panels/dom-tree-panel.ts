// ============================================================================
// dom-tree-panel.ts — DOM Tree panel showing PIXI scene graph + ECS scene tree.
//
// Toggle between "pixi" mode (the game's PIXI stage tree) and "ecs" mode
// (the ECS entity tree from the sim reader). Uses makeTreeView for the
// collapsible tree and a detail panel on the right for selected nodes.
// ============================================================================

import { Container, Graphics } from "pixi.js";
import type { DebuggerScene } from "../debugger-scene";
import { BG_PANEL, COLOR_GREEN, COLOR_TEXT, COLOR_TEXT_DIM, COLOR_YELLOW } from "../shared/colors";
import { makeButton, makeLabel, makeScrollPanel, makeTreeView, type TreeNodeData } from "../shared/widgets";

export function renderDomTreePanel(scene: DebuggerScene, x: number, y: number, w: number, h: number): Container {
  const c = new Container();
  c.x = x;
  c.y = y;
  const ctx = scene.getContext();
  const hits = scene.getHits();
  const mode = scene.getDomTreeMode();
  const selected = scene.getDomSelected();
  const expanded = scene.getDomExpanded();

  // ── Mode toggle bar ──
  const toggleBar = new Graphics();
  toggleBar.rect(0, 0, w, 30);
  toggleBar.fill({ color: 0x111122, alpha: 0.95 });
  c.addChild(toggleBar);

  c.addChild(makeButton({
    label: "PIXI Scene", x: 8, y: 4, width: 100, height: 22,
    color: mode === "pixi" ? COLOR_GREEN : COLOR_TEXT_DIM, active: mode === "pixi", fontSize: 11,
  }, hits, () => scene.setDomTreeMode("pixi")));

  c.addChild(makeButton({
    label: "ECS Entities", x: 116, y: 4, width: 100, height: 22,
    color: mode === "ecs" ? COLOR_GREEN : COLOR_TEXT_DIM, active: mode === "ecs", fontSize: 11,
  }, hits, () => scene.setDomTreeMode("ecs")));

  // ── Tree view (left, 60%) ──
  const treeW = Math.floor(w * 0.6);
  const treeY = 34;
  const treeH = h - treeY;
  const nodes: TreeNodeData[] = [];

  if (mode === "pixi") {
    const gameStage = ctx.gamePixiUi?.stage;
    if (gameStage) {
      buildPixiTree(gameStage, "stage", 0, nodes, expanded, selected, 50);
    } else {
      nodes.push({ id: "none", label: "No game PixiJS host", detail: "", expanded: false, selected: false, childCount: 0, depth: 0 });
    }
  } else {
    // ECS mode — read entity data from the sim reader
    const renderer = ctx.renderer;
    const simReader = renderer?.getSimReader?.() ?? renderer?.simReader;
    if (simReader?.isValid?.()) {
      const entityCount = simReader.getEntityCount?.() ?? 0;
      const types = simReader.getEntityTypes?.() ?? {};
      nodes.push({
        id: "ecs-root", label: `ECS World (${entityCount} entities)`, detail: "",
        expanded: true, selected: false, childCount: entityCount, depth: 0,
      });
      // Group by type
      for (const [typeId, count] of Object.entries(types)) {
        const typeIdNum = parseInt(typeId, 10);
        const id = `ecs-type-${typeId}`;
        const isExpanded = expanded.has(id);
        nodes.push({
          id, label: `Type ${typeId}`, detail: `(${count})`,
          expanded: isExpanded, selected: false, childCount: count as number, depth: 1,
        });
        if (isExpanded) {
          // List entities of this type (up to 50)
          const entities = simReader.getEntitiesByType?.(typeIdNum) ?? [];
          for (let i = 0; i < Math.min(entities.length, 50); i++) {
            const e = entities[i];
            const eid = `ecs-${typeId}-${i}`;
            nodes.push({
              id: eid, label: `Entity ${e.id ?? i}`,
              detail: `pos=(${e.x?.toFixed(1) ?? 0},${e.y?.toFixed(1) ?? 0},${e.z?.toFixed(1) ?? 0})`,
              expanded: false, selected: selected === eid, childCount: 0, depth: 2,
            });
          }
          if (entities.length > 50) {
            nodes.push({ id: `ecs-${typeId}-more`, label: `... ${entities.length - 50} more`, detail: "", expanded: false, selected: false, childCount: 0, depth: 2 });
          }
        }
      }
    } else {
      nodes.push({ id: "none", label: "Sim reader not valid", detail: "", expanded: false, selected: false, childCount: 0, depth: 0 });
    }
  }

  const scrollY = scene.getScrollY("dom-tree");
  const contentHeight = nodes.length * 18 + 10;
  const scroll = makeScrollPanel({ x: 0, y: treeY, width: treeW, height: treeH, contentHeight, scrollY, hits });
  c.addChild(scroll.container);

  const tree = makeTreeView(
    nodes,
    { x: 0, y: 0, width: treeW - 16, rowHeight: 18, fontSize: 11 },
    hits,
    (id: string) => {
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
    },
    (id: string) => scene.setDomSelected(id),
  );
  scroll.content.addChild(tree.container);

  // Pop the scroll panel's hit offset.
  hits.popOffset();

  // ── Detail panel (right, 40%) ──
  const detailX = treeW + 4;
  const detailW = w - treeW - 8;
  const detailBg = new Graphics();
  detailBg.rect(detailX, treeY, detailW, treeH);
  detailBg.fill({ color: BG_PANEL, alpha: 0.92 });
  c.addChild(detailBg);

  c.addChild(makeLabel("Inspector", detailX + 8, treeY + 4, COLOR_GREEN, 12));

  if (selected && mode === "pixi") {
    const gameStage = ctx.gamePixiUi?.stage;
    if (gameStage) {
      const node = findPixiNode(gameStage, selected);
      if (node) {
        let ry = treeY + 24;
        const props: [string, string][] = [
          ["Type", node.constructor?.name ?? "?"],
          ["x", node.x?.toFixed(1) ?? "?"],
          ["y", node.y?.toFixed(1) ?? "?"],
          ["visible", String(node.visible)],
          ["alpha", node.alpha?.toFixed(2) ?? "?"],
          ["children", String(node.children?.length ?? 0)],
          ["eventMode", String(node.eventMode ?? "none")],
        ];
        const b = node.getBounds?.();
        if (b) { props.push(["w", b.width.toFixed(0)]); props.push(["h", b.height.toFixed(0)]); }
        if (node.label != null) props.push(["label", String(node.label)]);
        for (const [k, v] of props) {
          c.addChild(makeLabel(k, detailX + 8, ry, COLOR_TEXT_DIM, 10));
          c.addChild(makeLabel(v, detailX + 90, ry, COLOR_TEXT, 10));
          ry += 16;
        }
      } else {
        c.addChild(makeLabel("Node not found", detailX + 8, treeY + 24, COLOR_TEXT_DIM, 11));
      }
    }
  } else if (selected && mode === "ecs") {
    // Show entity details
    c.addChild(makeLabel(selected, detailX + 8, treeY + 24, COLOR_YELLOW, 10));
    c.addChild(makeLabel("Entity details require sim reader API", detailX + 8, treeY + 40, COLOR_TEXT_DIM, 10));
  } else {
    c.addChild(makeLabel("Select a node to inspect", detailX + 8, treeY + 24, COLOR_TEXT_DIM, 11));
  }

  return c;
}

function buildPixiTree(
  node: any, id: string, depth: number, out: TreeNodeData[],
  expanded: Set<string>, selected: string | null, maxDepth: number,
): void {
  if (depth > maxDepth) return;
  const childCount = node.children?.length ?? 0;
  const isExpanded = expanded.has(id) || depth < 1;
  const label = node.constructor?.name ?? typeof node;
  const detail = childCount > 0 ? `(${childCount})` : node.label ? `"${String(node.label).slice(0, 20)}"` : "";
  out.push({ id, label, detail, expanded: isExpanded, selected: selected === id, childCount, depth });
  if (isExpanded && node.children) {
    for (let i = 0; i < node.children.length; i++) {
      buildPixiNode(node.children[i], `${id}.${i}`, depth + 1, out, expanded, selected, maxDepth);
    }
  }
}

// Alias to avoid name collision with the scene-panel version
const buildPixiNode = buildPixiTree;

function findPixiNode(root: any, id: string): any {
  if (id === "stage") return root;
  const parts = id.split(".").slice(1);
  let node = root;
  for (const part of parts) {
    const idx = parseInt(part, 10);
    if (node.children && idx >= 0 && idx < node.children.length) {
      node = node.children[idx];
    } else {
      return null;
    }
  }
  return node;
}
