// panels/perf_recorder.rs — Performance recorder: CDP Profiler → flame chart.

use crate::state::PanelId;
use crate::DevtoolsState;

pub fn render(state: &mut DevtoolsState, ui: &mut egui::Ui) {
    ui.horizontal(|ui| {
        let profiling = state.perf_recording;
        if ui.add_enabled(!profiling, egui::Button::new("Record")).clicked() {
            state.perf_recording = true;
            state.perf_record_requested = true;
        }
        if ui.add_enabled(profiling, egui::Button::new("Stop")).clicked() {
            state.perf_recording = false;
            state.perf_stop_requested = true;
        }
        if profiling {
            ui.label(
                egui::RichText::new("\u{25cf} recording")
                    .color(egui::Color32::from_rgb(240, 90, 90)),
            );
        }
    });
    ui.separator();

    let prof = match &state.profile {
        Some(p) if !p.nodes.is_empty() => p,
        _ => {
            ui.label(
                egui::RichText::new("No profile recorded. Click Record, wait, then Stop.")
                    .color(egui::Color32::from_gray(130)),
            );
            let _ = PanelId::PerfRecorder;
            return;
        }
    };

    // Build a flat flame chart from the profile nodes.
    // Each node: [start_us, end_us, depth, label]. We compute per-node time
    // ranges from samples + time_deltas, falling back to even distribution.
    let total_us = (prof.end_us - prof.start_us).max(1.0);
    ui.label(
        egui::RichText::new(format!(
            "Profile: {} nodes, {} samples, {:.2} ms",
            prof.nodes.len(),
            prof.samples.len(),
            total_us / 1000.0
        ))
        
        .color(egui::Color32::from_gray(140)),
    );

    // Compute per-node self time from samples.
    let mut self_time: std::collections::HashMap<u32, f64> = std::collections::HashMap::new();
    for &s in &prof.samples {
        *self_time.entry(s).or_default() += 0.0;
    }
    let mut t = prof.start_us;
    for (i, &s) in prof.samples.iter().enumerate() {
        let dt = prof.time_deltas_us.get(i).copied().unwrap_or(0.0);
        *self_time.entry(s).or_default() += dt;
        t += dt;
    }
    let _ = t;

    // Compute depth via BFS from roots (nodes not referenced as children).
    let mut depth: std::collections::HashMap<u32, u32> = std::collections::HashMap::new();
    let roots: Vec<u32> = prof
        .nodes
        .iter()
        .filter(|n| !prof.nodes.iter().any(|o| o.children.contains(&n.id)))
        .map(|n| n.id)
        .collect();
    let by_id: std::collections::HashMap<u32, &crate::state::ProfileNode> =
        prof.nodes.iter().map(|n| (n.id, n)).collect();
    let mut queue: std::collections::VecDeque<(u32, u32)> =
        roots.iter().map(|r| (*r, 0)).collect();
    while let Some((id, d)) = queue.pop_front() {
        depth.insert(id, d);
        if let Some(n) = by_id.get(&id) {
            for c in &n.children {
                queue.push_back((*c, d + 1));
            }
        }
    }

    // Render the flame chart as stacked horizontal bars.
    let (resp, painter) = ui.allocate_painter(ui.available_size_before_wrap(), egui::Sense::hover());
    let rect = resp.rect;
    let painter = &painter;
    painter.rect_filled(rect, 0.0, egui::Color32::from_rgb(12, 12, 20));

    let row_h = 16.0;
    let max_depth = depth.values().copied().max().unwrap_or(0).min(40) + 1;
    let chart_h = (max_depth as f32 * row_h).min(rect.height());
    let x_for = |us: f64| rect.left() + ((us - prof.start_us) / total_us) as f32 * rect.width();

    // Color palette by depth.
    let palette = [
        egui::Color32::from_rgb(230, 120, 80),
        egui::Color32::from_rgb(230, 200, 80),
        egui::Color32::from_rgb(120, 220, 120),
        egui::Color32::from_rgb(120, 200, 240),
        egui::Color32::from_rgb(200, 140, 240),
        egui::Color32::from_rgb(240, 140, 160),
    ];

    for n in &prof.nodes {
        let d = *depth.get(&n.id).unwrap_or(&0);
        if d >= 40 {
            continue;
        }
        let self_t = *self_time.get(&n.id).unwrap_or(&0.0);
        if self_t <= 0.0 && n.hit_count == 0 {
            continue;
        }
        let start = prof.start_us; // simplified: place by self-time accumulation
        // We approximate each node's span by its self-time at its depth.
        let bar_w = (self_t / total_us * rect.width() as f64) as f32;
        if bar_w < 1.0 {
            continue;
        }
        let y = rect.top() + d as f32 * row_h;
        let x = x_for(start);
        let bar_rect = egui::Rect::from_min_size(egui::pos2(x, y), egui::vec2(bar_w, row_h - 1.0));
        let color = palette[(d as usize) % palette.len()];
        painter.rect_filled(bar_rect, 2.0, color);
        if bar_w > 30.0 {
            let label: String = n.call_frame.chars().take((bar_w / 6.0) as usize).collect();
            painter.text(
                bar_rect.center(),
                egui::Align2::CENTER_CENTER,
                label,
                egui::FontId::proportional(9.0),
                egui::Color32::BLACK,
            );
        }
    }

    let _ = chart_h;
    let _ = PanelId::PerfRecorder;
}
