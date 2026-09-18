// panels/input.rs — live view of the input the egui overlay sees (mouse,
// modifiers, last keys, text-input capture) plus a provider-fed generic
// snapshot for game-level input state (pointer lock, event rates, etc.).

use crate::state::PanelId;
use crate::DevtoolsState;

const C_DIM: egui::Color32 = egui::Color32::from_rgb(0x9a, 0xa0, 0xa6);
const C_TEXT: egui::Color32 = egui::Color32::from_rgb(0xe8, 0xea, 0xed);
const C_HEADER: egui::Color32 = egui::Color32::from_rgb(0x8a, 0xb4, 0xf8);
const C_ON: egui::Color32 = egui::Color32::from_rgb(0x81, 0xc9, 0x95);
const C_OFF: egui::Color32 = egui::Color32::from_rgb(0x5f, 0x63, 0x68);

pub fn render(state: &mut DevtoolsState, ui: &mut egui::Ui) {
    egui::ScrollArea::vertical()
        .auto_shrink([false, false])
        .show(ui, |ui| {
            ui.label(egui::RichText::new("Overlay input (what egui sees)").strong().color(C_HEADER));

            let inp = &state.input;
            ui.horizontal(|ui| {
                ui.label(egui::RichText::new("mouse").color(C_DIM).monospace());
                ui.label(
                    egui::RichText::new(format!("({:.0}, {:.0})", inp.mouse_pos.0, inp.mouse_pos.1))
                        .color(C_TEXT)
                        .monospace(),
                );
                ui.label(
                    egui::RichText::new(if inp.mouse_in_window { "in-window" } else { "outside" })
                        .color(if inp.mouse_in_window { C_ON } else { C_OFF })
                        .monospace(),
                );
            });
            ui.horizontal(|ui| {
                ui.label(egui::RichText::new("buttons").color(C_DIM).monospace());
                for (i, name) in ["L", "R", "M"].iter().enumerate() {
                    let down = inp.mouse_down[i];
                    ui.label(
                        egui::RichText::new(format!("{}:{}", name, if down { "down" } else { "up" }))
                            .color(if down { C_ON } else { C_OFF })
                            .monospace(),
                    );
                }
            });
            ui.horizontal(|ui| {
                ui.label(egui::RichText::new("mods").color(C_DIM).monospace());
                ui.label(
                    egui::RichText::new(format!(
                        "alt={} ctrl={} shift={}",
                        inp.modifiers_alt, inp.modifiers_ctrl, inp.modifiers_shift
                    ))
                    .color(C_TEXT)
                    .monospace(),
                );
            });
            ui.horizontal(|ui| {
                ui.label(egui::RichText::new("wheel").color(C_DIM).monospace());
                ui.label(
                    egui::RichText::new(format!("{:.1}", inp.wheel)).color(C_TEXT).monospace(),
                );
            });
            ui.horizontal(|ui| {
                ui.label(egui::RichText::new("text input").color(C_DIM).monospace());
                let wants = state.ctx.wants_keyboard_input();
                ui.label(
                    egui::RichText::new(if wants { "capturing" } else { "idle" })
                        .color(if wants { C_ON } else { C_OFF })
                        .monospace(),
                );
            });
            if !inp.keys_pressed.is_empty() {
                ui.horizontal(|ui| {
                    ui.label(egui::RichText::new("keys").color(C_DIM).monospace());
                    ui.label(
                        egui::RichText::new(format!("{:?}", inp.keys_pressed))
                            .color(C_TEXT)
                            .monospace(),
                    );
                });
            }

            ui.separator();

            // Game-level input state arrives as a generic snapshot on this
            // slot — reuse the generic renderer's section rendering.
            super::generic::render_sections(state, ui, PanelId::Input);
        });
}
