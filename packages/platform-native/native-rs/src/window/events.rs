//! Event translation: winit events → flat DD_WINDOW_EVENT_* wire format.
//!
//! Queue model: winit's pump delivers a burst of
//! events which we enqueue translated; each dd_window_poll_event call pops
//! one and writes its int/float/char slots.

use super::{window_by_id, Ctx, KMOD_ALT, KMOD_CTRL, KMOD_GUI, KMOD_SHIFT};
use std::collections::VecDeque;
use std::ffi::c_void;
use std::ptr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};
use winit::event::{DeviceEvent, ElementState, Ime, MouseButton, MouseScrollDelta, WindowEvent};
use winit::window::{CursorGrabMode, WindowId};

pub const NONE: i32 = 0;
const QUIT: i32 = 1;
const KEY_DOWN: i32 = 2;
const KEY_UP: i32 = 3;
const MOUSE_MOVE: i32 = 4;
const MOUSE_DOWN: i32 = 5;
const MOUSE_UP: i32 = 6;
const WHEEL: i32 = 7;
const RESIZE: i32 = 8;
const TEXT_INPUT: i32 = 9;
const FOCUS_LOST: i32 = 10;
const MOVED: i32 = 11;
const DROP_FILE: i32 = 12;
const FOCUS_GAINED: i32 = 13;
const SCALE_CHANGED: i32 = 14;
const TOUCH: i32 = 15;
const SUSPENDED: i32 = 16;
const RESUMED: i32 = 17;
const VSYNC: i32 = 18;
/// Secondary-window close request — the OS chrome/X on a non-primary
/// window. JS routes it to that window's handler (primary's close is QUIT).
/// The wid travels in slot 15 like every other event.
const WINDOW_CLOSE: i32 = 19;
/// Global hotkey fired — id in slot 0, wid meaningless (always 0).
const HOTKEY: i32 = 20;
/// Vetoable close request — only pushed when the owning window has
/// dd_window_secondary_set_close_intercept armed. The window stays mapped;
/// JS decides (veto → nothing, accept → destroy/request_quit).
const CLOSE_REQUEST: i32 = 21;
/// OS reports the window fully occluded (slot0 = 1) or revealed (0).
/// Delivered where winit reports WindowEvent::Occluded (Wayland, macOS,
/// Android); absent elsewhere.
const OCCLUDED: i32 = 22;
/// System/window theme changed — slot0 = 0 unknown, 1 light, 2 dark.
const THEME_CHANGED: i32 = 23;

/// Line-detent approximation for pixel-precise scroll deltas (PixelDelta
/// arrives from touchpads; the wire format always reports line units).
const PIXELS_PER_LINE: f32 = 16.0;

pub enum Ev {
    Quit,
    Key {
        down: bool,
        keycode: i32,
        /// Codepoint of the resolved logical character (layout + modifiers
        /// applied — "A" under Shift, "é" on AZERTY), 0 for non-character
        /// keys. The keycode stays unshifted for scancode-style matching;
        /// JS needs this to synthesize a DOM-correct `key`/insert text.
        logical: i32,
        mods: i32,
        repeat: i32,
    },
    MouseMove {
        x: i32,
        y: i32,
        xrel: i32,
        yrel: i32,
        buttons: i32,
        mods: i32,
    },
    MouseBtn {
        down: bool,
        x: i32,
        y: i32,
        button: i32,
        buttons: i32,
        mods: i32,
    },
    Wheel {
        dx: f32,
        dy: f32,
        mods: i32,
        mx: i32,
        my: i32,
    },
    Resize {
        w: i32,
        h: i32,
    },
    Focused {
        gained: bool,
    },
    Moved {
        x: i32,
        y: i32,
    },
    ScaleChanged {
        scale: f64,
    },
    /// Touch contact. phase: 0=down 1=move 2=up 3=cancel (mirrors winit's
    /// TouchPhase order). id is winit's per-pointer id.
    Touch {
        phase: i32,
        id: i32,
        x: i32,
        y: i32,
    },
    /// App suspended — the OS destroyed the surface (Android). JS must drop
    /// the wgpu surface; the window is re-created on the next Resumed.
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    Suspended,
    /// App resumed — a fresh window exists again (Android). JS should
    /// re-create its wgpu surface.
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    Resumed,
    /// Close requested on a secondary window — routed by wid, never a Quit.
    WindowClose,
    /// Vetoable close request (close_intercept armed) — the window stays
    /// mapped; JS chooses whether anything closes.
    CloseRequest,
    /// Window fully occluded (true) or revealed (false) — platform coverage
    /// is whatever winit reports (Wayland/macOS/Android).
    Occluded(bool),
    /// System or window theme changed — 0 unknown, 1 light, 2 dark.
    ThemeChanged(i32),
    /// Global hotkey pressed — carries the grab id from
    /// dd_hotkey_grab. Not window-scoped.
    Hotkey {
        id: i32,
    },
    /// Vsync tick from the Android Choreographer — frameTimeNanos (the frame's
    /// vsync timestamp in SystemClock nanos) carried as the payload. The JS
    /// pump dispatches rAF on these when present instead of its software
    /// timer, so frame production is phase-aligned to the display.
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    Vsync {
        nanos: i64,
    },
    Drop(String),
    Text(String),
}

// Shared across threads: the winit loop runs on a non-JS thread everywhere
// except macOS (app thread on Android, pump thread on Linux/Windows) while
// dd_window_poll_event/wait_event are called from the JS thread — pushers
// and takers genuinely contend.
static QUEUE: Mutex<VecDeque<Queued>> = Mutex::new(VecDeque::new());
static NOTIFY: Condvar = Condvar::new();

struct Queued {
    /// Window handle the event belongs to — 0 for the primary window, else
    /// the handle dd_window_secondary_create returned. Stamped into event slot
    /// 15 so JS routes multi-window traffic without a second queue.
    wid: u32,
    ev: Ev,
    /// Queue-entry stamp — queue residency (at → take) IS the cross-thread
    /// wake latency the pump/condvar design exists to minimize, and it's
    /// the number the pump stats report.
    at: Instant,
}

// ── Pump stats ────────────────────────────────────────────────────────────
// Cumulative counters exported via dd_window_pump_stats — the JS runLoop
// diffs them per stats interval. All relaxed atomic ops; a few nanoseconds
// per event is noise next to a winit dispatch.

static STAT_DELIVERED: AtomicU64 = AtomicU64::new(0);
static STAT_TIMEOUTS: AtomicU64 = AtomicU64::new(0);
static STAT_RESIDENCY_US: AtomicU64 = AtomicU64::new(0);
static STAT_MAX_RESIDENCY_US: AtomicU64 = AtomicU64::new(0);

fn record_take(ev: Option<Queued>) -> Option<(u32, Ev)> {
    match ev {
        Some(q) => {
            let us = q.at.elapsed().as_micros() as u64;
            STAT_DELIVERED.fetch_add(1, Ordering::Relaxed);
            STAT_RESIDENCY_US.fetch_add(us, Ordering::Relaxed);
            STAT_MAX_RESIDENCY_US.fetch_max(us, Ordering::Relaxed);
            Some((q.wid, q.ev))
        }
        None => {
            STAT_TIMEOUTS.fetch_add(1, Ordering::Relaxed);
            None
        }
    }
}

/// Snapshot [delivered, timeouts, residency_us_total, residency_us_max].
/// Non-resetting — callers diff snapshots; a racing push may land between
/// reads but the counters only ever grow. Writes 0s on null.
#[no_mangle]
pub extern "C" fn dd_window_pump_stats(out: *mut i64) {
    if out.is_null() {
        return;
    }
    unsafe {
        *out.add(0) = STAT_DELIVERED.load(Ordering::Relaxed) as i64;
        *out.add(1) = STAT_TIMEOUTS.load(Ordering::Relaxed) as i64;
        *out.add(2) = STAT_RESIDENCY_US.load(Ordering::Relaxed) as i64;
        *out.add(3) = STAT_MAX_RESIDENCY_US.load(Ordering::Relaxed) as i64;
    }
}

pub fn push(wid: u32, ev: Ev) {
    QUEUE.lock().unwrap().push_back(Queued {
        wid,
        ev,
        at: Instant::now(),
    });
    NOTIFY.notify_one();
}

pub fn take() -> Option<(u32, Ev)> {
    record_take(QUEUE.lock().unwrap().pop_front())
}

/// Block up to `timeout` for an event to arrive (wait_event on every
/// queue-driven platform — Android and the desktop pump thread).
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn take_timeout(timeout: Duration) -> Option<(u32, Ev)> {
    let mut guard = QUEUE.lock().unwrap();
    if guard.is_empty() {
        let (g, _) = NOTIFY.wait_timeout(guard, timeout).unwrap();
        guard = g;
    }
    record_take(guard.pop_front())
}

pub fn clear() {
    QUEUE.lock().unwrap().clear();
}

/// Write one queued event into the caller's out_data buffer. Returns the
/// DD_WINDOW_EVENT_* type code (NONE for no event). `wid` (the owning window
/// handle — 0 = primary) is stamped into int slot 15 for every event type;
/// the 64-byte JS buffer leaves it untouched/unread on old shims.
pub fn write(wid: u32, ev: Ev, out_data: *mut c_void) -> i32 {
    if out_data.is_null() {
        return NONE;
    }
    let iout = out_data as *mut i32;
    let fout = out_data as *mut f32;
    unsafe {
        *iout.add(15) = wid as i32;
        match ev {
            Ev::Quit => QUIT,
            Ev::Key {
                down,
                keycode,
                logical,
                mods,
                repeat,
            } => {
                *iout.add(0) = keycode;
                *iout.add(1) = mods;
                *iout.add(2) = if down { repeat } else { 0 };
                *iout.add(3) = logical;
                if down {
                    KEY_DOWN
                } else {
                    KEY_UP
                }
            }
            Ev::MouseMove {
                x,
                y,
                xrel,
                yrel,
                buttons,
                mods,
            } => {
                *iout.add(0) = x;
                *iout.add(1) = y;
                *iout.add(2) = xrel;
                *iout.add(3) = yrel;
                *iout.add(4) = buttons;
                *iout.add(5) = mods;
                MOUSE_MOVE
            }
            Ev::MouseBtn {
                down,
                x,
                y,
                button,
                buttons,
                mods,
            } => {
                *iout.add(0) = x;
                *iout.add(1) = y;
                *iout.add(2) = button;
                *iout.add(3) = buttons;
                *iout.add(4) = mods;
                if down {
                    MOUSE_DOWN
                } else {
                    MOUSE_UP
                }
            }
            Ev::Wheel {
                dx,
                dy,
                mods,
                mx,
                my,
            } => {
                *fout.add(0) = dx;
                *fout.add(1) = dy;
                *iout.add(2) = mods;
                *iout.add(3) = mx;
                *iout.add(4) = my;
                WHEEL
            }
            Ev::Resize { w, h } => {
                *iout.add(0) = w;
                *iout.add(1) = h;
                RESIZE
            }
            Ev::Focused { gained } => {
                if gained {
                    FOCUS_GAINED
                } else {
                    FOCUS_LOST
                }
            }
            Ev::Moved { x, y } => {
                *iout.add(0) = x;
                *iout.add(1) = y;
                MOVED
            }
            Ev::ScaleChanged { scale } => {
                *fout.add(0) = scale as f32;
                SCALE_CHANGED
            }
            Ev::Touch { phase, id, x, y } => {
                *iout.add(0) = phase;
                *iout.add(1) = x;
                *iout.add(2) = y;
                *iout.add(3) = id;
                TOUCH
            }
            Ev::Suspended => SUSPENDED,
            Ev::Resumed => RESUMED,
            Ev::WindowClose => WINDOW_CLOSE,
            Ev::CloseRequest => CLOSE_REQUEST,
            Ev::Occluded(o) => {
                *iout.add(0) = if o { 1 } else { 0 };
                OCCLUDED
            }
            Ev::ThemeChanged(code) => {
                *iout.add(0) = code;
                THEME_CHANGED
            }
            Ev::Hotkey { id } => {
                *iout.add(0) = id;
                HOTKEY
            }
            Ev::Vsync { nanos } => {
                // Wrapping u32 microseconds — deltas between ticks are what
                // matter (refresh derivation); uint32 wrap subtraction keeps
                // them exact. nanos/1e3 wraps at ~71min, deltas stay <2^31.
                *iout.add(0) = (nanos / 1_000) as i32;
                VSYNC
            }
            Ev::Drop(path) => {
                write_cstr(out_data as *mut u8, &path, 255);
                DROP_FILE
            }
            Ev::Text(s) => {
                write_cstr(out_data as *mut u8, &s, 31);
                TEXT_INPUT
            }
        }
    }
}

unsafe fn write_cstr(out: *mut u8, s: &str, max: usize) {
    let bytes = s.as_bytes();
    let n = bytes.len().min(max);
    ptr::copy_nonoverlapping(bytes.as_ptr(), out, n);
    *out.add(n) = 0;
}

pub fn translate_window_event(
    ctx: &mut Ctx,
    id: WindowId,
    ev: WindowEvent,
    _el: &winit::event_loop::ActiveEventLoop,
) {
    let wid = ctx.ids.get(&id).copied().unwrap_or(0);
    match ev {
        WindowEvent::CloseRequested => {
            // Armed intercept: stay mapped and hand JS the decision — the
            // app vetoes (unsaved-changes prompt) or closes itself. The
            // unarmed path keeps the old contract: unmap NOW — after the
            // quit event reaches it, JS runs seconds of teardown (close
            // listeners, surface/device release, worker stops) before
            // dd_window_destroy drops the window. The wgpu surface holds
            // its own Arc<Window>, so the Arc can't be dropped here —
            // hiding reads as an instant close while the process finishes
            // terminating behind it. Secondary windows surface a routed
            // WindowClose instead of a process Quit.
            if ctx.input.get(&id).is_some_and(|st| st.close_intercept) {
                push(wid, Ev::CloseRequest);
            } else {
                if let Some(w) = window_by_id(ctx, id) {
                    w.set_visible(false);
                }
                if wid == 0 {
                    push(0, Ev::Quit);
                } else {
                    push(wid, Ev::WindowClose);
                }
            }
        }

        // Fully occluded/revealed — delivered by Wayland/macOS/Android
        // backends; damage-gated renderers park the frame loop on it.
        WindowEvent::Occluded(occluded) => {
            push(wid, Ev::Occluded(occluded));
        }

        WindowEvent::ThemeChanged(theme) => {
            let code = match theme {
                winit::window::Theme::Light => 1,
                winit::window::Theme::Dark => 2,
            };
            push(wid, Ev::ThemeChanged(code));
        }

        WindowEvent::Resized(size) => {
            push(
                wid,
                Ev::Resize {
                    w: size.width as i32,
                    h: size.height as i32,
                },
            );
        }

        WindowEvent::Moved(pos) => {
            push(wid, Ev::Moved { x: pos.x, y: pos.y });
        }

        // DPI scale change — OS scaling change or drag to a differently-
        // scaled monitor. Resized usually follows; emit both so the host
        // can re-render at the new density.
        WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
            push(
                wid,
                Ev::ScaleChanged {
                    scale: scale_factor,
                },
            );
        }

        WindowEvent::Focused(gained) => {
            if !gained {
                // Drop the cursor grab on focus loss — alt-tab is the user's
                // escape hatch and a captured pointer on an unfocused window
                // traps the cursor with no recourse (XGrabPointer survives
                // the focus switch). The JS side mirrors this through
                // exitPointerLock; releasing here guarantees the OS grab dies
                // even if the JS pump is stalled.
                if ctx.input.get(&id).is_some_and(|st| st.grabbed) {
                    if let Some(w) = window_by_id(ctx, id) {
                        let _ = w.set_cursor_grab(CursorGrabMode::None);
                        w.set_cursor_visible(true);
                    }
                    ctx.input.entry(id).or_default().grabbed = false;
                }
                // Latched input state can't be trusted across a focus
                // transition (alt-tab mid-press/mid-drag leaves phantom
                // buttons and the alt modifier stuck) — real state rebuilds
                // from fresh events on refocus.
                ctx.input.entry(id).or_default().buttons = 0;
                ctx.mods = 0;
            }
            push(wid, Ev::Focused { gained });
        }

        WindowEvent::ModifiersChanged(m) => {
            let s = m.state();
            ctx.mods = (if s.shift_key() { KMOD_SHIFT } else { 0 })
                | (if s.control_key() { KMOD_CTRL } else { 0 })
                | (if s.alt_key() { KMOD_ALT } else { 0 })
                | (if s.super_key() { KMOD_GUI } else { 0 });
        }

        WindowEvent::KeyboardInput { event, .. } => {
            let down = event.state == ElementState::Pressed;
            let keycode = super::keys::wire_keycode(&event);
            push(
                wid,
                Ev::Key {
                    down,
                    keycode,
                    logical: super::keys::logical_char_codepoint(&event),
                    mods: ctx.mods,
                    repeat: if event.repeat { 1 } else { 0 },
                },
            );
            // wire semantics deliver TEXTINPUT after KEYDOWN for printable keys when
            // text input is active. When IME is allowed winit routes text
            // through Ime::Commit instead and event.text is None — no dupes.
            if down && ctx.input.get(&id).is_some_and(|st| st.text_input) {
                if let Some(text) = event.text.as_ref() {
                    // Suppress command chords: winit can report the unmodified
                    // char (Ctrl+A → "a") as key text on X11, which a text
                    // consumer would insert over the selection the chord just
                    // made. GUI/CTRL chords are shortcuts, never text. ALT is
                    // left open — Ctrl+Alt is AltGr on Windows and Alt chords
                    // produce legitimate characters on several layouts.
                    let chorded = (ctx.mods & KMOD_GUI) != 0
                        || (ctx.mods & KMOD_CTRL) != 0 && (ctx.mods & KMOD_ALT) == 0;
                    if !text.is_empty() && !chorded {
                        push(wid, Ev::Text(text.to_string()));
                    }
                }
            }
        }

        WindowEvent::Ime(Ime::Commit(s)) => {
            if ctx.input.get(&id).is_some_and(|st| st.text_input) {
                push(wid, Ev::Text(s));
            }
        }

        WindowEvent::CursorMoved { position, .. } => {
            let st = ctx.input.entry(id).or_default();
            if st.grabbed {
                return; // grabbed motion arrives via DeviceEvent::MouseMotion
            }
            let (lx, ly) = st.cursor;
            let x = position.x.round() as i32;
            let y = position.y.round() as i32;
            let xrel = (position.x - lx).round() as i32;
            let yrel = (position.y - ly).round() as i32;
            st.cursor = (position.x, position.y);
            push(
                wid,
                Ev::MouseMove {
                    x,
                    y,
                    xrel,
                    yrel,
                    buttons: st.buttons as i32,
                    mods: ctx.mods,
                },
            );
        }

        WindowEvent::MouseInput { state, button, .. } => {
            let st = ctx.input.entry(id).or_default();
            let idx = wire_button(button);
            if idx > 0 && idx <= 31 {
                let bit = 1u32 << (idx - 1);
                match state {
                    ElementState::Pressed => st.buttons |= bit,
                    ElementState::Released => st.buttons &= !bit,
                }
            }
            let (cx, cy) = st.cursor;
            push(
                wid,
                Ev::MouseBtn {
                    down: state == ElementState::Pressed,
                    x: cx.round() as i32,
                    y: cy.round() as i32,
                    button: idx,
                    buttons: st.buttons as i32,
                    mods: ctx.mods,
                },
            );
        }

        WindowEvent::MouseWheel { delta, .. } => {
            let (dx, dy) = match delta {
                MouseScrollDelta::LineDelta(x, y) => (x, y),
                MouseScrollDelta::PixelDelta(p) => {
                    (p.x as f32 / PIXELS_PER_LINE, p.y as f32 / PIXELS_PER_LINE)
                }
            };
            let (cx, cy) = ctx.input.entry(id).or_default().cursor;
            push(
                wid,
                Ev::Wheel {
                    dx,
                    dy,
                    mods: ctx.mods,
                    mx: cx.round() as i32,
                    my: cy.round() as i32,
                },
            );
        }

        WindowEvent::DroppedFile(path) => {
            push(wid, Ev::Drop(path.to_string_lossy().into_owned()));
        }

        // Primary input on Android; also reachable on desktop touchscreens.
        // The JS side synthesizes pointer events from these.
        WindowEvent::Touch(touch) => {
            let phase = match touch.phase {
                winit::event::TouchPhase::Started => 0,
                winit::event::TouchPhase::Moved => 1,
                winit::event::TouchPhase::Ended => 2,
                winit::event::TouchPhase::Cancelled => 3,
            };
            push(
                wid,
                Ev::Touch {
                    phase,
                    id: touch.id as i32,
                    x: touch.location.x.round() as i32,
                    y: touch.location.y.round() as i32,
                },
            );
        }

        _ => {}
    }
}

/// Raw device motion — only surfaced while the cursor is grabbed, matching
/// Wire relative-mouse-mode semantics (xrel/yrel only; x/y stay put).
pub fn translate_device_event(ctx: &mut Ctx, ev: DeviceEvent) {
    if let DeviceEvent::MouseMotion { delta } = ev {
        // Relative motion belongs to whichever window owns the pointer grab
        // (only the primary grabs today, but the lookup is handle-agnostic).
        let Some((wid, st)) = ctx
            .input
            .iter_mut()
            .find(|(_, s)| s.grabbed)
            .map(|(id, st)| (ctx.ids.get(id).copied().unwrap_or(0), st))
        else {
            return;
        };
        let (cx, cy) = st.cursor;
        push(
            wid,
            Ev::MouseMove {
                x: cx.round() as i32,
                y: cy.round() as i32,
                xrel: delta.0.round() as i32,
                yrel: delta.1.round() as i32,
                buttons: st.buttons as i32,
                mods: ctx.mods,
            },
        );
    }
}

/// winit MouseButton → wire button number (1=left, 2=middle, 3=right,
/// 4=X1/back, 5=X2/forward).
fn wire_button(b: MouseButton) -> i32 {
    match b {
        MouseButton::Left => 1,
        MouseButton::Middle => 2,
        MouseButton::Right => 3,
        MouseButton::Back => 4,
        MouseButton::Forward => 5,
        MouseButton::Other(v) => 5 + v as i32 + 1, // keep distinct from 1..5
    }
}
