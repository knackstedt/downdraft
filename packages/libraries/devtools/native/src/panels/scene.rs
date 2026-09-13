// panels/scene.rs — Scene panel: PIXI scene-graph tree (from gamePixiUi).

use crate::state::PanelId;
use crate::DevtoolsState;

pub fn render(state: &mut DevtoolsState, ui: &mut egui::Ui) {
    ui.horizontal(|ui| {
        if ui.button("Refresh").clicked() {
            state.scene_refresh_requested = true;
        }
        ui.label(
            egui::RichText::new(format!("{} nodes", state.scene_tree.nodes.len()))
                
                .color(egui::Color32::from_gray(140)),
        );
    });
    ui.separator();

    // Split: tree on top, details for selected node at the bottom.
    let avail = ui.available_size();
    let details_h = 100.0;
    let tree_h = (avail.y - details_h - 8.0).max(64.0);

    egui::ScrollArea::vertical()
        .max_height(tree_h)
        .auto_shrink([false, false])
        .show(ui, |ui| {
            super::render_tree_view(
                ui,
                &state.scene_tree.nodes,
                &mut state.scene_expanded,
                &mut state.scene_selected,
            );
        });

    ui.separator();
    ui.label(egui::RichText::new("Inspector").strong().color(egui::Color32::from_rgb(80, 230, 120)));
    if let Some(sel_id) = state.scene_selected {
        let by_id: std::collections::HashMap<u32, &crate::state::TreeNode> =
            state.scene_tree.nodes.iter().map(|n| (n.id, n)).collect();
        if let Some(node) = by_id.get(&sel_id) {
            let node = *node;
            egui::Grid::new("scene_inspector").num_columns(2).spacing([12.0, 4.0]).show(ui, |ui| {
                ui.label(egui::RichText::new("Label").color(egui::Color32::from_gray(140)));
                ui.label(egui::RichText::new(&node.label).color(egui::Color32::from_gray(220)));
                ui.end_row();
                ui.label(egui::RichText::new("Type").color(egui::Color32::from_gray(140)));
                ui.label(egui::RichText::new(&node.detail).color(egui::Color32::from_gray(220)));
                ui.end_row();
                ui.label(egui::RichText::new("ID").color(egui::Color32::from_gray(140)));
                ui.label(egui::RichText::new(format!("{}", node.id)).color(egui::Color32::from_gray(220)).monospace());
                ui.end_row();
                ui.label(egui::RichText::new("Depth").color(egui::Color32::from_gray(140)));
                ui.label(egui::RichText::new(format!("{}", node.depth)).color(egui::Color32::from_gray(220)).monospace());
                ui.end_row();
                ui.label(egui::RichText::new("Children").color(egui::Color32::from_gray(140)));
                ui.label(egui::RichText::new(format!("{}", node.child_count)).color(egui::Color32::from_gray(220)).monospace());
                ui.end_row();
                ui.label(egui::RichText::new("Kind").color(egui::Color32::from_gray(140)));
                let kind_str = match node.kind { 0 => "PIXI", 1 => "ECS", _ => "?" };
                ui.label(egui::RichText::new(kind_str).color(egui::Color32::from_gray(220)));
                ui.end_row();
            });
        } else {
            ui.label(egui::RichText::new("(selected node not found)").color(egui::Color32::from_gray(120)));
        }
    } else {
        ui.label(egui::RichText::new("Click a node to inspect it.").color(egui::Color32::from_gray(130)));
    }

    let _ = PanelId::Scene;
}
