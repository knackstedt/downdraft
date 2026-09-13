// panels/mod.rs — dispatches to the active panel + shared tree renderer.

pub mod console;
pub mod dom_tree;
pub mod gpu;
pub mod perf_metrics;
pub mod perf_recorder;
pub mod scene;

use std::collections::HashMap;

use crate::state::{PanelId, TreeNode};
use crate::DevtoolsState;

/// Render the active panel into the given Ui (inside the dock content area).
pub fn render_panel(state: &mut DevtoolsState, ui: &mut egui::Ui) {
    match state.active_panel {
        PanelId::Console => console::render(state, ui),
        PanelId::Scene => scene::render(state, ui),
        PanelId::Gpu => gpu::render(state, ui),
        PanelId::PerfRecorder => perf_recorder::render(state, ui),
        PanelId::PerfMetrics => perf_metrics::render(state, ui),
        PanelId::DomTree => dom_tree::render(state, ui),
    }
}

/// Render a flat node list (with parent_id) as a collapsible tree.
/// Returns the id of the node the user clicked (if any) — caller updates
/// selection state.
pub fn render_tree_view(
    ui: &mut egui::Ui,
    nodes: &[TreeNode],
    expanded: &mut std::collections::HashSet<u32>,
    selected: &mut Option<u32>,
) {
    if nodes.is_empty() {
        ui.label(
            egui::RichText::new("(no nodes — open the panel or refresh)")
                .color(egui::Color32::from_gray(120))
                ,
        );
        return;
    }

    // Build children map: parent_id -> [child ids in order].
    let mut children: HashMap<i32, Vec<u32>> = HashMap::new();
    for n in nodes {
        children.entry(n.parent_id).or_default().push(n.id);
    }
    let by_id: HashMap<u32, &TreeNode> = nodes.iter().map(|n| (n.id, n)).collect();

    // Auto-expand root nodes on first render so the tree isn't empty.
    // Only auto-expand for PIXI trees (kind=0); ECS trees (kind=1) have
    // many flat root nodes and should not all be expanded.
    let roots = children.get(&-1).cloned().unwrap_or_default();
    let is_pixi = nodes.first().map(|n| n.kind == 0).unwrap_or(true);
    if is_pixi {
        if roots.len() == 1 {
            // Single root: expand it and its first-level children for a useful default view.
            expanded.insert(roots[0]);
            if let Some(first_level) = children.get(&(roots[0] as i32)) {
                for &child_id in first_level {
                    expanded.insert(child_id);
                }
            }
        }
        for root_id in &roots {
            expanded.insert(*root_id);
        }
    }

    for root_id in roots {
        render_tree_node(ui, root_id, &children, &by_id, expanded, selected);
    }
}

fn render_tree_node(
    ui: &mut egui::Ui,
    id: u32,
    children: &HashMap<i32, Vec<u32>>,
    by_id: &HashMap<u32, &TreeNode>,
    expanded: &mut std::collections::HashSet<u32>,
    selected: &mut Option<u32>,
) {
    let node = match by_id.get(&id) {
        Some(n) => *n,
        None => return,
    };
    let has_children = node.child_count > 0;
    let is_expanded = expanded.contains(&id);
    let is_selected = *selected == Some(id);

    ui.horizontal(|ui| {
        // Expand/collapse triangle
        if has_children {
            let tri = if is_expanded { "\u{25be}" } else { "\u{25b8}" };
            let resp = ui.add(
                egui::Button::new(egui::RichText::new(tri).color(egui::Color32::from_gray(180)))
                    .frame(false),
            );
            if resp.clicked() {
                if is_expanded {
                    expanded.remove(&id);
                } else {
                    expanded.insert(id);
                }
            }
        } else {
            ui.add_space(12.0);
        }

        // Label
        let label_text = if node.detail.is_empty() {
            node.label.clone()
        } else {
            format!("{}  {}", node.label, node.detail)
        };
        let color = if is_selected {
            egui::Color32::WHITE
        } else {
            egui::Color32::from_gray(210)
        };
        let resp = ui.add(egui::Button::new(egui::RichText::new(label_text).color(color)).frame(false));
        if is_selected {
            ui.painter()
                .rect_filled(resp.rect, 0.0, egui::Color32::from_rgba_premultiplied(80, 160, 255, 60));
        }
        if resp.clicked() {
            *selected = Some(id);
        }
    });

    if has_children && is_expanded {
        let kids = children.get(&(id as i32)).cloned().unwrap_or_default();
        for kid in kids {
            ui.indent(format!("tree_{}", kid), |ui| {
                render_tree_node(ui, kid, children, by_id, expanded, selected);
            });
        }
    }
}
