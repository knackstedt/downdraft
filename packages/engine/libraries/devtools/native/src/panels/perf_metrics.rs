// panels/perf_metrics.rs — Performance metrics: per-thread CPU/mem/gc charts.

use crate::state::PanelId;
use crate::DevtoolsState;

pub fn render(state: &mut DevtoolsState, ui: &mut egui::Ui) {
    ui.horizontal(|ui| {
        if ui.button("Refresh").clicked() {
            state.metrics_refresh_requested = true;
        }
        ui.label(
            egui::RichText::new(format!("{} threads", state.metrics.slots.len()))
                
                .color(egui::Color32::from_gray(140)),
        );
    });
    ui.separator();

    if state.metrics.slots.is_empty() {
        ui.label(
            egui::RichText::new("No per-thread metrics. ProfilingSAB not attached?")
                .color(egui::Color32::from_gray(130)),
        );
        let _ = PanelId::PerfMetrics;
        return;
    }

    egui::ScrollArea::vertical()
        .auto_shrink([false, false])
        .show(ui, |ui| {
            for slot in &state.metrics.slots {
                egui::CollapsingHeader::new(format!("{} (slot {})", slot.name, slot.slot_index))
                    .default_open(true)
                    .show(ui, |ui| {
                        ui.label(
                            egui::RichText::new(format!("runtime: {}", if slot.runtime == 0 { "js" } else { "wasm" }))
                                
                                .color(egui::Color32::from_gray(140)),
                        );
                        draw_chart(ui, "CPU %", &slot.history, |s| s.cpu_percent as f64, egui::Color32::from_rgb(120, 200, 255));
                        draw_chart(ui, "Heap used (MB)", &slot.history, |s| s.heap_used / 1e6, egui::Color32::from_rgb(255, 180, 80));
                        draw_chart(ui, "Heap total (MB)", &slot.history, |s| s.heap_total / 1e6, egui::Color32::from_rgb(200, 140, 240));
                        draw_chart(ui, "GC pause max (us)", &slot.history, |s| s.gc_pause_max_us, egui::Color32::from_rgb(240, 90, 90));
                        draw_chart(ui, "Task latency p95 (us)", &slot.history, |s| s.task_latency_p95_us, egui::Color32::from_rgb(80, 230, 120));
                    });
            }
        });

    let _ = PanelId::PerfMetrics;
}

fn draw_chart(
    ui: &mut egui::Ui,
    title: &str,
    history: &[crate::state::ThreadMetricsSample],
    val: impl Fn(&crate::state::ThreadMetricsSample) -> f64,
    color: egui::Color32,
) {
    ui.horizontal(|ui| {
        ui.label(egui::RichText::new(title).color(egui::Color32::from_gray(160)));
        if let Some(last) = history.last() {
            ui.label(
                egui::RichText::new(format!("{:.2}", val(last)))
                    
                    .color(color),
            );
        }
    });
    let (resp, painter) = ui.allocate_painter(
        egui::vec2(ui.available_width(), 48.0),
        egui::Sense::hover(),
    );
    let rect = resp.rect;
    let painter = &painter;
    painter.rect_filled(rect, 0.0, egui::Color32::from_rgb(10, 10, 20));
    if history.len() < 2 {
        return;
    }
    let max_v = history.iter().map(|s| val(s)).fold(1.0f64, f64::max).max(1.0);
    let n = history.len() as f32;
    let mut prev: Option<egui::Pos2> = None;
    for (i, s) in history.iter().enumerate() {
        let x = rect.left() + (i as f32 / n.max(1.0)) * rect.width();
        let y = rect.bottom() - (val(s) / max_v) as f32 * rect.height();
        let p = egui::pos2(x, y);
        if let Some(prev) = prev {
            painter.line_segment([prev, p], egui::Stroke::new(1.5, color));
        }
        prev = Some(p);
    }
}
