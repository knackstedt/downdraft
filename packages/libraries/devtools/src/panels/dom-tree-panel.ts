// ============================================================================
// dom-tree-panel.ts — ECS entity inspector (distinct from the PIXI Scene panel).
//
// This panel focuses on the ECS world: entities grouped by type, with
// component details. The Scene panel handles the PIXI display tree.
//
// Features:
// - ECS World root with entity count
// - Entities grouped by type (expandable)
// - Entity detail panel: position, velocity, type, components
// - Component list with values
// ============================================================================

import { Container, Graphics } from "pixi.js";
import type { DebuggerScene } from "../debugger-scene";
import { BG_PANEL, COLOR_BORDER, COLOR_CYAN, COLOR_GREEN, COLOR_TEXT, COLOR_TEXT_BRIGHT, COLOR_TEXT_DIM, COLOR_YELLOW } from "../shared/colors";
import { makeLabel, makeScrollPanel, makeTreeView, type TreeNodeData } from "../shared/widgets";

const DETAIL_RATIO = 0.45;

export function renderDomTreePanel(scene: DebuggerScene, x: number, y: number, w: number, h: number): Container {
  const c = new Container();
  c.x = x;
  c.y = y;
  const ctx = scene.getContext();
  const hits = scene.getHits();
  const selected = scene.getDomSelected();
  const expanded = scene.getDomExpanded();

  // ── Header bar ──
  const headerBg = new Graphics();
  headerBg.rect(0, 0, w, 28);
  headerBg.fill({ color: 0x111122, alpha: 0.95 });
  headerBg.rect(0, 27, w, 1);
  headerBg.fill({ color: COLOR_BORDER, alpha: 0.5 });
  c.addChild(headerBg);
  c.addChild(makeLabel("ECS World Inspector", 8, 6, COLOR_GREEN, 12));

  // ── Build ECS tree ──
  const renderer = ctx.renderer;
  const simReader = renderer?.getSimReader?.() ?? renderer?.simReader;
  const nodes: TreeNodeData[] = [];

  if (simReader?.isValid?.()) {
    const entityCount = simReader.getEntityCount?.() ?? 0;
    const types = simReader.getEntityTypes?.() ?? {};

    nodes.push({
      id: "ecs-root",
      label: `ECS World (${entityCount} entities)`,
      detail: "",
      expanded: true,
      selected: false,
      childCount: Object.keys(types).length,
      depth: 0,
    });

    // Group by type
    for (const [typeId, count] of Object.entries(types)) {
      const id = `ecs-type-${typeId}`;
      const isExpanded = expanded.has(id);
      const typeName = simReader.getTypeName?.(parseInt(typeId, 10)) ?? `Type ${typeId}`;
      nodes.push({
        id,
        label: typeName,
        detail: `(${count})`,
        expanded: isExpanded,
        selected: false,
        childCount: count as number,
        depth: 1,
      });
      if (isExpanded) {
        const entities = simReader.getEntitiesByType?.(parseInt(typeId, 10)) ?? [];
        for (let i = 0; i < Math.min(entities.length, 100); i++) {
          const e = entities[i];
          const eid = `ecs-${typeId}-${i}`;
          const posStr = `(${e.x?.toFixed(0) ?? 0},${e.y?.toFixed(0) ?? 0},${e.z?.toFixed(0) ?? 0})`;
          nodes.push({
            id: eid,
            label: `Entity ${e.id ?? i}`,
            detail: posStr,
            expanded: false,
            selected: selected === eid,
            childCount: 0,
            depth: 2,
          });
        }
        if (entities.length > 100) {
          nodes.push({
            id: `ecs-${typeId}-more`,
            label: `... ${entities.length - 100} more`,
            detail: "",
            expanded: false,
            selected: false,
            childCount: 0,
            depth: 2,
          });
        }
      }
    }
  } else {
    nodes.push({
      id: "none",
      label: "Sim reader not available",
      detail: "",
      expanded: false,
      selected: false,
      childCount: 0,
      depth: 0,
    });
  }

  // ── Tree view (left) ──
  const treeW = Math.floor(w * (1 - DETAIL_RATIO));
  const treeY = 30;
  const treeH = h - treeY;
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

  // ── Detail panel (right) ──
  const detailX = treeW + 4;
  const detailW = w - treeW - 8;
  const detailBg = new Graphics();
  detailBg.rect(detailX, treeY, detailW, treeH);
  detailBg.fill({ color: BG_PANEL, alpha: 0.92 });
  detailBg.stroke({ color: COLOR_BORDER, width: 1 });
  c.addChild(detailBg);

  c.addChild(makeLabel("Entity Inspector", detailX + 8, treeY + 6, COLOR_GREEN, 12));

  if (selected && simReader?.isValid?.()) {
    drawEntityDetails(c, scene, hits, selected, simReader, detailX, treeY + 24, detailW, treeH - 24);
  } else {
    c.addChild(makeLabel("Select an entity to inspect", detailX + 8, treeY + 24, COLOR_TEXT_DIM, 11));
  }

  return c;
}

// ── Entity detail panel ──

function drawEntityDetails(
  c: Container, scene: DebuggerScene, hits: any,
  selectedId: string, simReader: any,
  x: number, y: number, w: number, h: number,
): void {
  let ry = y;

  // Parse the selected id to find the entity
  // Format: ecs-{typeId}-{index}
  const match = selectedId.match(/^ecs-(\d+)-(\d+)$/);
  if (!match) {
    // Maybe a type is selected
    if (selectedId.startsWith("ecs-type-")) {
      const typeId = parseInt(selectedId.replace("ecs-type-", ""), 10);
      const typeName = simReader.getTypeName?.(typeId) ?? `Type ${typeId}`;
      const count = simReader.getEntityTypes?.()?.[typeId] ?? 0;
      c.addChild(makeLabel(typeName, x + 8, ry, COLOR_CYAN, 13));
      ry += 18;
      c.addChild(makeLabel(`${count} entities`, x + 8, ry, COLOR_TEXT_DIM, 10));
      ry += 16;
      return;
    }
    if (selectedId === "ecs-root") {
      const entityCount = simReader.getEntityCount?.() ?? 0;
      const types = simReader.getEntityTypes?.() ?? {};
      c.addChild(makeLabel("ECS World", x + 8, ry, COLOR_TEXT_BRIGHT, 13));
      ry += 18;
      c.addChild(makeLabel(`Total entities: ${entityCount}`, x + 8, ry, COLOR_TEXT, 10));
      ry += 14;
      c.addChild(makeLabel(`Entity types: ${Object.keys(types).length}`, x + 8, ry, COLOR_TEXT, 10));
      ry += 14;
      // List types
      c.addChild(makeLabel("Types:", x + 8, ry, COLOR_YELLOW, 10));
      ry += 14;
      for (const [typeId, count] of Object.entries(types)) {
        const typeName = simReader.getTypeName?.(parseInt(typeId, 10)) ?? `Type ${typeId}`;
        c.addChild(makeLabel(`  ${typeName}: ${count}`, x + 12, ry, COLOR_TEXT_DIM, 9));
        ry += 12;
      }
      return;
    }
    c.addChild(makeLabel("Select an entity", x + 8, ry, COLOR_TEXT_DIM, 11));
    return;
  }

  const typeId = parseInt(match[1], 10);
  const index = parseInt(match[2], 10);
  const entities = simReader.getEntitiesByType?.(typeId) ?? [];
  const entity = entities[index];

  if (!entity) {
    c.addChild(makeLabel("Entity not found", x + 8, ry, COLOR_TEXT_DIM, 11));
    return;
  }

  // Entity header
  const typeName = simReader.getTypeName?.(typeId) ?? `Type ${typeId}`;
  c.addChild(makeLabel(`Entity #${entity.id ?? index}`, x + 8, ry, COLOR_TEXT_BRIGHT, 13));
  ry += 18;
  c.addChild(makeLabel(typeName, x + 8, ry, COLOR_CYAN, 11));
  ry += 16;

  // Separator
  const sep = new Graphics();
  sep.rect(x + 4, ry, w - 8, 1);
  sep.fill({ color: COLOR_BORDER, alpha: 0.5 });
  c.addChild(sep);
  ry += 6;

  // ── Position ──
  c.addChild(makeLabel("Position", x + 8, ry, COLOR_YELLOW, 10));
  ry += 14;
  const posProps: [string, string][] = [
    ["x", entity.x?.toFixed(2) ?? "?"],
    ["y", entity.y?.toFixed(2) ?? "?"],
    ["z", entity.z?.toFixed(2) ?? "?"],
  ];
  for (const [key, val] of posProps) {
    c.addChild(makeLabel(key, x + 8, ry, COLOR_TEXT_DIM, 9));
    c.addChild(makeLabel(val, x + 80, ry, COLOR_TEXT, 9));
    ry += 13;
  }

  // ── Velocity (if available) ──
  if (entity.vx != null || entity.vy != null || entity.vz != null) {
    c.addChild(makeLabel("Velocity", x + 8, ry, COLOR_YELLOW, 10));
    ry += 14;
    const velProps: [string, string][] = [
      ["vx", entity.vx?.toFixed(2) ?? "?"],
      ["vy", entity.vy?.toFixed(2) ?? "?"],
      ["vz", entity.vz?.toFixed(2) ?? "?"],
    ];
    for (const [key, val] of velProps) {
      c.addChild(makeLabel(key, x + 8, ry, COLOR_TEXT_DIM, 9));
      c.addChild(makeLabel(val, x + 80, ry, COLOR_TEXT, 9));
      ry += 13;
    }
  }

  // ── Rotation (if available) ──
  if (entity.heading != null || entity.rotation != null) {
    c.addChild(makeLabel("Rotation", x + 8, ry, COLOR_YELLOW, 10));
    ry += 14;
    const rotProps: [string, string][] = [
      ["heading", entity.heading?.toFixed(2) ?? "?"],
      ["rotation", entity.rotation?.toFixed(2) ?? "?"],
    ];
    for (const [key, val] of rotProps) {
      if (val === "?") continue;
      c.addChild(makeLabel(key, x + 8, ry, COLOR_TEXT_DIM, 9));
      c.addChild(makeLabel(val, x + 80, ry, COLOR_TEXT, 9));
      ry += 13;
    }
  }

  // ── All other properties ──
  const knownKeys = new Set(["id", "x", "y", "z", "vx", "vy", "vz", "heading", "rotation", "typeId", "type"]);
  const extraKeys = Object.keys(entity).filter((k) => !knownKeys.has(k));
  if (extraKeys.length > 0) {
    c.addChild(makeLabel("Components", x + 8, ry, COLOR_YELLOW, 10));
    ry += 14;
    for (const key of extraKeys.slice(0, 30)) {
      const val = entity[key];
      let valStr: string;
      if (val == null) valStr = "null";
      else if (typeof val === "number") valStr = val.toFixed(2);
      else if (typeof val === "string") valStr = val.slice(0, 20);
      else if (typeof val === "boolean") valStr = String(val);
      else valStr = JSON.stringify(val)?.slice(0, 30) ?? "?";
      c.addChild(makeLabel(key, x + 8, ry, COLOR_TEXT_DIM, 9));
      c.addChild(makeLabel(valStr, x + 100, ry, COLOR_TEXT, 9));
      ry += 13;
    }
    if (extraKeys.length > 30) {
      c.addChild(makeLabel(`  ... ${extraKeys.length - 30} more`, x + 12, ry, COLOR_TEXT_DIM, 9));
      ry += 13;
    }
  }

  // ── Sim stats ──
  ry += 4;
  c.addChild(makeLabel("Sim Stats", x + 8, ry, COLOR_YELLOW, 10));
  ry += 14;
  const simProps: [string, string][] = [
    ["Entity count", String(simReader.getEntityCount?.() ?? "?")],
    ["Type count", String(Object.keys(simReader.getEntityTypes?.() ?? {}).length)],
    ["Valid", String(simReader.isValid?.() ?? false)],
  ];
  for (const [key, val] of simProps) {
    c.addChild(makeLabel(key, x + 8, ry, COLOR_TEXT_DIM, 9));
    c.addChild(makeLabel(val, x + 100, ry, COLOR_TEXT, 9));
    ry += 13;
  }
}
