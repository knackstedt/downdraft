// ============================================================================
// scene-panel.ts — Scene graph inspector for the game's PixiJS stage.
//
// Shows a collapsible tree of the PIXI scene graph (from gamePixiUi.stage),
// with node type, position, size, and alpha. Click a node to select it and
// see its properties in a detail panel on the right.
// ============================================================================

import { Container, Graphics } from "pixi.js";
import type { DebuggerScene } from "../debugger-scene";
import { BG_PANEL, COLOR_GREEN, COLOR_TEXT, COLOR_TEXT_DIM, COLOR_YELLOW } from "../shared/colors";
import { makeLabel, makeScrollPanel, makeTreeView, type TreeNodeData } from "../shared/widgets";

export function renderScenePanel(scene: DebuggerScene, x: number, y: number, w: number, h: number): Container {
  const c = new Container();
  c.x = x;
  c.y = y;
  const ctx = scene.getContext();
  const hits = scene.getHits();
  const selectedNode = scene.getSceneSelected();
  const expandedNodes = scene.getSceneExpanded();

  // ── Build tree data from the game's PixiJS stage ──
  const gameStage = ctx.gamePixiUi?.stage;
  const nodes: TreeNodeData[] = [];

  if (gameStage) {
    buildTreeNodes(gameStage, "stage", 0, nodes, expandedNodes, selectedNode, 50);
  } else {
    nodes.push({
      id: "none", label: "No game PixiJS host available", detail: "",
      expanded: false, selected: false, childCount: 0, depth: 0,
    });
  }

  // ── Tree view (left, 60% width) ──
  const treeW = Math.floor(w * 0.6);
  const treeH = h;
  const scrollY = scene.getScrollY("scene");
  const contentHeight = nodes.length * 18 + 10;
  const scroll = makeScrollPanel({ x: 0, y: 0, width: treeW, height: treeH, contentHeight, scrollY, hits });
  c.addChild(scroll.container);

  const tree = makeTreeView(
    nodes,
    { x: 0, y: 0, width: treeW - 16, rowHeight: 18, fontSize: 11 },
    hits,
    (id: string) => scene.toggleSceneExpanded(id),
    (id: string) => scene.setSceneSelected(id),
  );
  scroll.content.addChild(tree.container);

  // Pop the scroll panel's hit offset.
  hits.popOffset();

  // ── Detail panel (right, 40% width) ──
  const detailX = treeW + 4;
  const detailW = w - treeW - 8;
  const detailBg = new Graphics();
  detailBg.rect(detailX, 0, detailW, h);
  detailBg.fill({ color: BG_PANEL, alpha: 0.92 });
  c.addChild(detailBg);

  c.addChild(makeLabel("Inspector", detailX + 8, 4, COLOR_GREEN, 12));

  if (selectedNode && gameStage) {
    const node = findNodeById(gameStage, selectedNode);
    if (node) {
      let ry = 24;
      const props: [string, string][] = [
        ["Type", node.constructor?.name ?? "unknown"],
        ["x", node.x?.toFixed(1) ?? "?"],
        ["y", node.y?.toFixed(1) ?? "?"],
        ["visible", String(node.visible)],
        ["alpha", node.alpha?.toFixed(2) ?? "?"],
        ["zIndex", String(node.zIndex ?? 0)],
        ["children", String(node.children?.length ?? 0)],
        ["interactive", String(node.eventMode ?? "none")],
      ];
      const bounds = node.getBounds?.();
      if (bounds) {
        props.push(["width", bounds.width.toFixed(0)]);
        props.push(["height", bounds.height.toFixed(0)]);
      }
      if (node.label != null) props.push(["label", String(node.label)]);

      for (const [key, val] of props) {
        c.addChild(makeLabel(key, detailX + 8, ry, COLOR_TEXT_DIM, 10));
        c.addChild(makeLabel(val, detailX + 90, ry, COLOR_TEXT, 10));
        ry += 16;
      }

      // Show first few children names
      if (node.children?.length > 0) {
        ry += 4;
        c.addChild(makeLabel("Children:", detailX + 8, ry, COLOR_YELLOW, 10));
        ry += 16;
        for (let i = 0; i < Math.min(node.children.length, 10); i++) {
          const child = node.children[i];
          c.addChild(makeLabel(`  [${i}] ${child.constructor?.name ?? typeof child}`, detailX + 8, ry, COLOR_TEXT_DIM, 10));
          ry += 14;
        }
        if (node.children.length > 10) {
          c.addChild(makeLabel(`  ... and ${node.children.length - 10} more`, detailX + 8, ry, COLOR_TEXT_DIM, 10));
        }
      }
    } else {
      c.addChild(makeLabel("Node not found", detailX + 8, 24, COLOR_TEXT_DIM, 11));
    }
  } else {
    c.addChild(makeLabel("Select a node to inspect", detailX + 8, 24, COLOR_TEXT_DIM, 11));
  }

  return c;
}

function buildTreeNodes(
  node: any,
  id: string,
  depth: number,
  out: TreeNodeData[],
  expanded: Set<string>,
  selected: string | null,
  maxDepth: number,
): void {
  if (depth > maxDepth) return;
  const childCount = node.children?.length ?? 0;
  const isExpanded = expanded.has(id) || depth < 1; // auto-expand first level
  const label = node.constructor?.name ?? typeof node;
  const detail = childCount > 0 ? `(${childCount})` : node.label ? `"${String(node.label).slice(0, 20)}"` : "";
  out.push({
    id,
    label,
    detail,
    expanded: isExpanded,
    selected: selected === id,
    childCount,
    depth,
  });
  if (isExpanded && node.children) {
    for (let i = 0; i < node.children.length; i++) {
      buildTreeNodes(node.children[i], `${id}.${i}`, depth + 1, out, expanded, selected, maxDepth);
    }
  }
}

function findNodeById(root: any, id: string): any {
  if (id === "stage") return root;
  const parts = id.split(".").slice(1); // remove "stage"
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
