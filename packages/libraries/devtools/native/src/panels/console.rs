// panels/console.rs — Console panel: logs + REPL + thread selector + filters.

use crate::state::{ConsoleSeverity, EvalRequest, PanelId};
use crate::DevtoolsState;

// Built-in autocomplete suggestions (mirrors the PixiJS version).
const BUILTIN_SUGGESTIONS: &[&str] = &[
    "console.log", "console.error", "console.warn", "console.info",
    "JSON.stringify", "JSON.parse", "typeof", "instanceof",
    "Object.keys", "Object.values", "Object.entries",
    "Array.from", "Array.isArray",
    "Math.floor", "Math.ceil", "Math.round", "Math.random",
    "performance.now", "Date.now",
    "process.memoryUsage", "process.cpuUsage",
    "require", "import",
    "await", "async", "function", "return",
    "const", "let", "var",
    "if", "else", "for", "while", "switch", "case",
    "true", "false", "null", "undefined",
];

pub fn render(state: &mut DevtoolsState, ui: &mut egui::Ui) {
    let console = &mut state.console;
    let avail = ui.available_size();

    // ── Filter bar ──
    ui.horizontal(|ui| {
        // Thread selector
        let current_name = console
            .threads
            .iter()
            .find(|t| t.id == console.selected_thread)
            .map(|t| t.name.clone())
            .unwrap_or_else(|| "main".to_string());
        egui::ComboBox::from_id_salt("thread_selector")
            .selected_text(format!("\u{25b8} {}", current_name))
            .width(110.0)
            .show_ui(ui, |ui| {
                for t in &console.threads {
                    let label = format!("{} ({})", t.name, if t.kind == 0 { "main" } else { "worker" });
                    if ui
                        .selectable_label(console.selected_thread == t.id, label)
                        .clicked()
                    {
                        console.selected_thread = t.id.clone();
                    }
                }
            });

        ui.separator();

        // Severity filters
        let filters: [(u8, &str, egui::Color32); 4] = [
            (0, "All", egui::Color32::from_rgb(200, 200, 200)),
            (1, "Errors", egui::Color32::from_rgb(240, 80, 80)),
            (2, "Warnings", egui::Color32::from_rgb(230, 200, 80)),
            (3, "Info", egui::Color32::from_rgb(100, 160, 240)),
        ];
        for (id, label, color) in filters {
            let active = console.filter == id;
            let btn = egui::Button::new(egui::RichText::new(label).color(if active { egui::Color32::WHITE } else { color }))
                .selected(active);
            if ui.add(btn).clicked() {
                console.filter = id;
            }
        }

        ui.separator();

        // Clear
        if ui.button("Clear").clicked() {
            console.entries.clear();
        }
    });

    ui.separator();

    // ── Log area ──
    // Reserve space for the REPL bar at the bottom.
    let repl_h = 28.0;
    let log_h = (avail.y - repl_h - 8.0).max(64.0);

    // Build the filtered, displayed list (newest last, cap 200 to keep
    // tessellated paint jobs within the FFI scratch buffer).
    let display: Vec<&crate::state::ConsoleEntry> = console
        .entries
        .iter()
        .rev()
        .filter(|e| pass_filter(e.severity, console.filter))
        .take(200)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();

    egui::ScrollArea::vertical()
        .max_height(log_h)
        .auto_shrink([false, false])
        .stick_to_bottom(true)
        .show(ui, |ui| {
                    // Header row
                    ui.horizontal(|ui| {
                        ui.add(egui::Label::new(
                            egui::RichText::new("Time").color(egui::Color32::from_gray(140)).monospace(),
                        ));
                        ui.add_space(56.0);
                        ui.add(egui::Label::new(
                            egui::RichText::new("Thread").color(egui::Color32::from_gray(140)).monospace(),
                        ));
                        ui.add_space(64.0);
                        ui.add(egui::Label::new(
                            egui::RichText::new("Message").color(egui::Color32::from_gray(140)).monospace(),
                        ));
                    });
                    ui.separator();

                    if display.is_empty() {
                        ui.add_space(12.0);
                        ui.label(
                            egui::RichText::new("No console entries. Type below to evaluate expressions.")
                                .color(egui::Color32::from_gray(120))
                                ,
                        );
                        ui.label(
                            egui::RichText::new("CDP captures console.log/warn/error from the main isolate.")
                                .color(egui::Color32::from_gray(100))
                                ,
                        );
                        ui.label(
                            egui::RichText::new("Worker threads are evaluated via __devtoolsEval RPC.")
                                .color(egui::Color32::from_gray(100))
                                ,
                        );
                    }

                    // Render entries with timestamp, thread, and message in
                    // aligned columns, with alternating row backgrounds for
                    // readability (Chrome DevTools style).
                    let row_h = 18.0;
                    let stripe = egui::Color32::from_rgb(0x22, 0x23, 0x26);
                    for (idx, e) in display.iter().enumerate() {
                        let (h, m, s, ms) = if e.timestamp > 0.0 {
                            let secs = (e.timestamp / 1000.0) as u64;
                            let ms_part = (e.timestamp as u64) % 1000;
                            let h = (secs / 3600) % 24;
                            let m = (secs / 60) % 60;
                            let s = secs % 60;
                            (h, m, s, ms_part)
                        } else {
                            (0, 0, 0, 0)
                        };
                        let time_str = format!("{:02}:{:02}:{:02}.{:03}", h, m, s, ms);
                        let color = severity_color(e.severity);

                        // Paint stripe background before the horizontal layout,
                        // using the full available row rect from the parent UI.
                        if idx % 2 == 1 {
                            let rect = ui.available_rect_before_wrap();
                            ui.painter().rect_filled(
                                egui::Rect::from_min_size(rect.min, egui::vec2(rect.width(), row_h)),
                                0.0,
                                stripe,
                            );
                        }
                        let row_resp = ui.horizontal(|ui| {
                            ui.add(egui::Label::new(
                                egui::RichText::new(&time_str)
                                    .color(egui::Color32::from_gray(130))
                                    .monospace(),
                            ));
                            ui.add_space(8.0);
                            ui.add(egui::Label::new(
                                egui::RichText::new(&e.thread)
                                    .color(egui::Color32::from_gray(160))
                                    .monospace(),
                            ));
                            ui.add_space(8.0);
                            ui.add(egui::Label::new(
                                egui::RichText::new(&e.text).color(color),
                            ));
                        });
                        // Ensure each row has a consistent height.
                        let _ = row_resp;
                    }
        });

    ui.add_space(4.0);

    // ── REPL bar ──
    ui.horizontal(|ui| {
        let prompt_color = if console.selected_thread == "main" {
            egui::Color32::from_rgb(80, 230, 120)
        } else {
            egui::Color32::from_rgb(230, 200, 80)
        };
        ui.label(egui::RichText::new(">").strong().color(prompt_color));

        // Autocomplete suggestion (ghost text) — show after the input.
        let response = ui.add(
            egui::TextEdit::singleline(&mut console.repl_input)
                .desired_width(avail.x - 40.0)
                .hint_text("Click to evaluate expressions...")
                .id_salt("console_repl"),
        );

        // Submit on Enter when focused.
        if response.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter)) {
            let expr = console.repl_input.trim().to_string();
            if !expr.is_empty() {
                console.repl_history.push(expr.clone());
                if console.repl_history.len() > 100 {
                    console.repl_history.remove(0);
                }
                console.repl_history_idx = -1;
                // Show the input as a REPL entry immediately.
                console.entries.push(crate::state::ConsoleEntry {
                    text: format!("> {}", expr),
                    severity: ConsoleSeverity::Repl,
                    thread: console.selected_thread.clone(),
                    timestamp: (state.frame_start_us / 1000.0) as f64,
                    has_stack: false,
                });
                // Enqueue the eval request for TS to pick up.
                state.next_eval_id = state.next_eval_id.wrapping_add(1);
                state.eval_requests.push_back(EvalRequest {
                    request_id: state.next_eval_id,
                    thread_id: console.selected_thread.clone(),
                    expr,
                });
                console.repl_input.clear();
                response.request_focus();
            }
        }

        // History navigation (Up/Down) while focused.
        if response.has_focus() {
            let hist = &console.repl_history;
            let idx = &mut console.repl_history_idx;
            if ui.input(|i| i.key_pressed(egui::Key::ArrowUp)) && !hist.is_empty() {
                *idx = if *idx < 0 {
                    hist.len() as i32 - 1
                } else {
                    (*idx - 1).max(0)
                };
                if let Some(h) = hist.get(*idx as usize) {
                    console.repl_input = h.clone();
                }
            }
            if ui.input(|i| i.key_pressed(egui::Key::ArrowDown)) {
                if *idx >= 0 {
                    *idx += 1;
                    if *idx >= hist.len() as i32 {
                        *idx = -1;
                        console.repl_input.clear();
                    } else if let Some(h) = hist.get(*idx as usize) {
                        console.repl_input = h.clone();
                    }
                }
            }
            // Tab = autocomplete
            if ui.input(|i| i.key_pressed(egui::Key::Tab)) {
                if let Some(s) = autocomplete(&console.repl_input, hist) {
                    console.repl_input = s;
                }
            }
        }
    });
}

fn pass_filter(sev: ConsoleSeverity, filter: u8) -> bool {
    match filter {
        1 => matches!(sev, ConsoleSeverity::Error | ConsoleSeverity::ReplError),
        2 => matches!(sev, ConsoleSeverity::Warn),
        3 => matches!(
            sev,
            ConsoleSeverity::Info | ConsoleSeverity::Log | ConsoleSeverity::Debug | ConsoleSeverity::Trace
        ),
        _ => true,
    }
}

fn severity_color(sev: ConsoleSeverity) -> egui::Color32 {
    match sev {
        ConsoleSeverity::Error | ConsoleSeverity::ReplError => egui::Color32::from_rgb(240, 90, 90),
        ConsoleSeverity::Warn => egui::Color32::from_rgb(230, 200, 80),
        ConsoleSeverity::Info => egui::Color32::from_rgb(120, 180, 240),
        ConsoleSeverity::Debug | ConsoleSeverity::Trace => egui::Color32::from_rgb(160, 160, 160),
        ConsoleSeverity::Repl => egui::Color32::from_rgb(80, 230, 120),
        ConsoleSeverity::Log => egui::Color32::from_rgb(220, 220, 220),
    }
}

fn thread_color(thread: &str) -> egui::Color32 {
    let palette = [
        egui::Color32::from_rgb(120, 200, 255),
        egui::Color32::from_rgb(255, 180, 120),
        egui::Color32::from_rgb(200, 140, 255),
        egui::Color32::from_rgb(140, 230, 180),
        egui::Color32::from_rgb(255, 140, 160),
        egui::Color32::from_rgb(240, 220, 120),
    ];
    let mut h: u32 = 0;
    for b in thread.bytes() {
        h = h.wrapping_mul(31).wrapping_add(b as u32);
    }
    palette[(h as usize) % palette.len()]
}

fn format_time(ts_ms: f64) -> String {
    // ts_ms is performance.now() in ms. Show HH:MM:SS.mmm relative-ish.
    let secs = (ts_ms / 1000.0) as u64;
    let h = (secs / 3600) % 24;
    let m = (secs / 60) % 60;
    let s = secs % 60;
    let ms = (ts_ms % 1000.0) as u64;
    format!("{:02}:{:02}:{:02}.{:03}", h, m, s, ms)
}

fn autocomplete(input: &str, history: &[String]) -> Option<String> {
    if input.is_empty() {
        return None;
    }
    for h in history.iter().rev() {
        if h.starts_with(input) && h != input {
            return Some(h.clone());
        }
    }
    for s in BUILTIN_SUGGESTIONS {
        if s.starts_with(input) && *s != input {
            return Some(s.to_string());
        }
    }
    None
}

// Allow PanelId comparison in this module.
#[allow(unused_imports)]
use crate::state::PanelId as _PanelId;
