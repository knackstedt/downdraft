// panels/dom_tree.rs — DOM/ECS panel: PIXI scene graph OR ECS entity tree.

use crate::state::PanelId;
use crate::DevtoolsState;

pub fn render(state: &mut DevtoolsState, ui: &mut egui::Ui) {
    ui.horizontal(|ui| {
        ui.label("Mode:");
        if ui
            .selectable_label(state.dom_tree.mode == 0, "PIXI")
            .clicked()
        {
            state.dom_tree.mode = 0;
            state.dom_refresh_requested = true;
        }
        if ui
            .selectable_label(state.dom_tree.mode == 1, "ECS")
            .clicked()
        {
            state.dom_tree.mode = 1;
            state.dom_refresh_requested = true;
        }
        ui.separator();
        if ui.button("Refresh").clicked() {
            state.dom_refresh_requested = true;
        }
        ui.label(
            egui::RichText::new(format!("{} nodes", state.dom_tree.nodes.len()))
                
                .color(egui::Color32::from_gray(140)),
        );
    });
    ui.separator();

    egui::ScrollArea::vertical()
        .auto_shrink([false, false])
        .show(ui, |ui| {
            super::render_tree_view(
                ui,
                &state.dom_tree.nodes,
                &mut state.dom_expanded,
                &mut state.dom_selected,
            );
        });

    let _ = PanelId::DomTree;
}
