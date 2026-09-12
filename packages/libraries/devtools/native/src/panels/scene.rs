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

    egui::ScrollArea::vertical()
        .auto_shrink([false, false])
        .show(ui, |ui| {
            super::render_tree_view(
                ui,
                &state.scene_tree.nodes,
                &mut state.scene_expanded,
                &mut state.scene_selected,
            );
        });

    let _ = PanelId::Scene;
}
