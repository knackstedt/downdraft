// lib.rs — downdraft-devtools: egui (CPU-only) native devtools overlay.
//
// This crate runs egui's layout + tessellation on the CPU and serializes the
// resulting PaintJobs (clipped textured-triangle meshes) + texture deltas into
// a flat byte buffer. The TS side (EguiRenderer) uploads + draws those on the
// shared wgpu-native device via the existing wgpu-ffi bindings, then composites
// the UI texture over the frame via UiBlitPass.
//
// All data sources (CDP bridge, scene store, GPU info, ProfilingSAB) live in TS
// and are mirrored into Rust via the dd_devtools_* FFI functions below.

mod panels;
mod state;

use std::collections::{HashSet, VecDeque};
use std::os::raw::c_char;

use state::{
    CdpProfile, ConsoleEntry, ConsoleSeverity, ConsoleState, EvalRequest, EvalResult, GpuInfoSnapshot,
    GpuKvEntry, InputState, MetricsSnapshot, PanelId, ProfileNode, ThreadInfo, ThreadMetricsSample,
    ThreadMetricsSlot, TreeSnapshot, TreeNode,
};

/// Opaque handle returned to TS.
pub struct DevtoolsState {
    pub ctx: egui::Context,
    pub input: InputState,
    pub width: f32,
    pub height: f32,
    pub pixels_per_point: f32,
    pub start: std::time::Instant,
    pub frame_id: u32,
    pub frame_start_us: f64,
    pub active_panel: PanelId,
    pub console: ConsoleState,
    pub scene_tree: TreeSnapshot,
    pub dom_tree: TreeSnapshot,
    pub gpu_info: GpuInfoSnapshot,
    pub profile: Option<CdpProfile>,
    pub metrics: MetricsSnapshot,
    pub scene_expanded: HashSet<u32>,
    pub scene_selected: Option<u32>,
    pub dom_expanded: HashSet<u32>,
    pub dom_selected: Option<u32>,
    pub perf_recording: bool,
    pub eval_requests: VecDeque<EvalRequest>,
    pub eval_results: Vec<EvalResult>,
    pub next_eval_id: u64,
    // Refresh-request flags (TS polls + clears these).
    pub scene_refresh_requested: bool,
    pub dom_refresh_requested: bool,
    pub gpu_refresh_requested: bool,
    pub metrics_refresh_requested: bool,
    pub perf_record_requested: bool,
    pub perf_stop_requested: bool,
}

impl DevtoolsState {
    fn new(width: f32, height: f32, dpr: f32) -> Self {
        let ctx = egui::Context::default();
        ctx.set_pixels_per_point(dpr);
        configure_style(&ctx);
        Self {
            ctx,
            input: InputState::default(),
            width,
            height,
            pixels_per_point: dpr,
            start: std::time::Instant::now(),
            frame_id: 0,
            frame_start_us: 0.0,
            active_panel: PanelId::Console,
            console: ConsoleState::default(),
            scene_tree: TreeSnapshot::default(),
            dom_tree: TreeSnapshot::default(),
            gpu_info: GpuInfoSnapshot::default(),
            profile: None,
            metrics: MetricsSnapshot::default(),
            scene_expanded: HashSet::new(),
            scene_selected: None,
            dom_expanded: HashSet::new(),
            dom_selected: None,
            perf_recording: false,
            eval_requests: VecDeque::new(),
            eval_results: Vec::new(),
            next_eval_id: 0,
            scene_refresh_requested: false,
            dom_refresh_requested: false,
            gpu_refresh_requested: false,
            metrics_refresh_requested: false,
            perf_record_requested: false,
            perf_stop_requested: false,
        }
    }
}

// ── Serialization format magic ──
const MAGIC: u32 = 0xDDDD_0001;
const OVERFLOW: usize = usize::MAX;

// ============================================================================
// FFI exports
// ============================================================================

#[no_mangle]
pub extern "C" fn dd_devtools_init(width: f32, height: f32, dpr: f32) -> *mut DevtoolsState {
    let state = DevtoolsState::new(width, height, dpr);
    Box::into_raw(Box::new(state))
}

#[no_mangle]
pub extern "C" fn dd_devtools_destroy(handle: *mut DevtoolsState) {
    if !handle.is_null() {
        unsafe { drop(Box::from_raw(handle)) };
    }
}

#[no_mangle]
pub extern "C" fn dd_devtools_resize(handle: *mut DevtoolsState, width: f32, height: f32) {
    let s = unsafe_mut(handle);
    if let Some(s) = s {
        s.width = width;
        s.height = height;
    }
}

#[no_mangle]
pub extern "C" fn dd_devtools_set_visible(_handle: *mut DevtoolsState, _visible: i32) {
    // Visibility is managed by TS (it only calls update() when visible).
}

#[no_mangle]
pub extern "C" fn dd_devtools_set_active_panel(handle: *mut DevtoolsState, panel: u8) {
    if let Some(s) = unsafe_mut(handle) {
        s.active_panel = PanelId::from_u8(panel);
    }
}

// ── Input ──

#[no_mangle]
pub extern "C" fn dd_devtools_set_mouse_pos(handle: *mut DevtoolsState, x: f32, y: f32) {
    if let Some(s) = unsafe_mut(handle) {
        let (ox, oy) = s.input.mouse_pos;
        s.input.mouse_delta = (x - ox, y - oy);
        s.input.mouse_pos = (x, y);
        s.input.mouse_in_window = true;
    }
}

#[no_mangle]
pub extern "C" fn dd_devtools_mouse_leave(handle: *mut DevtoolsState) {
    if let Some(s) = unsafe_mut(handle) {
        s.input.mouse_in_window = false;
    }
}

#[no_mangle]
pub extern "C" fn dd_devtools_mouse_button(
    handle: *mut DevtoolsState,
    button: u8,
    pressed: i32,
) {
    if let Some(s) = unsafe_mut(handle) {
        let idx = (button as usize).min(2);
        s.input.mouse_down[idx] = pressed != 0;
        s.input.mouse_events.push_back((idx, pressed != 0));
    }
}

#[no_mangle]
pub extern "C" fn dd_devtools_set_wheel(handle: *mut DevtoolsState, delta_y: f32) {
    if let Some(s) = unsafe_mut(handle) {
        s.input.wheel += delta_y;
    }
}

#[no_mangle]
pub extern "C" fn dd_devtools_set_modifiers(
    handle: *mut DevtoolsState,
    alt: i32,
    ctrl: i32,
    shift: i32,
) {
    if let Some(s) = unsafe_mut(handle) {
        s.input.modifiers_alt = alt != 0;
        s.input.modifiers_ctrl = ctrl != 0;
        s.input.modifiers_shift = shift != 0;
    }
}

#[no_mangle]
pub extern "C" fn dd_devtools_key_down(handle: *mut DevtoolsState, key_name: *const c_char) {
    if let Some(s) = unsafe_mut(handle) {
        if let Some(name) = unsafe { cstr_to_str(key_name) } {
            if let Some(k) = key_from_name(name) {
                s.input.keys_pressed.push(k);
            }
        }
    }
}

#[no_mangle]
pub extern "C" fn dd_devtools_text_input(handle: *mut DevtoolsState, text: *const c_char) {
    if let Some(s) = unsafe_mut(handle) {
        if let Some(t) = unsafe { cstr_to_str(text) } {
            s.input.text.push_str(t);
        }
    }
}

// ── Data mirror ──

#[no_mangle]
pub extern "C" fn dd_devtools_push_console(
    handle: *mut DevtoolsState,
    text: *const u8,
    text_len: u64,
    severity: u8,
    thread: *const u8,
    thread_len: u64,
    timestamp: f64,
    has_stack: i32,
) {
    if let Some(s) = unsafe_mut(handle) {
        let text = unsafe { read_str(text, text_len) }.unwrap_or_default();
        let thread = unsafe { read_str(thread, thread_len) }.unwrap_or_else(|| "main".to_string());
        s.console.entries.push(ConsoleEntry {
            text,
            severity: ConsoleSeverity::from_u8(severity),
            thread,
            timestamp,
            has_stack: has_stack != 0,
        });
        if s.console.entries.len() > 1000 {
            s.console.entries.remove(0);
        }
    }
}

#[no_mangle]
pub extern "C" fn dd_devtools_push_repl_result(
    handle: *mut DevtoolsState,
    text: *const u8,
    text_len: u64,
    is_error: i32,
    timestamp: f64,
) {
    if let Some(s) = unsafe_mut(handle) {
        let text = unsafe { read_str(text, text_len) }.unwrap_or_default();
        s.console.entries.push(ConsoleEntry {
            text,
            severity: if is_error != 0 { ConsoleSeverity::ReplError } else { ConsoleSeverity::Repl },
            thread: s.console.selected_thread.clone(),
            timestamp,
            has_stack: false,
        });
        if s.console.entries.len() > 1000 {
            s.console.entries.remove(0);
        }
    }
}

#[no_mangle]
pub extern "C" fn dd_devtools_clear_console(handle: *mut DevtoolsState) {
    if let Some(s) = unsafe_mut(handle) {
        s.console.entries.clear();
    }
}

#[no_mangle]
pub extern "C" fn dd_devtools_set_threads(handle: *mut DevtoolsState, buf: *const u8, len: u64) {
    if let Some(s) = unsafe_mut(handle) {
        if let Some(slice) = unsafe { read_buf(buf, len) } {
            let mut r = Reader::new(slice);
            let count = r.read_u32();
            let mut threads = Vec::with_capacity(count as usize);
            for _ in 0..count {
                let kind = r.read_u8();
                let id = r.read_str_u16();
                let name = r.read_str_u16();
                threads.push(ThreadInfo { id, name, kind });
            }
            s.console.threads = threads;
        }
    }
}

#[no_mangle]
pub extern "C" fn dd_devtools_set_scene_tree(handle: *mut DevtoolsState, buf: *const u8, len: u64) {
    if let Some(s) = unsafe_mut(handle) {
        if let Some(slice) = unsafe { read_buf(buf, len) } {
            s.scene_tree.nodes = decode_tree(slice);
        }
    }
}

#[no_mangle]
pub extern "C" fn dd_devtools_set_dom_tree(handle: *mut DevtoolsState, buf: *const u8, len: u64) {
    if let Some(s) = unsafe_mut(handle) {
        if let Some(slice) = unsafe { read_buf(buf, len) } {
            s.dom_tree.nodes = decode_tree(slice);
        }
    }
}

#[no_mangle]
pub extern "C" fn dd_devtools_set_gpu_info(handle: *mut DevtoolsState, buf: *const u8, len: u64) {
    if let Some(s) = unsafe_mut(handle) {
        if let Some(slice) = unsafe { read_buf(buf, len) } {
            let mut r = Reader::new(slice);
            let entry_count = r.read_u32();
            let mut entries = Vec::with_capacity(entry_count as usize);
            for _ in 0..entry_count {
                let is_header = r.read_u8() != 0;
                let key = r.read_str_u16();
                let value = r.read_str_u16();
                entries.push(GpuKvEntry { key, value, is_header });
            }
            let ft_count = r.read_u32();
            let mut frame_times = Vec::with_capacity(ft_count as usize);
            for _ in 0..ft_count {
                let cpu = r.read_f32();
                let gpu = r.read_f32();
                frame_times.push([cpu, gpu]);
            }
            let mem_count = r.read_u32();
            let mut mem = Vec::with_capacity(mem_count as usize);
            for _ in 0..mem_count {
                mem.push(r.read_f64());
            }
            s.gpu_info = GpuInfoSnapshot { entries, frame_times, mem_history: mem };
        }
    }
}

#[no_mangle]
pub extern "C" fn dd_devtools_set_profile(handle: *mut DevtoolsState, buf: *const u8, len: u64) {
    if let Some(s) = unsafe_mut(handle) {
        if let Some(slice) = unsafe { read_buf(buf, len) } {
            s.profile = Some(decode_profile(slice));
        }
    }
}

#[no_mangle]
pub extern "C" fn dd_devtools_set_metrics(handle: *mut DevtoolsState, buf: *const u8, len: u64) {
    if let Some(s) = unsafe_mut(handle) {
        if let Some(slice) = unsafe { read_buf(buf, len) } {
            s.metrics = decode_metrics(slice);
        }
    }
}

// ── Eval round-trip ──

/// Returns the expr length (0 = no request). Writes request_id (u64) to
/// out_request_id, thread (null-terminated) to out_thread, expr bytes to out_expr.
#[no_mangle]
pub extern "C" fn dd_devtools_take_eval_request(
    handle: *mut DevtoolsState,
    out_request_id: *mut u64,
    out_thread: *mut u8,
    out_thread_cap: u64,
    out_expr: *mut u8,
    out_expr_cap: u64,
) -> u64 {
    let s = match unsafe_mut(handle) {
        Some(s) => s,
        None => return 0,
    };
    let req = match s.eval_requests.pop_front() {
        Some(r) => r,
        None => {
            if !out_request_id.is_null() {
                unsafe { *out_request_id = 0 };
            }
            return 0;
        }
    };
    if !out_request_id.is_null() {
        unsafe { *out_request_id = req.request_id };
    }
    // Write thread null-terminated.
    if !out_thread.is_null() {
        let cap = out_thread_cap as usize;
        let bytes = req.thread_id.as_bytes();
        let n = bytes.len().min(cap.saturating_sub(1));
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), out_thread, n);
            *out_thread.add(n) = 0;
        }
    }
    // Write expr bytes.
    let expr_bytes = req.expr.as_bytes();
    let cap = out_expr_cap as usize;
    if expr_bytes.len() <= cap && !out_expr.is_null() {
        unsafe {
            std::ptr::copy_nonoverlapping(expr_bytes.as_ptr(), out_expr, expr_bytes.len());
        }
        expr_bytes.len() as u64
    } else if !out_expr.is_null() && cap > 0 {
        let n = cap.min(expr_bytes.len());
        unsafe {
            std::ptr::copy_nonoverlapping(expr_bytes.as_ptr(), out_expr, n);
        }
        n as u64
    } else {
        // Still count as taken; TS will see a truncated expr.
        expr_bytes.len() as u64
    }
}

#[no_mangle]
pub extern "C" fn dd_devtools_push_eval_result(
    handle: *mut DevtoolsState,
    request_id: u64,
    text: *const u8,
    text_len: u64,
    is_error: i32,
) {
    if let Some(s) = unsafe_mut(handle) {
        let text = unsafe { read_str(text, text_len) }.unwrap_or_default();
        s.eval_results.push(EvalResult { request_id, text: text.clone(), is_error: is_error != 0 });
        // Also push into the console as a REPL result entry.
        s.console.entries.push(ConsoleEntry {
            text,
            severity: if is_error != 0 { ConsoleSeverity::ReplError } else { ConsoleSeverity::Repl },
            thread: s.console.selected_thread.clone(),
            timestamp: (s.start.elapsed().as_secs_f64() * 1000.0),
            has_stack: false,
        });
        if s.console.entries.len() > 1000 {
            s.console.entries.remove(0);
        }
    }
}

// ── Refresh requests (bitmask: 1=scene 2=dom 4=gpu 8=metrics 16=perf_record 32=perf_stop) ──

#[no_mangle]
pub extern "C" fn dd_devtools_take_refresh_requests(handle: *mut DevtoolsState) -> u32 {
    if let Some(s) = unsafe_mut(handle) {
        let mut mask = 0u32;
        if s.scene_refresh_requested { mask |= 1; s.scene_refresh_requested = false; }
        if s.dom_refresh_requested { mask |= 2; s.dom_refresh_requested = false; }
        if s.gpu_refresh_requested { mask |= 4; s.gpu_refresh_requested = false; }
        if s.metrics_refresh_requested { mask |= 8; s.metrics_refresh_requested = false; }
        if s.perf_record_requested { mask |= 16; s.perf_record_requested = false; }
        if s.perf_stop_requested { mask |= 32; s.perf_stop_requested = false; }
        mask
    } else {
        0
    }
}

/// Returns the current DOM tree mode (0=pixi, 1=ecs). TS reads this to know
/// which data source to push when REFRESH_DOM is requested.
#[no_mangle]
pub extern "C" fn dd_devtools_get_dom_tree_mode(handle: *mut DevtoolsState) -> u8 {
    if let Some(s) = unsafe_mut(handle) {
        s.dom_tree.mode
    } else {
        0
    }
}

// ── Update: run egui, tessellate, serialize PaintJobs ──

#[no_mangle]
pub extern "C" fn dd_devtools_update(
    handle: *mut DevtoolsState,
    out_ptr: *mut u8,
    out_cap: u64,
) -> u64 {
    let s = match unsafe_mut(handle) {
        Some(s) => s,
        None => return 0,
    };
    s.frame_id = s.frame_id.wrapping_add(1);
    s.frame_start_us = s.start.elapsed().as_secs_f64() * 1e6;

    let ctx = s.ctx.clone();
    let input = build_raw_input(s);
    ctx.begin_pass(input);

    // Drain pending eval results into the console (already pushed by FFI; nothing
    // extra needed here — results are appended in dd_devtools_push_eval_result).
    s.eval_results.clear();

    build_dock_ui(s, &ctx);

    let full_output = ctx.end_pass();
    let paint_jobs = ctx.tessellate(full_output.shapes, full_output.pixels_per_point);
    let textures_delta = full_output.textures_delta;

    let written = serialize_paint_jobs(&paint_jobs, &textures_delta, s.pixels_per_point, s.frame_id, out_ptr, out_cap as usize);
    clear_per_frame_input(s);
    match written {
        Some(n) => n as u64,
        None => OVERFLOW as u64,
    }
}

#[no_mangle]
pub extern "C" fn dd_devtools_wants_text_input(handle: *mut DevtoolsState) -> i32 {
    if let Some(s) = unsafe_mut(handle) {
        let ctx = s.ctx.clone();
        ctx.wants_keyboard_input() as i32
    } else {
        0
    }
}

// ============================================================================
// egui UI: dock layout
// ============================================================================

// ── Chrome-DevTools-inspired palette ──
const C_BG_DOCK: egui::Color32 = egui::Color32::from_rgb(0x20, 0x21, 0x24);
const C_BG_PANEL: egui::Color32 = egui::Color32::from_rgb(0x1a, 0x1b, 0x1e);
const C_BG_HEADER: egui::Color32 = egui::Color32::from_rgb(0x28, 0x29, 0x2c);
const C_BG_HOVER: egui::Color32 = egui::Color32::from_rgba_premultiplied(255, 255, 255, 14);
const C_BG_ACTIVE: egui::Color32 = egui::Color32::from_rgb(0x2a, 0x2c, 0x31);
const C_BORDER: egui::Color32 = egui::Color32::from_rgb(0x3c, 0x40, 0x43);
const C_ACCENT: egui::Color32 = egui::Color32::from_rgb(0x8a, 0xb4, 0xf8);
const C_TEXT: egui::Color32 = egui::Color32::from_rgb(0xe8, 0xea, 0xed);
const C_TEXT_DIM: egui::Color32 = egui::Color32::from_rgb(0x9a, 0xa0, 0xa6);
const C_TEXT_FAINT: egui::Color32 = egui::Color32::from_rgb(0x5f, 0x63, 0x68);

/// Configure the egui Context with a tuned dark theme + spacing so the
/// devtools overlay matches a modern debugger aesthetic rather than egui's
/// default grey-blue look. Idempotent; called once at init.
fn configure_style(ctx: &egui::Context) {
    let mut v = egui::Visuals::dark();
    v.panel_fill = C_BG_DOCK;
    v.extreme_bg_color = C_BG_PANEL;
    v.faint_bg_color = egui::Color32::from_rgb(0x1c, 0x1e, 0x22);
    v.hyperlink_color = C_ACCENT;
    v.selection.bg_fill = egui::Color32::from_rgba_premultiplied(0x8a, 0xb4, 0xf8, 60);
    v.selection.stroke = egui::Stroke::new(1.0, C_ACCENT);
    // Widget palette — tune the noninteractive + button colors.
    v.widgets.noninteractive.bg_fill = C_BG_DOCK;
    v.widgets.noninteractive.weak_bg_fill = egui::Color32::TRANSPARENT;
    v.widgets.noninteractive.fg_stroke = egui::Stroke::new(1.0, C_TEXT_DIM);
    v.widgets.noninteractive.bg_stroke = egui::Stroke::new(1.0, C_BORDER);
    v.widgets.noninteractive.corner_radius = egui::CornerRadius::same(3);
    v.widgets.inactive.bg_fill = egui::Color32::from_rgb(0x2a, 0x2c, 0x31);
    v.widgets.inactive.weak_bg_fill = egui::Color32::from_rgb(0x2a, 0x2c, 0x31);
    v.widgets.inactive.fg_stroke = egui::Stroke::new(1.0, C_TEXT);
    v.widgets.inactive.bg_stroke = egui::Stroke::new(1.0, C_BORDER);
    v.widgets.inactive.corner_radius = egui::CornerRadius::same(3);
    v.widgets.hovered.bg_fill = egui::Color32::from_rgb(0x35, 0x37, 0x3c);
    v.widgets.hovered.weak_bg_fill = egui::Color32::from_rgb(0x35, 0x37, 0x3c);
    v.widgets.hovered.fg_stroke = egui::Stroke::new(1.0, C_TEXT);
    v.widgets.hovered.bg_stroke = egui::Stroke::new(1.0, C_BORDER);
    v.widgets.hovered.corner_radius = egui::CornerRadius::same(3);
    v.widgets.active.bg_fill = C_BG_ACTIVE;
    v.widgets.active.weak_bg_fill = C_BG_ACTIVE;
    v.widgets.active.fg_stroke = egui::Stroke::new(1.0, C_TEXT);
    v.widgets.active.bg_stroke = egui::Stroke::new(1.0, C_ACCENT);
    v.widgets.active.corner_radius = egui::CornerRadius::same(3);
    v.widgets.open.bg_fill = C_BG_ACTIVE;
    v.widgets.open.weak_bg_fill = C_BG_ACTIVE;
    ctx.set_visuals(v);

    let mut style = (*ctx.style()).clone();
    style.spacing.item_spacing = egui::vec2(6.0, 4.0);
    style.spacing.button_padding = egui::vec2(8.0, 3.0);
    style.spacing.window_margin = egui::Margin::same(6);
    style.spacing.scroll.bar_width = 10.0;
    style.spacing.scroll.bar_inner_margin = 2.0;
    // Slightly larger, crisper text.
    style.override_text_style = Some(egui::TextStyle::Body);
    ctx.set_style(style);
}

fn build_dock_ui(state: &mut DevtoolsState, ctx: &egui::Context) {
    // Backdrop over the game area (left of the dock). The egui texture is
    // alpha-composited over the frame, so this dims the game.
    egui::CentralPanel::default()
        .frame(egui::Frame::none())
        .show(ctx, |ui| {
            let rect = ui.max_rect();
            ui.painter().rect_filled(
                rect,
                0.0,
                egui::Color32::from_rgba_premultiplied(0, 0, 0, 120),
            );
        });

    egui::SidePanel::right("devtools_dock")
        .resizable(true)
        .width_range(320.0..=2400.0)
        .default_width(560.0)
        .frame(
            egui::Frame::group(&ctx.style())
                .fill(C_BG_DOCK)
                .stroke(egui::Stroke::new(1.0, C_BORDER))
                .inner_margin(egui::Margin::same(6)),
        )
        .show(ctx, |ui| {
            // ── Tab bar ──
            render_tab_bar(state, ui);
            // Separator under the tab bar (full dock width).
            ui.painter().line_segment(
                [
                    egui::pos2(ui.min_rect().left(), ui.min_rect().bottom()),
                    egui::pos2(ui.max_rect().right(), ui.min_rect().bottom()),
                ],
                egui::Stroke::new(1.0, C_BORDER),
            );
            ui.add_space(2.0);

            // Panel content area — fill the remaining dock area with a dark
            // background so switching tabs never shows the game through.
            let content_rect = ui.max_rect();
            ui.painter().rect_filled(content_rect, 0.0, C_BG_PANEL);

            // Reserve a status bar at the bottom; render the panel in the rest.
            let status_h = 18.0;
            let avail = ui.available_size();
            let content_h = (avail.y - status_h - 6.0).max(64.0);
            egui::Frame::none()
                .inner_margin(egui::Margin::same(4))
                .show(ui, |ui| {
                    ui.allocate_ui(egui::vec2(avail.x, content_h), |ui| {
                        panels::render_panel(state, ui);
                    });
                });

            // ── Status bar ──
            render_status_bar(state, ui);
        });
}

/// Chrome-DevTools-style tab bar: flat tabs with an accent underline on the
/// active tab and a subtle hover background.
fn render_tab_bar(state: &mut DevtoolsState, ui: &mut egui::Ui) {
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 1.0;
        for panel in PanelId::ALL {
            let active = state.active_panel == panel;
            let label_color = if active { C_TEXT } else { C_TEXT_DIM };
            let mut label = egui::RichText::new(panel.label()).color(label_color);
            if active {
                label = label.strong();
            }
            let btn = egui::Button::new(label)
                .min_size(egui::vec2(74.0, 26.0))
                .fill(if active {
                    C_BG_ACTIVE
                } else {
                    egui::Color32::TRANSPARENT
                })
                .stroke(egui::Stroke::NONE);
            let resp = ui.add(btn);
            if active {
                // Accent underline along the bottom of the active tab.
                let r = resp.rect;
                ui.painter().line_segment(
                    [
                        egui::pos2(r.left() + 6.0, r.bottom() - 1.0),
                        egui::pos2(r.right() - 6.0, r.bottom() - 1.0),
                    ],
                    egui::Stroke::new(2.0, C_ACCENT),
                );
            } else if resp.hovered() {
                ui.painter()
                    .rect_filled(resp.rect, egui::CornerRadius::same(3), C_BG_HOVER);
            }
            if resp.clicked() {
                state.active_panel = panel;
            }
        }
    });
}

/// Bottom status bar: shows live counters (FPS, console entries, threads,
/// recording state) like Chrome DevTools' footer.
fn render_status_bar(state: &DevtoolsState, ui: &mut egui::Ui) {
    let rect = ui.max_rect();
    let bar = egui::Rect::from_min_size(
        egui::pos2(rect.left(), rect.bottom() - 18.0),
        egui::vec2(rect.width(), 18.0),
    );
    ui.painter().rect_filled(bar, 0.0, C_BG_HEADER);
    ui.painter().line_segment(
        [bar.left_top(), bar.right_top()],
        egui::Stroke::new(1.0, C_BORDER),
    );
    ui.allocate_ui_at_rect(bar, |ui| {
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 10.0;
            ui.add_space(6.0);
            // FPS from the most recent GPU frame-time sample.
            let fps = state
                .gpu_info
                .frame_times
                .last()
                .map(|[cpu, _]| if *cpu > 0.0 { 1000.0 / cpu } else { 0.0 })
                .unwrap_or(0.0);
            status_chip(ui, &format!("{:.0} fps", fps), C_ACCENT);
            status_label(ui, &format!("{} logs", state.console.entries.len()));
            status_label(
                ui,
                &format!("{} threads", state.console.threads.len().max(1)),
            );
            if state.perf_recording {
                status_chip(ui, "● REC", egui::Color32::from_rgb(0xf2, 0x80, 0x80));
            }
            // Right-aligned active panel name.
            let panel_name = state.active_panel.label();
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                ui.add_space(6.0);
                ui.label(
                    egui::RichText::new(panel_name)
                        .color(C_TEXT_FAINT)
                        .small(),
                );
            });
        });
    });
}

fn status_label(ui: &mut egui::Ui, text: &str) {
    ui.label(egui::RichText::new(text).color(C_TEXT_DIM).small());
}

fn status_chip(ui: &mut egui::Ui, text: &str, color: egui::Color32) {
    ui.label(egui::RichText::new(text).color(color).small().strong());
}

// ============================================================================
// RawInput construction
// ============================================================================

fn build_raw_input(s: &DevtoolsState) -> egui::RawInput {
    let mut events: Vec<egui::Event> = Vec::new();
    let mods = egui::Modifiers {
        alt: s.input.modifiers_alt,
        ctrl: s.input.modifiers_ctrl,
        shift: s.input.modifiers_shift,
        mac_cmd: false,
        command: s.input.modifiers_ctrl,
    };
    let pos = egui::pos2(s.input.mouse_pos.0, s.input.mouse_pos.1);

    if s.input.mouse_in_window {
        if s.input.mouse_delta != (0.0, 0.0) {
            events.push(egui::Event::PointerMoved(pos));
        }
        for (idx, pressed) in s.input.mouse_events.iter() {
            let button = match idx {
                0 => egui::PointerButton::Primary,
                1 => egui::PointerButton::Secondary,
                _ => egui::PointerButton::Middle,
            };
            events.push(egui::Event::PointerButton {
                pos,
                button,
                pressed: *pressed,
                modifiers: mods,
            });
        }
        if s.input.wheel.abs() > 0.0 {
            events.push(egui::Event::MouseWheel {
                unit: egui::MouseWheelUnit::Point,
                delta: egui::vec2(0.0, -s.input.wheel * 0.05),
                modifiers: mods,
            });
        }
    }

    for k in &s.input.keys_pressed {
        if let Some(key) = egui_key(*k) {
            events.push(egui::Event::Key {
                key,
                physical_key: None,
                pressed: true,
                repeat: false,
                modifiers: mods,
            });
        }
    }
    if !s.input.text.is_empty() {
        events.push(egui::Event::Text(s.input.text.clone()));
    }

    egui::RawInput {
        screen_rect: Some(egui::Rect::from_min_size(
            egui::pos2(0.0, 0.0),
            egui::vec2(s.width, s.height),
        )),
        time: Some(s.start.elapsed().as_secs_f64()),
        predicted_dt: 1.0 / 60.0,
        modifiers: mods,
        events,
        focused: true,
        ..Default::default()
    }
}

fn clear_per_frame_input(s: &mut DevtoolsState) {
    s.input.mouse_delta = (0.0, 0.0);
    s.input.mouse_events.clear();
    s.input.wheel = 0.0;
    s.input.keys_pressed.clear();
    s.input.text.clear();
}

// ============================================================================
// PaintJobs serialization
// ============================================================================

fn serialize_paint_jobs(
    paint_jobs: &[egui::ClippedPrimitive],
    textures_delta: &egui::TexturesDelta,
    pixels_per_point: f32,
    frame_id: u32,
    out_ptr: *mut u8,
    out_cap: usize,
) -> Option<usize> {
    // First pass: compute total size to check capacity.
    let mut size = 24usize; // header
    for cp in paint_jobs {
        if let epaint::Primitive::Mesh(mesh) = &cp.primitive {
            size += 16 + 8 + 8; // clip rect(16) + tex_id(8) + counts(8)
            size += mesh.vertices.len() * 20;
            size += mesh.indices.len() * 4;
        }
    }
    for (id, delta) in &textures_delta.set {
        let (w, h) = image_size(&delta.image);
        size += 8 + 8 + 8 + (w * h * 4) as usize; // id(8) + pos(8) + size(8) + pixels
        let _ = id;
    }
    for _ in &textures_delta.free {
        size += 8;
    }
    if size > out_cap {
        return None;
    }

    let mut w = Writer::new(out_ptr);
    w.write_u32(MAGIC);
    w.write_u32(paint_jobs.len() as u32);
    w.write_u32(textures_delta.set.len() as u32);
    w.write_u32(textures_delta.free.len() as u32);
    w.write_f32(pixels_per_point);
    w.write_u32(frame_id);

    // Texture sets
    for (id, delta) in &textures_delta.set {
        w.write_u64(texture_id_u64(*id));
        match delta.pos {
            Some(p) => {
                w.write_i32(p[0] as i32);
                w.write_i32(p[1] as i32);
            }
            None => {
                w.write_i32(-1);
                w.write_i32(-1);
            }
        }
        let (width, height) = image_size(&delta.image);
        w.write_u32(width as u32);
        w.write_u32(height as u32);
        write_image_pixels(&mut w, &delta.image, width, height);
    }
    // Texture frees
    for id in &textures_delta.free {
        w.write_u64(texture_id_u64(*id));
    }
    // Clips
    for cp in paint_jobs {
        let rect = cp.clip_rect;
        w.write_f32(rect.min.x);
        w.write_f32(rect.min.y);
        w.write_f32(rect.max.x - rect.min.x);
        w.write_f32(rect.max.y - rect.min.y);
        if let epaint::Primitive::Mesh(mesh) = &cp.primitive {
            w.write_u64(texture_id_u64(mesh.texture_id));
            w.write_u32(mesh.vertices.len() as u32);
            w.write_u32(mesh.indices.len() as u32);
            for v in &mesh.vertices {
                w.write_f32(v.pos.x);
                w.write_f32(v.pos.y);
                w.write_f32(v.uv.x);
                w.write_f32(v.uv.y);
                // Color32 -> 4 bytes RGBA
                let c = v.color;
                w.write_u8(c.r());
                w.write_u8(c.g());
                w.write_u8(c.b());
                w.write_u8(c.a());
            }
            for idx in &mesh.indices {
                w.write_u32(*idx);
            }
        } else {
            // Non-mesh primitive (e.g. Callback) — skip but keep header consistent.
            w.write_u64(0);
            w.write_u32(0);
            w.write_u32(0);
        }
    }
    Some(w.pos)
}

fn texture_id_u64(id: epaint::TextureId) -> u64 {
    match id {
        epaint::TextureId::Managed(n) => n,
        epaint::TextureId::User(n) => n,
    }
}

fn image_size(img: &egui::ImageData) -> (usize, usize) {
    match img {
        egui::ImageData::Font(f) => (f.size[0], f.size[1]),
        egui::ImageData::Color(c) => (c.size[0], c.size[1]),
    }
}

fn write_image_pixels(w: &mut Writer, img: &egui::ImageData, width: usize, height: usize) {
    match img {
        egui::ImageData::Font(f) => {
            // Font images are single-channel f32 alpha; convert to RGBA (white opaque).
            for p in f.pixels.iter().take(width * height) {
                let a = (*p * 255.0).clamp(0.0, 255.0) as u8;
                w.write_u8(255);
                w.write_u8(255);
                w.write_u8(255);
                w.write_u8(a);
            }
        }
        egui::ImageData::Color(c) => {
            for p in c.pixels.iter().take(width * height) {
                w.write_u8(p.r());
                w.write_u8(p.g());
                w.write_u8(p.b());
                w.write_u8(p.a());
            }
        }
    }
}

// ============================================================================
// Buffer decoders (TS → Rust flat formats)
// ============================================================================

fn decode_tree(slice: &[u8]) -> Vec<TreeNode> {
    let mut r = Reader::new(slice);
    let count = r.read_u32();
    let mut nodes = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let id = r.read_u32();
        let parent_id = r.read_i32();
        let depth = r.read_u16();
        let child_count = r.read_u32();
        let kind = r.read_u8();
        let label = r.read_str_u16();
        let detail = r.read_str_u16();
        nodes.push(TreeNode { id, parent_id, depth, child_count, kind, label, detail });
    }
    nodes
}

fn decode_profile(slice: &[u8]) -> CdpProfile {
    let mut r = Reader::new(slice);
    let node_count = r.read_u32();
    let mut nodes = Vec::with_capacity(node_count as usize);
    for _ in 0..node_count {
        let id = r.read_u32();
        let hit_count = r.read_u32();
        let call_frame = r.read_str_u16();
        let url = r.read_str_u16();
        let line = r.read_u32();
        let children_count = r.read_u32();
        let mut children = Vec::with_capacity(children_count as usize);
        for _ in 0..children_count {
            children.push(r.read_u32());
        }
        nodes.push(ProfileNode { id, call_frame, url, line, hit_count, children });
    }
    let start_us = r.read_f64();
    let end_us = r.read_f64();
    let sample_count = r.read_u32();
    let mut samples = Vec::with_capacity(sample_count as usize);
    for _ in 0..sample_count {
        samples.push(r.read_u32());
    }
    let delta_count = r.read_u32();
    let mut time_deltas_us = Vec::with_capacity(delta_count as usize);
    for _ in 0..delta_count {
        time_deltas_us.push(r.read_f64());
    }
    CdpProfile { nodes, start_us, end_us, samples, time_deltas_us }
}

fn decode_metrics(slice: &[u8]) -> MetricsSnapshot {
    let mut r = Reader::new(slice);
    let slot_count = r.read_u32();
    let mut slots = Vec::with_capacity(slot_count as usize);
    for _ in 0..slot_count {
        let slot_index = r.read_u32();
        let runtime = r.read_u8();
        let name = r.read_str_u16();
        let sample_count = r.read_u32();
        let mut history = Vec::with_capacity(sample_count as usize);
        for _ in 0..sample_count {
            let cpu_percent = r.read_f32();
            let heap_used = r.read_f64();
            let heap_total = r.read_f64();
            let gc_pause_max_us = r.read_f64();
            let task_latency_p95_us = r.read_f64();
            history.push(ThreadMetricsSample {
                cpu_percent,
                heap_used,
                heap_total,
                gc_pause_max_us,
                task_latency_p95_us,
            });
        }
        slots.push(ThreadMetricsSlot { slot_index, name, runtime, history });
    }
    MetricsSnapshot { slots }
}

// ============================================================================
// Helpers: unsafe pointer access, Reader/Writer, key mapping
// ============================================================================

fn unsafe_mut<'a>(handle: *mut DevtoolsState) -> Option<&'a mut DevtoolsState> {
    unsafe { handle.as_mut() }
}

unsafe fn read_str(ptr: *const u8, len: u64) -> Option<String> {
    if ptr.is_null() || len == 0 {
        return None;
    }
    let slice = std::slice::from_raw_parts(ptr, len as usize);
    String::from_utf8(slice.to_vec()).ok()
}

unsafe fn read_buf(ptr: *const u8, len: u64) -> Option<&'static [u8]> {
    if ptr.is_null() || len == 0 {
        return None;
    }
    Some(std::slice::from_raw_parts(ptr, len as usize))
}

unsafe fn cstr_to_str<'a>(ptr: *const c_char) -> Option<&'a str> {
    if ptr.is_null() {
        return None;
    }
    let bytes = std::ffi::CStr::from_ptr(ptr).to_bytes();
    std::str::from_utf8(bytes).ok()
}

/// Tiny sequential reader over a byte slice (TS→Rust flat formats).
struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}
impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }
    fn take(&mut self, n: usize) -> &[u8] {
        let end = (self.pos + n).min(self.buf.len());
        let s = &self.buf[self.pos..end];
        self.pos = end;
        s
    }
    fn read_u32(&mut self) -> u32 {
        let mut b = [0u8; 4];
        b.copy_from_slice(self.take(4));
        u32::from_le_bytes(b)
    }
    fn read_i32(&mut self) -> i32 {
        let mut b = [0u8; 4];
        b.copy_from_slice(self.take(4));
        i32::from_le_bytes(b)
    }
    fn read_u16(&mut self) -> u16 {
        let mut b = [0u8; 2];
        b.copy_from_slice(self.take(2));
        u16::from_le_bytes(b)
    }
    fn read_u8(&mut self) -> u8 {
        self.take(1)[0]
    }
    fn read_f32(&mut self) -> f32 {
        let mut b = [0u8; 4];
        b.copy_from_slice(self.take(4));
        f32::from_le_bytes(b)
    }
    fn read_f64(&mut self) -> f64 {
        let mut b = [0u8; 8];
        b.copy_from_slice(self.take(8));
        f64::from_le_bytes(b)
    }
    fn read_str_u16(&mut self) -> String {
        let len = self.read_u16() as usize;
        let bytes = self.take(len);
        String::from_utf8_lossy(bytes).into_owned()
    }
}

/// Tiny sequential writer into an FFI-provided buffer (Rust→TS PaintJobs).
struct Writer {
    ptr: *mut u8,
    pos: usize,
}
impl Writer {
    fn new(ptr: *mut u8) -> Self {
        Self { ptr, pos: 0 }
    }
    fn write_bytes(&mut self, src: &[u8]) {
        unsafe {
            std::ptr::copy_nonoverlapping(src.as_ptr(), self.ptr.add(self.pos), src.len());
        }
        self.pos += src.len();
    }
    fn write_u32(&mut self, v: u32) {
        self.write_bytes(&v.to_le_bytes());
    }
    fn write_i32(&mut self, v: i32) {
        self.write_bytes(&v.to_le_bytes());
    }
    fn write_u16(&mut self, v: u16) {
        self.write_bytes(&v.to_le_bytes());
    }
    fn write_u64(&mut self, v: u64) {
        self.write_bytes(&v.to_le_bytes());
    }
    fn write_f32(&mut self, v: f32) {
        self.write_bytes(&v.to_le_bytes());
    }
    fn write_f64(&mut self, v: f64) {
        self.write_bytes(&v.to_le_bytes());
    }
    fn write_u8(&mut self, v: u8) {
        unsafe { *self.ptr.add(self.pos) = v };
        self.pos += 1;
    }
}

// ── Key name → egui Key index ──
fn key_from_name(name: &str) -> Option<u8> {
    Some(match name {
        "ArrowDown" => 0,
        "ArrowLeft" => 1,
        "ArrowRight" => 2,
        "ArrowUp" => 3,
        "Escape" => 4,
        "Tab" => 5,
        "Backspace" => 6,
        "Enter" => 7,
        "Space" => 8,
        "Insert" => 9,
        "Delete" => 10,
        "Home" => 11,
        "End" => 12,
        "PageUp" => 13,
        "PageDown" => 14,
        "F1" => 15,
        "F2" => 16,
        "F3" => 17,
        "F4" => 18,
        "F5" => 19,
        "F6" => 20,
        "F7" => 21,
        "F8" => 22,
        "F9" => 23,
        "F10" => 24,
        "F11" => 25,
        "F12" => 26,
        _ => return None,
    })
}

fn egui_key(idx: u8) -> Option<egui::Key> {
    Some(match idx {
        0 => egui::Key::ArrowDown,
        1 => egui::Key::ArrowLeft,
        2 => egui::Key::ArrowRight,
        3 => egui::Key::ArrowUp,
        4 => egui::Key::Escape,
        5 => egui::Key::Tab,
        6 => egui::Key::Backspace,
        7 => egui::Key::Enter,
        8 => egui::Key::Space,
        9 => egui::Key::Insert,
        10 => egui::Key::Delete,
        11 => egui::Key::Home,
        12 => egui::Key::End,
        13 => egui::Key::PageUp,
        14 => egui::Key::PageDown,
        15 => egui::Key::F1,
        16 => egui::Key::F2,
        17 => egui::Key::F3,
        18 => egui::Key::F4,
        19 => egui::Key::F5,
        20 => egui::Key::F6,
        21 => egui::Key::F7,
        22 => egui::Key::F8,
        23 => egui::Key::F9,
        24 => egui::Key::F10,
        25 => egui::Key::F11,
        26 => egui::Key::F12,
        _ => return None,
    })
}
