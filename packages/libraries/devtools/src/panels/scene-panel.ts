// ============================================================================
// scene-panel.ts — Rich PIXI scene graph inspector.
//
// Features:
// - Tree with node type, label, child count, position, visibility
// - Search field (filter by type or label)
// - Collapsible tree (auto-expands first 2 levels)
// - Scrollable detail panel with full properties
// - Click children/parents to navigate
// ============================================================================

import { Container, Graphics } from "pixi.js";
import type { DebuggerScene } from "../debugger-scene";
import { BG_DARK, BG_INPUT, BG_PANEL, COLOR_BORDER, COLOR_CYAN, COLOR_GREEN, COLOR_ORANGE, COLOR_RED, COLOR_TEXT, COLOR_TEXT_BRIGHT, COLOR_TEXT_DIM, COLOR_YELLOW } from "../shared/colors";
import { makeLabel, makeScrollPanel, makeTreeView, type TreeNodeData } from "../shared/widgets";

const SEARCH_HEIGHT = 28;
const DETAIL_RATIO = 0.45;
const TREE_ROW_H = 16;

// Node type → color mapping
const TYPE_COLORS: Record<string, number> = {
  Container: COLOR_TEXT_DIM,
  Text: COLOR_CYAN,
  Graphics: COLOR_YELLOW,
  Sprite: COLOR_GREEN,
  Mesh: COLOR_ORANGE,
  TilingSprite: COLOR_GREEN,
  AnimatedSprite: COLOR_GREEN,
  NineSliceSprite: COLOR_GREEN,
  BitmapText: COLOR_CYAN,
  HTMLText: COLOR_CYAN,
  Stage: COLOR_TEXT_BRIGHT,
  RenderGroup: COLOR_ORANGE,
  ParticleContainer: COLOR_TEXT_DIM,
};

export function renderScenePanel(scene: DebuggerScene, x: number, y: number, w: number, h: number): Container {
  const c = new Container();
  c.x = x;
  c.y = y;
  const ctx = scene.getContext();
  const hits = scene.getHits();
  const selectedNode = scene.getSceneSelected();
  const expandedNodes = scene.getSceneExpanded();
  const searchQuery = (scene as any)._sceneSearch ?? "";

  // ── Search bar (top) ──
  const searchBg = new Graphics();
  searchBg.rect(0, 0, w, SEARCH_HEIGHT);
  searchBg.fill({ color: BG_DARK, alpha: 0.95 });
  searchBg.rect(0, SEARCH_HEIGHT - 1, w, 1);
  searchBg.fill({ color: COLOR_BORDER, alpha: 0.5 });
  c.addChild(searchBg);

  // Search input
  const searchInputBg = new Graphics();
  searchInputBg.roundRect(4, 4, w - 8, 20, 3);
  searchInputBg.fill({ color: BG_INPUT, alpha: 0.95 });
  searchInputBg.stroke({ color: (scene.getFocusedWidget() === "scene-search") ? COLOR_GREEN : COLOR_BORDER, width: 1 });
  c.addChild(searchInputBg);
  const searchText = searchQuery || "Filter by type or label...";
  c.addChild(makeLabel(searchText, 8, 7, searchQuery ? COLOR_TEXT_BRIGHT : COLOR_TEXT_DIM, 10));
  hits.add(4, 4, w - 8, 20, () => {
    scene.setFocus("scene-search");
    scene.setTextInputHandler({
      onText: (text: string) => {
        (scene as any)._sceneSearch = ((scene as any)._sceneSearch ?? "") + text;
      },
      onKey: (key: string, _keyCode: number) => {
        const current = (scene as any)._sceneSearch ?? "";
        if (key === "Backspace") {
          (scene as any)._sceneSearch = current.slice(0, -1);
        } else if (key === "Enter") {
          scene.setFocus(null);
        } else if (key === "Escape") {
          (scene as any)._sceneSearch = "";
          scene.setFocus(null);
        }
      },
    });
  });

  // ── Build tree data from the game's PixiJS stage ──
  const gameStage = ctx.gamePixiUi?.stage;
  const nodes: TreeNodeData[] = [];

  if (gameStage) {
    buildTreeNodes(gameStage, "stage", 0, nodes, expandedNodes, selectedNode, 50, searchQuery.toLowerCase());
  } else {
    nodes.push({
      id: "none", label: "No game PixiJS host available", detail: "",
      expanded: false, selected: false, childCount: 0, depth: 0,
    });
  }

  // ── Tree view (left, scrollable) ──
  const treeW = Math.floor(w * (1 - DETAIL_RATIO));
  const treeY = SEARCH_HEIGHT;
  const treeH = h - treeY;
  const scrollY = scene.getScrollY("scene");
  const contentHeight = nodes.length * TREE_ROW_H + 10;
  const scroll = makeScrollPanel({ x: 0, y: treeY, width: treeW, height: treeH, contentHeight, scrollY, hits });
  c.addChild(scroll.container);

  const tree = makeTreeView(
    nodes,
    { x: 0, y: 0, width: treeW - 16, rowHeight: TREE_ROW_H, fontSize: 11 },
    hits,
    (id: string) => scene.toggleSceneExpanded(id),
    (id: string) => scene.setSceneSelected(id),
  );
  scroll.content.addChild(tree.container);

  // Pop the scroll panel's hit offset.
  hits.popOffset();

  // ── Detail panel (right, scrollable) ──
  const detailX = treeW + 4;
  const detailW = w - treeW - 8;
  const detailBg = new Graphics();
  detailBg.rect(detailX, treeY, detailW, treeH);
  detailBg.fill({ color: BG_PANEL, alpha: 0.92 });
  detailBg.stroke({ color: COLOR_BORDER, width: 1 });
  c.addChild(detailBg);

  c.addChild(makeLabel("Inspector", detailX + 8, treeY + 6, COLOR_GREEN, 12));

  // Build detail content into a scroll panel
  const detailScrollY = scene.getScrollY("scene-detail");
  const detailContentH = 600; // generous, scroll handles overflow
  const detailScroll = makeScrollPanel({ x: detailX, y: treeY + 24, width: detailW, height: treeH - 28, contentHeight: detailContentH, scrollY: detailScrollY, hits });
  c.addChild(detailScroll.container);

  if (selectedNode && gameStage) {
    const node = findNodeById(gameStage, selectedNode);
    if (node) {
      drawNodeDetails(detailScroll.content, scene, hits, node, selectedNode, gameStage, 0, 0, detailW);
    } else {
      detailScroll.content.addChild(makeLabel("Node not found", 8, 4, COLOR_TEXT_DIM, 11));
    }
  } else {
    detailScroll.content.addChild(makeLabel("Select a node to inspect", 8, 4, COLOR_TEXT_DIM, 11));
  }

  // Pop the detail scroll panel's hit offset.
  hits.popOffset();

  return c;
}

// ── Detail panel ──

function drawNodeDetails(
  content: Container, scene: DebuggerScene, hits: any,
  node: any, nodeId: string, root: any,
  x: number, y: number, w: number,
): void {
  let ry = y;
  const typeName = node.constructor?.name ?? "unknown";
  const typeColor = TYPE_COLORS[typeName] ?? COLOR_TEXT;

  // Type header
  content.addChild(makeLabel(typeName, x + 8, ry, typeColor, 13));
  ry += 18;

  // Label (if any)
  if (node.label != null) {
    content.addChild(makeLabel(`"${String(node.label)}"`, x + 8, ry, COLOR_TEXT_BRIGHT, 11));
    ry += 16;
  }

  // Separator
  const sep = new Graphics();
  sep.rect(x + 4, ry, w - 8, 1);
  sep.fill({ color: COLOR_BORDER, alpha: 0.5 });
  content.addChild(sep);
  ry += 6;

  // ── Transform properties ──
  content.addChild(makeLabel("Transform", x + 8, ry, COLOR_YELLOW, 10));
  ry += 14;
  const transformProps: [string, string][] = [
    ["x", node.x?.toFixed(1) ?? "?"],
    ["y", node.y?.toFixed(1) ?? "?"],
    ["scaleX", node.scale?.x?.toFixed(2) ?? "?"],
    ["scaleY", node.scale?.y?.toFixed(2) ?? "?"],
    ["rotation", node.rotation != null ? `${(node.rotation * 180 / Math.PI).toFixed(1)}°` : "?"],
    ["pivotX", node.pivot?.x?.toFixed(1) ?? "?"],
    ["pivotY", node.pivot?.y?.toFixed(1) ?? "?"],
    ["skewX", node.skew?.x?.toFixed(2) ?? "?"],
    ["skewY", node.skew?.y?.toFixed(2) ?? "?"],
  ];
  for (const [key, val] of transformProps) {
    content.addChild(makeLabel(key, x + 8, ry, COLOR_TEXT_DIM, 9));
    content.addChild(makeLabel(val, x + 80, ry, COLOR_TEXT, 9));
    ry += 13;
  }

  // World transform matrix
  const wt = node.worldTransform;
  if (wt) {
    content.addChild(makeLabel("World Matrix", x + 8, ry, COLOR_YELLOW, 10));
    ry += 14;
    const matrixProps: [string, string][] = [
      ["a", wt.a?.toFixed(2) ?? "?"],
      ["b", wt.b?.toFixed(2) ?? "?"],
      ["c", wt.c?.toFixed(2) ?? "?"],
      ["d", wt.d?.toFixed(2) ?? "?"],
      ["tx", wt.tx?.toFixed(1) ?? "?"],
      ["ty", wt.ty?.toFixed(1) ?? "?"],
    ];
    for (const [key, val] of matrixProps) {
      content.addChild(makeLabel(key, x + 8, ry, COLOR_TEXT_DIM, 9));
      content.addChild(makeLabel(val, x + 80, ry, COLOR_TEXT, 9));
      ry += 13;
    }
  }

  ry += 4;
  // ── Bounds ──
  content.addChild(makeLabel("Bounds", x + 8, ry, COLOR_YELLOW, 10));
  ry += 14;
  const wb = node.getBounds?.();
  if (wb) {
    const boundsProps: [string, string][] = [
      ["x", wb.x?.toFixed(1) ?? "?"],
      ["y", wb.y?.toFixed(1) ?? "?"],
      ["width", wb.width?.toFixed(0) ?? "?"],
      ["height", wb.height?.toFixed(0) ?? "?"],
    ];
    for (const [key, val] of boundsProps) {
      content.addChild(makeLabel(key, x + 8, ry, COLOR_TEXT_DIM, 9));
      content.addChild(makeLabel(val, x + 80, ry, COLOR_TEXT, 9));
      ry += 13;
    }
  }
  const lb = node.getLocalBounds?.();
  if (lb) {
    content.addChild(makeLabel("Local:", x + 8, ry, COLOR_TEXT_DIM, 9));
    content.addChild(makeLabel(`${lb.width?.toFixed(0) ?? "?"}×${lb.height?.toFixed(0) ?? "?"}`, x + 80, ry, COLOR_TEXT, 9));
    ry += 13;
  }

  ry += 4;
  // ── Display properties ──
  content.addChild(makeLabel("Display", x + 8, ry, COLOR_YELLOW, 10));
  ry += 14;
  const displayProps: [string, string][] = [
    ["visible", String(node.visible ?? true)],
    ["alpha", node.alpha?.toFixed(2) ?? "?"],
    ["zIndex", String(node.zIndex ?? 0)],
    ["renderable", String(node.renderable ?? true)],
    ["eventMode", String(node.eventMode ?? "none")],
    ["interactive", String(node.interactive ?? false)],
    ["cullable", String(node.cullable ?? false)],
    ["cullArea", node.cullArea ? "set" : "none"],
  ];
  for (const [key, val] of displayProps) {
    const valColor = (key === "visible" && val === "false") ? COLOR_RED : COLOR_TEXT;
    content.addChild(makeLabel(key, x + 8, ry, COLOR_TEXT_DIM, 9));
    content.addChild(makeLabel(val, x + 80, ry, valColor, 9));
    ry += 13;
  }

  ry += 4;
  // ── Children ──
  const childCount = node.children?.length ?? 0;
  content.addChild(makeLabel(`Children (${childCount})`, x + 8, ry, COLOR_YELLOW, 10));
  ry += 14;
  if (node.children && childCount > 0) {
    for (let i = 0; i < Math.min(childCount, 15); i++) {
      const child = node.children[i];
      const childType = child.constructor?.name ?? typeof child;
      const childColor = TYPE_COLORS[childType] ?? COLOR_TEXT;
      const childLabel = child.label ? `"${String(child.label).slice(0, 15)}"` : "";
      const text = `[${i}] ${childType} ${childLabel}`;
      content.addChild(makeLabel(text, x + 12, ry, childColor, 9));
      // Click to navigate to child
      const childId = `${nodeId}.${i}`;
      hits.add(x + 12, ry, w - 20, 13, () => {
        scene.setSceneSelected(childId);
      });
      ry += 13;
    }
    if (childCount > 15) {
      content.addChild(makeLabel(`  ... ${childCount - 15} more`, x + 12, ry, COLOR_TEXT_DIM, 9));
      ry += 13;
    }
  }

  ry += 4;
  // ── Parent chain ──
  const parentChain = getParentChain(root, nodeId);
  if (parentChain.length > 1) {
    content.addChild(makeLabel("Parents", x + 8, ry, COLOR_YELLOW, 10));
    ry += 14;
    for (let i = parentChain.length - 2; i >= 0; i--) {
      const p = parentChain[i];
      const pType = p.node.constructor?.name ?? "unknown";
      const pColor = TYPE_COLORS[pType] ?? COLOR_TEXT;
      const pLabel = p.node.label ? `"${String(p.node.label).slice(0, 15)}"` : "";
      const text = `↑ ${pType} ${pLabel}`;
      content.addChild(makeLabel(text, x + 12, ry, pColor, 9));
      // Click to navigate to parent
      hits.add(x + 12, ry, w - 20, 13, () => {
        scene.setSceneSelected(p.id);
      });
      ry += 13;
    }
  }
}

// ── Tree building ──

function buildTreeNodes(
  node: any,
  id: string,
  depth: number,
  out: TreeNodeData[],
  expanded: Set<string>,
  selected: string | null,
  maxDepth: number,
  searchQuery: string,
): void {
  if (depth > maxDepth) return;
  const childCount = node.children?.length ?? 0;
  // Auto-expand first 2 levels
  const isExpanded = expanded.has(id) || depth < 2;
  const typeName = node.constructor?.name ?? typeof node;

  // Build a useful label: type name + label/name + position info
  let label: string;
  if (node.label) {
    label = `${typeName}: "${String(node.label).slice(0, 20)}"`;
  } else if (node.name) {
    label = `${typeName}: ${String(node.name).slice(0, 20)}`;
  } else {
    label = typeName;
  }

  // Build detail: child count + position + visibility
  let detail = "";
  if (childCount > 0) detail += `(${childCount})`;
  if (node.visible === false) detail += " 👁"; // hidden indicator
  if (node.x != null && node.y != null && (node.x !== 0 || node.y !== 0)) {
    detail += ` @${node.x.toFixed(0)},${node.y.toFixed(0)}`;
  }

  // Apply search filter
  if (searchQuery) {
    const matches = typeName.toLowerCase().includes(searchQuery) ||
      (node.label && String(node.label).toLowerCase().includes(searchQuery));
    if (!matches && !isExpanded) {
      // Don't add non-matching collapsed nodes, but still recurse into children
      if (node.children) {
        for (let i = 0; i < node.children.length; i++) {
          buildTreeNodes(node.children[i], `${id}.${i}`, depth + 1, out, expanded, selected, maxDepth, searchQuery);
        }
      }
      return;
    }
  }

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
      buildTreeNodes(node.children[i], `${id}.${i}`, depth + 1, out, expanded, selected, maxDepth, searchQuery);
    }
  }
}

function findNodeById(root: any, id: string): any {
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

function getParentChain(root: any, id: string): { node: any; id: string }[] {
  const chain: { node: any; id: string }[] = [];
  if (id === "stage") {
    chain.push({ node: root, id: "stage" });
    return chain;
  }
  const parts = id.split(".").slice(1);
  let node = root;
  let currentId = "stage";
  chain.push({ node: root, id: currentId });
  for (const part of parts) {
    const idx = parseInt(part, 10);
    if (node.children && idx >= 0 && idx < node.children.length) {
      node = node.children[idx];
      currentId = `${currentId}.${idx}`;
      chain.push({ node, id: currentId });
    } else {
      break;
    }
  }
  return chain;
}
