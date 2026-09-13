// panels/gpu.rs — GPU panel: device info + resources + frame-time graph.

use crate::state::PanelId;
use crate::DevtoolsState;

pub fn render(state: &mut DevtoolsState, ui: &mut egui::Ui) {
    ui.horizontal(|ui| {
        if ui.button("Refresh").clicked() {
            state.gpu_refresh_requested = true;
        }
        ui.label(
            egui::RichText::new(format!("{} entries", state.gpu_info.entries.len()))
                
                .color(egui::Color32::from_gray(140)),
        );
    });
    ui.separator();

    // Everything inside one scroll area so the whole panel scrolls.
    egui::ScrollArea::vertical()
        .auto_shrink([false, false])
        .show(ui, |ui| {
            // ── Frame-time graph ──
            let ft = &state.gpu_info.frame_times;
            if ft.len() >= 2 {
                ui.label(egui::RichText::new("Frame time (ms)").strong().color(egui::Color32::from_gray(200)));
                let (resp, painter) =
                    ui.allocate_painter(egui::vec2(ui.available_width(), 80.0), egui::Sense::hover());
                let rect = resp.rect;
                let painter = &painter;
                painter.rect_filled(rect, 0.0, egui::Color32::from_rgb(14, 14, 28));

                let max_ms = ft
                    .iter()
                    .map(|s| s[0].max(s[1]))
                    .fold(1.0f32, f32::max)
                    .max(1.0);
                let n = ft.len() as f32;
                let w = rect.width();
                let h = rect.height();
                let plot = |idx: usize, val: f32, color: egui::Color32| {
                    let x = rect.left() + (idx as f32 / n.max(1.0)) * w;
                    let y = rect.bottom() - (val / max_ms) * h;
                    (egui::pos2(x, y), color)
                };
                // CPU line
                let mut prev = None;
                for (i, s) in ft.iter().enumerate() {
                    let (p, _) = plot(i, s[0], egui::Color32::from_rgb(120, 200, 255));
                    if let Some(prev) = prev {
                        painter.line_segment([prev, p], egui::Stroke::new(1.5, egui::Color32::from_rgb(120, 200, 255)));
                    }
                    prev = Some(p);
                }
                // GPU line
                let mut prev = None;
                for (i, s) in ft.iter().enumerate() {
                    let (p, _) = plot(i, s[1], egui::Color32::from_rgb(255, 180, 80));
                    if let Some(prev) = prev {
                        painter.line_segment([prev, p], egui::Stroke::new(1.5, egui::Color32::from_rgb(255, 180, 80)));
                    }
                    prev = Some(p);
                }
                ui.horizontal(|ui| {
                    ui.label(egui::RichText::new(format!("max {:.1} ms", max_ms)).color(egui::Color32::from_gray(140)).monospace());
                    ui.add_space(8.0);
                    ui.label(egui::RichText::new("CPU").color(egui::Color32::from_rgb(120, 200, 255)).monospace());
                    ui.add_space(8.0);
                    ui.label(egui::RichText::new("GPU").color(egui::Color32::from_rgb(255, 180, 80)).monospace());
                });
                ui.separator();
            }

            // ── Key/value grid ──
            let stripe = egui::Color32::from_rgb(0x22, 0x23, 0x26);
            for (idx, e) in state.gpu_info.entries.iter().enumerate() {
                if e.is_header {
                    ui.add_space(2.0);
                    ui.label(
                        egui::RichText::new(&e.key)
                            .strong()
                            .color(egui::Color32::from_rgb(80, 230, 120)),
                    );
                    ui.add_space(1.0);
                } else {
                    // Paint stripe background before the horizontal layout,
                    // using the full available row rect from the parent UI.
                    if idx % 2 == 1 {
                        let rect = ui.available_rect_before_wrap();
                        ui.painter().rect_filled(
                            egui::Rect::from_min_size(rect.min, egui::vec2(rect.width(), 18.0)),
                            0.0,
                            stripe,
                        );
                    }
                    ui.horizontal(|ui| {
                        ui.add_space(4.0);
                        ui.label(egui::RichText::new(&e.key).color(egui::Color32::from_gray(160)).monospace());
                        ui.add_space(16.0);
                        ui.label(egui::RichText::new(&e.value).color(egui::Color32::from_gray(230)).monospace());
                    });
                }
            }
        });

    let _ = PanelId::Gpu;
}
