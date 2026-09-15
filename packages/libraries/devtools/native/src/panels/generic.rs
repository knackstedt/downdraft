// panels/generic.rs — renders a GenericSnapshot (KV / table / series /
// lines / controls). Most data-driven panels share this renderer; controls
// queue commands back to TS via state.command_queue.

use crate::state::{
    Control, DevtoolsCommand, KvRow, LineEntry, PanelId, SnapshotSection,
    FLAG_ERROR, FLAG_HEADER, FLAG_WARN, STATUS_ERROR, STATUS_LOADING, STATUS_OK,
    STATUS_UNSUPPORTED,
};
use crate::DevtoolsState;

const C_TEXT: egui::Color32 = egui::Color32::from_rgb(0xe8, 0xea, 0xed);
const C_DIM: egui::Color32 = egui::Color32::from_rgb(0x9a, 0xa0, 0xa6);
const C_FAINT: egui::Color32 = egui::Color32::from_rgb(0x5f, 0x63, 0x68);
const C_HEADER: egui::Color32 = egui::Color32::from_rgb(0x8a, 0xb4, 0xf8);
const C_WARN: egui::Color32 = egui::Color32::from_rgb(0xfd, 0xd6, 0x63);
const C_ERR: egui::Color32 = egui::Color32::from_rgb(0xf2, 0x8b, 0x82);
const C_STRIPE: egui::Color32 = egui::Color32::from_rgb(0x22, 0x23, 0x26);
const C_CHART_BG: egui::Color32 = egui::Color32::from_rgb(0x0a, 0x0a, 0x14);
const SERIES_COLORS: [egui::Color32; 6] = [
    egui::Color32::from_rgb(0x8a, 0xb4, 0xf8),
    egui::Color32::from_rgb(0xfd, 0xd6, 0x63),
    egui::Color32::from_rgb(0x81, 0xc9, 0x95),
    egui::Color32::from_rgb(0xf2, 0x8b, 0x82),
    egui::Color32::from_rgb(0xc5, 0x8a, 0xf9),
    egui::Color32::from_rgb(0x78, 0xd9, 0xec),
];

/// Render the generic snapshot for `panel`. Called by all provider-fed panels.
pub fn render(state: &mut DevtoolsState, ui: &mut egui::Ui, panel: PanelId) {
    let slot = panel.as_u8();

    // Toolbar: Refresh always queues a "refresh" command for this panel.
    ui.horizontal(|ui| {
        if ui.button("Refresh").clicked() {
            state.command_queue.push_back(DevtoolsCommand {
                panel: slot,
                action: "refresh".to_string(),
                payload: String::new(),
            });
        }
        if let Some(snap) = state.snapshots.get(&slot) {
            let status_txt = match snap.status {
                STATUS_OK => format!("{} sections", snap.sections.len()),
                STATUS_LOADING => "loading…".to_string(),
                STATUS_UNSUPPORTED => "unsupported".to_string(),
                STATUS_ERROR => "error".to_string(),
                _ => "?".to_string(),
            };
            ui.label(egui::RichText::new(status_txt).color(C_FAINT));
        } else {
            ui.label(egui::RichText::new("no data").color(C_FAINT));
        }
    });
    ui.separator();

    egui::ScrollArea::vertical()
        .auto_shrink([false, false])
        .show(ui, |ui| {
            render_sections(state, ui, panel);
        });
}

/// Render the snapshot's sections for `panel` into `ui` (no toolbar/scroll —
/// callers that need a bespoke header above the sections use this).
pub fn render_sections(state: &mut DevtoolsState, ui: &mut egui::Ui, panel: PanelId) {
    let slot = panel.as_u8();
    // Take the snapshot out of the map so control widgets can mutate the
    // stored values (checkbox/slider state) while we render.
    let mut snap = match state.snapshots.remove(&slot) {
        Some(s) => s,
        None => {
            ui.label(
                egui::RichText::new("(no snapshot — press Refresh)")
                    .color(egui::Color32::from_gray(120)),
            );
            return;
        }
    };

    // Status banner for non-OK snapshots.
    match snap.status {
        STATUS_LOADING => {
            ui.label(egui::RichText::new("Loading…").color(C_DIM));
        }
        STATUS_UNSUPPORTED => {
            ui.label(
                egui::RichText::new(format!(
                    "Unsupported: {}",
                    if snap.status_msg.is_empty() { "data source unavailable" } else { &snap.status_msg }
                ))
                .color(C_WARN),
            );
        }
        STATUS_ERROR => {
            ui.label(
                egui::RichText::new(format!("Error: {}", snap.status_msg)).color(C_ERR),
            );
        }
        _ => {}
    }

    for section in &mut snap.sections {
        render_section(state, ui, panel, section);
    }
    if snap.sections.is_empty() && snap.status == STATUS_OK {
        ui.label(egui::RichText::new("(empty snapshot)").color(C_FAINT));
    }
    state.snapshots.insert(slot, snap);
}

fn render_section(
    state: &mut DevtoolsState,
    ui: &mut egui::Ui,
    panel: PanelId,
    section: &mut SnapshotSection,
) {
    let name = section.name();
    if !name.is_empty() {
        ui.add_space(4.0);
        ui.label(egui::RichText::new(name).strong().color(C_HEADER));
        ui.add_space(1.0);
    }
    match section {
        SnapshotSection::Kv { rows, .. } => render_kv(ui, rows),
        SnapshotSection::Table { cols, rows, .. } => render_table(ui, cols, rows),
        SnapshotSection::Series { series, .. } => render_series(ui, series),
        SnapshotSection::Lines { lines, .. } => render_lines(ui, lines),
        SnapshotSection::Controls { controls, .. } => {
            render_controls(state, ui, panel, controls)
        }
    }
}

fn flag_color(flags: u8) -> Option<egui::Color32> {
    if flags & FLAG_ERROR != 0 {
        Some(C_ERR)
    } else if flags & FLAG_WARN != 0 {
        Some(C_WARN)
    } else {
        None
    }
}

fn render_kv(ui: &mut egui::Ui, rows: &[KvRow]) {
    for (idx, row) in rows.iter().enumerate() {
        if row.flags & FLAG_HEADER != 0 {
            ui.add_space(2.0);
            ui.label(
                egui::RichText::new(&row.key)
                    .strong()
                    .color(egui::Color32::from_rgb(80, 230, 120)),
            );
            continue;
        }
        if idx % 2 == 1 {
            let rect = ui.available_rect_before_wrap();
            ui.painter().rect_filled(
                egui::Rect::from_min_size(rect.min, egui::vec2(rect.width(), 18.0)),
                0.0,
                C_STRIPE,
            );
        }
        ui.horizontal(|ui| {
            ui.add_space(4.0);
            let key_w = (ui.available_width() * 0.42).min(220.0);
            ui.allocate_ui(egui::vec2(key_w, 18.0), |ui| {
                ui.label(
                    egui::RichText::new(&row.key).color(C_DIM).monospace(),
                );
            });
            let color = flag_color(row.flags).unwrap_or(C_TEXT);
            ui.label(egui::RichText::new(&row.value).color(color).monospace());
        });
    }
}

fn render_table(ui: &mut egui::Ui, cols: &[String], rows: &[Vec<String>]) {
    if cols.is_empty() {
        return;
    }
    let avail_w = ui.available_width();
    let col_w = (avail_w / cols.len() as f32).max(48.0);

    // Header row
    ui.horizontal(|ui| {
        for col in cols {
            ui.allocate_ui(egui::vec2(col_w, 18.0), |ui| {
                ui.label(
                    egui::RichText::new(col).strong().color(C_HEADER).monospace(),
                );
            });
        }
    });
    ui.painter().line_segment(
        [
            egui::pos2(ui.min_rect().left(), ui.min_rect().bottom()),
            egui::pos2(ui.max_rect().right(), ui.min_rect().bottom()),
        ],
        egui::Stroke::new(1.0, egui::Color32::from_rgb(0x3c, 0x40, 0x43)),
    );

    for (idx, row) in rows.iter().enumerate() {
        if idx % 2 == 1 {
            let rect = ui.available_rect_before_wrap();
            ui.painter().rect_filled(
                egui::Rect::from_min_size(rect.min, egui::vec2(rect.width(), 18.0)),
                0.0,
                C_STRIPE,
            );
        }
        ui.horizontal(|ui| {
            for (ci, cell) in row.iter().enumerate() {
                ui.allocate_ui(egui::vec2(col_w, 18.0), |ui| {
                    ui.label(
                        egui::RichText::new(cell)
                            .color(if ci == 0 { C_DIM } else { C_TEXT })
                            .monospace(),
                    );
                });
            }
        });
    }
    if rows.is_empty() {
        ui.label(egui::RichText::new("(no rows)").color(C_FAINT));
    }
}

fn render_series(ui: &mut egui::Ui, series: &[crate::state::SeriesDef]) {
    if series.is_empty() {
        return;
    }
    // Legend row
    ui.horizontal(|ui| {
        for (i, s) in series.iter().enumerate() {
            let color = SERIES_COLORS[i % SERIES_COLORS.len()];
            let last = s.values.last().copied().unwrap_or(0.0);
            ui.label(
                egui::RichText::new(format!("{} {:.2}", s.name, last))
                    .color(color)
                    .monospace(),
            );
            ui.add_space(6.0);
        }
    });
    let (resp, painter) =
        ui.allocate_painter(egui::vec2(ui.available_width(), 56.0), egui::Sense::hover());
    let rect = resp.rect;
    painter.rect_filled(rect, 0.0, C_CHART_BG);

    let max_v = series
        .iter()
        .flat_map(|s| s.values.iter().copied())
        .fold(1.0f32, f32::max)
        .max(1e-6);
    for (i, s) in series.iter().enumerate() {
        let color = SERIES_COLORS[i % SERIES_COLORS.len()];
        let n = s.values.len() as f32;
        let mut prev: Option<egui::Pos2> = None;
        for (j, v) in s.values.iter().enumerate() {
            let x = rect.left() + (j as f32 / n.max(1.0)) * rect.width();
            let y = rect.bottom() - (v / max_v) * rect.height();
            let p = egui::pos2(x, y);
            if let Some(prev) = prev {
                painter.line_segment([prev, p], egui::Stroke::new(1.5, color));
            }
            prev = Some(p);
        }
    }
    ui.label(
        egui::RichText::new(format!("max {:.2}", max_v))
            .color(C_FAINT)
            .monospace(),
    );
}

fn render_lines(ui: &mut egui::Ui, lines: &[LineEntry]) {
    for line in lines {
        let color = flag_color(line.flags).unwrap_or(C_TEXT);
        ui.label(egui::RichText::new(&line.text).color(color).monospace());
    }
    if lines.is_empty() {
        ui.label(egui::RichText::new("(none)").color(C_FAINT));
    }
}

fn render_controls(
    state: &mut DevtoolsState,
    ui: &mut egui::Ui,
    panel: PanelId,
    controls: &mut [Control],
) {
    for ctl in controls.iter_mut() {
        match ctl {
            Control::Button { id, label, payload } => {
                if ui.button(label.clone()).clicked() {
                    state.queue_command(panel, id, payload.clone());
                }
            }
            Control::Checkbox { id, label, checked } => {
                let resp = ui.checkbox(checked, label.clone());
                if resp.changed() {
                    let v = *checked;
                    state.queue_command(panel, id, if v { "1" } else { "0" }.to_string());
                }
            }
            Control::Slider { id, label, value, min, max } => {
                let resp = ui.add(
                    egui::Slider::new(value, *min..=*max).text(label.clone()),
                );
                if resp.changed() {
                    state.queue_command(panel, id, format!("{}", *value));
                }
            }
        }
    }
}
