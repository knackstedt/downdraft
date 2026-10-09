//! Generic headless driver: no winit, no web-sys. The host calls `tick`
//! once per frame; it drains pending state/input, polls the vdom, and
//! re-rasterizes with vello_cpu when dirty. `frame` returns the RGBA8
//! buffer which the host uploads to a texture / 2D canvas.
//!
//! Game-specific surface is injected via `ShellConfig`: the Dioxus root
//! component and a snapshot applier that deserializes the raw JSON pushed
//! by `push_snapshot` and writes the game's own UI state inside
//! `vdom.in_scope`.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use anyrender::ImageRenderer;
use anyrender_vello_cpu::VelloCpuImageRenderer;
use atomic_refcell::AtomicRefCell;
use blitz_dom::{BaseDocument, Document};
use blitz_paint::paint_scene;
use blitz_traits::events::{
    BlitzPointerEvent, BlitzPointerId, BlitzWheelDelta, BlitzWheelEvent, MouseEventButton,
    MouseEventButtons, PointerCoords, PointerDetails, UiEvent,
};
use blitz_traits::shell::{ColorScheme, Viewport};
use dioxus_core::{Element, VirtualDom};
use dioxus_native::DioxusDocument;
use web_time::Instant;

use crate::bridge::{BRIDGE, GameBridge};
use crate::input::{PendingInput, mods_from_bits};

/// Game-provided hooks. `apply_snapshot` runs inside `tick` whenever the
/// host pushed raw snapshot JSON — the game deserializes into its own
/// snapshot type and applies it (typically writing a global signal inside
/// `vdom.in_scope(ScopeId::ROOT, ...)`).
pub struct ShellConfig {
    pub root: fn() -> Element,
    /// Returns Err(msg) to log a warning (bad snapshot payload etc.).
    pub apply_snapshot: Rc<dyn Fn(&mut VirtualDom, &str) -> Result<(), String>>,
    /// WOFF/WOFF2 bytes for the single-font fallback context. `None` uses
    /// the engine's embedded DejaVu Sans.
    pub font: Option<&'static [u8]>,
}

pub struct HeadlessShell {
    doc: DioxusDocument,
    renderer: VelloCpuImageRenderer,
    buttons: MouseEventButtons,
    /// Physical-pixel pointer position (mirrors `View::pointer_pos`).
    pointer_pos: (f64, f64),
    active_events: Arc<AtomicRefCell<Vec<BlitzPointerEvent>>>,
    anim_start: Option<Instant>,
    dirty: bool,
    apply_snapshot: Rc<dyn Fn(&mut VirtualDom, &str) -> Result<(), String>>,
}

thread_local! {
    static HEADLESS: RefCell<Option<HeadlessShell>> = const { RefCell::new(None) };
}

fn with_shell<R>(f: impl FnOnce(&mut HeadlessShell) -> R) -> Option<R> {
    HEADLESS.with(|h| h.borrow_mut().as_mut().map(f))
}

impl HeadlessShell {
    fn new(config: ShellConfig, width: u32, height: u32, scale: f32) -> Self {
        let vdom = VirtualDom::new(config.root);
        let mut doc = DioxusDocument::new(
            vdom,
            blitz_dom::DocumentConfig {
                font_ctx: Some(crate::fonts::font_ctx(config.font)),
                viewport: Some(Viewport::new(width, height, scale, ColorScheme::Dark)),
                ..Default::default()
            },
        );
        doc.vdom.insert_any_root_context(Box::new(GameBridge));
        doc.initial_build();

        // Share the document handle for ui_hit_test / ui_dump.
        BRIDGE.with(|b| b.borrow_mut().doc = Some(doc.inner.clone()));

        Self {
            doc,
            renderer: VelloCpuImageRenderer::new(width, height),
            buttons: MouseEventButtons::None,
            pointer_pos: (0.0, 0.0),
            active_events: Arc::new(AtomicRefCell::new(Vec::new())),
            anim_start: None,
            dirty: true,
            apply_snapshot: config.apply_snapshot,
        }
    }

    /// Logical coords from physical px — `View::pointer_coords` with no
    /// safe-area insets.
    fn pointer_coords(&self, x: f64, y: f64) -> PointerCoords {
        let inner = self.doc.inner();
        let scale = inner.viewport().scale_f64();
        let sx = (x / scale) as f32;
        let sy = (y / scale) as f32;
        let scroll = inner.viewport_scroll();
        PointerCoords {
            screen_x: sx,
            screen_y: sy,
            client_x: sx,
            client_y: sy,
            page_x: sx + scroll.x as f32,
            page_y: sy + scroll.y as f32,
        }
    }

    fn dispatch(&mut self, input: &PendingInput) {
        match input {
            PendingInput::Pointer { kind, x, y, button, mods } => {
                self.pointer_pos = (*x, *y);
                let btn = match button {
                    1 => MouseEventButton::Auxiliary,
                    2 => MouseEventButton::Secondary,
                    3 => MouseEventButton::Fourth,
                    4 => MouseEventButton::Fifth,
                    _ => MouseEventButton::Main,
                };
                match kind {
                    1 => self.buttons |= MouseEventButtons::from(btn),
                    2 => self.buttons ^= MouseEventButtons::from(btn),
                    _ => {}
                }
                let event = BlitzPointerEvent {
                    id: BlitzPointerId::Mouse,
                    is_primary: true,
                    coords: self.pointer_coords(*x, *y),
                    button: btn,
                    buttons: self.buttons,
                    mods: mods_from_bits(*mods),
                    details: PointerDetails::default(),
                    element: Default::default(),
                    active_pointers: Arc::clone(&self.active_events),
                };
                let ui_event = match kind {
                    1 => UiEvent::PointerDown(event),
                    2 => UiEvent::PointerUp(event),
                    3 => UiEvent::PointerCancel(event),
                    _ => UiEvent::PointerMove(event),
                };
                // A plain hover move only repaints differently when it changes
                // which element is hovered — the driver fires no DOM events
                // otherwise. Compare hover before/after and skip the raster
                // when nothing changed (every mousemove over the board would
                // otherwise force a full-screen re-raster). Clicks and drags
                // always dirty: they can trigger actions, and held-button
                // gestures (sliders) repaint continuously.
                let prev_hover = if *kind == 0 && self.buttons == MouseEventButtons::None {
                    self.doc.inner().get_hover_node_id()
                } else {
                    None
                };
                self.doc.handle_ui_event(ui_event);
                if *kind == 0 && self.buttons == MouseEventButtons::None {
                    if self.doc.inner().get_hover_node_id() != prev_hover {
                        self.dirty = true;
                    }
                } else {
                    self.dirty = true;
                }
            }
            PendingInput::PointerLeave => {
                let event = BlitzPointerEvent {
                    id: BlitzPointerId::Mouse,
                    is_primary: true,
                    coords: self.pointer_coords(-1.0, -1.0),
                    button: MouseEventButton::Main,
                    buttons: self.buttons,
                    mods: Default::default(),
                    details: PointerDetails::default(),
                    element: Default::default(),
                    active_pointers: Arc::clone(&self.active_events),
                };
                self.doc.handle_ui_event(UiEvent::PointerMove(event));
                self.dirty = true;
            }
            PendingInput::Wheel { dx, dy, x, y, mods } => {
                self.pointer_pos = (*x, *y);
                let event = BlitzWheelEvent {
                    delta: BlitzWheelDelta::Pixels(*dx, *dy),
                    coords: self.pointer_coords(*x, *y),
                    buttons: self.buttons,
                    mods: mods_from_bits(*mods),
                    element: Default::default(),
                };
                self.doc.handle_ui_event(UiEvent::Wheel(event));
                self.dirty = true;
            }
            PendingInput::Key { pressed, key, code, mods, text } => {
                let kev = PendingInput::key_event(*pressed, key, code, *mods, text.clone());
                self.doc.handle_ui_event(if *pressed {
                    UiEvent::KeyDown(kev)
                } else {
                    UiEvent::KeyUp(kev)
                });
                self.dirty = true;
            }
        }
    }

    /// Drain pending snapshot/input, poll the vdom. Returns true when a
    /// re-render is needed.
    fn tick(&mut self) -> bool {
        let snap = BRIDGE.with(|b| b.borrow_mut().pending_snapshot.take());
        if let Some(json) = snap {
            let apply = Rc::clone(&self.apply_snapshot);
            if let Err(e) = apply(&mut self.doc.vdom, &json) {
                crate::console::warn(&format!("ui_set_state: {e}"));
            }
            self.dirty = true;
        }
        loop {
            let input = BRIDGE.with(|b| b.borrow_mut().pending_events.pop_front());
            let Some(input) = input else { break };
            self.dispatch(&input);
        }
        if self.doc.poll(None) {
            self.dirty = true;
        }
        self.dirty
    }

    fn render(&mut self, buffer: &mut Vec<u8>) {
        let t = match self.anim_start {
            Some(start) => Instant::now().duration_since(start).as_secs_f64(),
            None => {
                self.anim_start = Some(Instant::now());
                0.0
            }
        };
        let mut inner = self.doc.inner_mut();
        inner.resolve(t);
        restore_collapsed_borders(&mut inner);
        let (w, h) = inner.viewport().window_size;
        let scale = inner.viewport().scale_f64();
        let is_animating = inner.is_animating();
        let is_blocked = inner.has_pending_critical_resources();
        if !is_blocked {
            // The scene painter retains draw commands across renders —
            // reset first or every frame composites over the last one.
            self.renderer.reset();
            self.renderer.render_to_vec(
                |scene| paint_scene(scene, &mut inner, scale, w, h, 0, 0),
                buffer,
            );
        }
        self.dirty = is_animating;
    }
}

// ---- public API (game crates expose these via #[wasm_bindgen] shims) ----

/// taffy's `round_layout` snaps each border side to whole layout units via
/// `round(c + w) - round(c)`, so a sub-unit border side (a 1px border at
/// zoom 1.25 computes as 0.8px) can round to 0 depending on the node's
/// cumulative position. A zero side makes blitz-paint's corner-split math
/// divide by zero and emit NaN border paths — the adjacent edges (e.g. the
/// left border) then paint nothing. Restore any side taffy collapsed that
/// layout says is nonzero.
fn restore_collapsed_borders(doc: &mut BaseDocument) {
    let root = doc.root_element().id;
    doc.iter_subtree_mut(root, |id, doc| {
        let Some(node) = doc.get_node_mut(id) else {
            return;
        };
        let Some(ld) = node.try_layout_data_mut() else {
            return;
        };
        let ub = ld.unrounded_layout.border;
        let fb = &mut ld.final_layout.border;
        if fb.left == 0.0 && ub.left > 0.0 {
            fb.left = ub.left;
        }
        if fb.right == 0.0 && ub.right > 0.0 {
            fb.right = ub.right;
        }
        if fb.top == 0.0 && ub.top > 0.0 {
            fb.top = ub.top;
        }
        if fb.bottom == 0.0 && ub.bottom > 0.0 {
            fb.bottom = ub.bottom;
        }
    });
}

pub fn init(config: ShellConfig, width: f64, height: f64, scale: f64) {
    console_error_panic_hook::set_once();
    BRIDGE.with(|b| b.borrow_mut().shutdown = false);
    let shell = HeadlessShell::new(
        config,
        width.max(1.0) as u32,
        height.max(1.0) as u32,
        if scale > 0.0 { scale as f32 } else { 1.0 },
    );
    HEADLESS.with(|h| *h.borrow_mut() = Some(shell));
}

pub fn resize(width: f64, height: f64, scale: f64) {
    with_shell(|ui| {
        let w = width.max(1.0) as u32;
        let h = height.max(1.0) as u32;
        {
            let mut inner = ui.doc.inner_mut();
            let mut vp = inner.viewport_mut();
            vp.window_size = (w, h);
            if scale > 0.0 {
                vp.set_hidpi_scale(scale as f32);
            }
        }
        ui.renderer.resize(w, h);
        ui.dirty = true;
    });
}

/// Drain queued work + poll vdom. Returns true if `frame` should be
/// called to get fresh pixels.
pub fn tick() -> bool {
    with_shell(|ui| ui.tick()).unwrap_or(false)
}

/// Rasterize into an RGBA8 buffer. Only call when `tick` returned true.
pub fn frame() -> Vec<u8> {
    let mut buffer = Vec::new();
    with_shell(|ui| ui.render(&mut buffer));
    buffer
}

pub fn shutdown() {
    HEADLESS.with(|h| *h.borrow_mut() = None);
    BRIDGE.with(|b| b.borrow_mut().shutdown = true);
}
