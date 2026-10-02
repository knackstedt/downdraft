//! window/ — sdl_shim_* exports backed by winit instead of SDL2.
//!
//! Wire contract (must match src/window/sdl-ffi.ts + native-window.ts):
//!   sdl_shim_create_window(title, w, h)          → i32 (0 ok, 1/2 fail)
//!   sdl_shim_get_window_subsystem()              → i32 SDL_SYSWM_* tag
//!   sdl_shim_get_window_size(w_out, h_out)       → void (physical px)
//!   sdl_shim_set_window_title(title)             → void
//!   sdl_shim_poll_event(out_data)                → i32 event type
//!   sdl_shim_wait_event(out_data, timeout_ms)    → i32 event type
//!   sdl_shim_grab_input(grab)                    → void (cursor lock + hide)
//!   sdl_shim_start_text_input / stop_text_input  → void (IME on/off)
//!   sdl_shim_set_text_input_rect(x,y,w,h)        → void (IME cursor area)
//!   sdl_shim_destroy_window()                    → void
//!   sdl_shim_delay(ms)                           → void
//!   sdl_shim_create_wgpu_surface(instance)       → ptr (Phase 5 — stub)
//!   sdl_shim_set_fullscreen(enabled)             → void (borderless)
//!   sdl_shim_get_window_pos(x_out, y_out)        → void (outer pos)
//!   sdl_shim_set_window_pos(x, y)                → void
//!   sdl_shim_get_window_borders(t,l,b,r out)     → i32 (best-effort)
//!   sdl_shim_set_window_size(w, h)               → void
//!   sdl_shim_get_display_info(refresh, scale)    → void
//!   sdl_shim_request_quit()                      → void (pushes QUIT event)
//!   sdl_shim_show_message_box(title, msg)        → i32 (0 ok)
//!   sdl_shim_set_clipboard(text)                 → void
//!   sdl_shim_get_clipboard(out, max_len)         → i32 (snprintf semantics)
//!
//! Event out_data slot layout (all i32 unless noted) — identical to the C shim:
//!   Key:        [0]=SDL3 keycode, [1]=KMOD bitmask, [2]=repeat
//!   Mouse move: [0]=x, [1]=y, [2]=xrel, [3]=yrel, [4]=button bitmask, [5]=mod
//!   Mouse btn:  [0]=x, [1]=y, [2]=button(1=l,2=m,3=r), [3]=button mask, [4]=mod
//!   Wheel:      f32[0]=dx, f32[1]=dy (line detents), [2]=mod, [3]=mx, [4]=my
//!   Resize/Moved: [0],[1]
//!   Text input / drop file: char buffer (31 / 255 bytes + NUL)
//!
//! Threading: on desktop everything runs on the JS main thread exactly like
//! the SDL version. On Android winit's event loop must run on the app thread
//! (created by android_main) while sdl_shim_* calls arrive on the JS thread —
//! so shared state is a Mutex<Ctx> + a cross-thread event queue, and winit's
//! Android Window is Send/Sync by design (operations are queued to the main
//! thread internally).
//! Keycodes: SDL3 values — ASCII for printables, scancode|0x40000000 for
//! named keys — so the existing TS SDL_* tables keep working unchanged.
//! Wheel deltas are line detents; winit PixelDelta is converted (~16px/line).
//! Resize reports *physical* pixels (what the surface needs); SDL reported
//! logical — identical at scale factor 1.0, which is the common case on the
//! native Linux path.

#[cfg(target_os = "android")]
pub mod android;
mod events;
mod keys;

use events::{take, Ev};
use raw_window_handle::{HasDisplayHandle, RawDisplayHandle};
#[cfg(not(target_os = "android"))]
use std::cell::RefCell;
use std::ffi::{c_char, c_int, c_void, CStr};
use std::ptr;
use std::sync::{Arc, Mutex};
use std::time::Duration;
#[cfg(not(target_os = "android"))]
use winit::application::ApplicationHandler;
#[cfg(not(target_os = "android"))]
use winit::dpi::LogicalSize;
use winit::dpi::{PhysicalPosition, PhysicalSize, Position, Size};
#[cfg(not(target_os = "android"))]
use winit::event::{DeviceEvent, WindowEvent};
#[cfg(not(target_os = "android"))]
use winit::event_loop::EventLoop;
#[cfg(not(target_os = "android"))]
use winit::platform::pump_events::EventLoopExtPumpEvents;
use winit::window::{CursorGrabMode, Fullscreen, Window};

/// SDL_SYSWM_* tags (SDL_syswm.h) — sdl_shim_get_window_subsystem wire value.
mod syswm {
    pub const UNKNOWN: i32 = 0;
    pub const WINDOWS: i32 = 1;
    pub const X11: i32 = 2;
    pub const WAYLAND: i32 = 3;
    pub const COCOA: i32 = 4;
    /// SDL_SYSWM_ANDROID (SDL_syswm.h)
    pub const ANDROID: i32 = 13;
}

/// SDL_Keymod bits — combined L|R (TS masks with KMOD_SHIFT etc.).
const KMOD_SHIFT: i32 = 0x0001 | 0x0002;
const KMOD_CTRL: i32 = 0x0040 | 0x0080;
const KMOD_ALT: i32 = 0x0100 | 0x0200;
const KMOD_GUI: i32 = 0x0400 | 0x0800;

struct Ctx {
    /// Arc so Phase 5's create_surface can own a 'static reference.
    window: Option<Arc<Window>>,
    mods: i32,
    /// SDL button-state bitmask (bit n-1 = button n).
    buttons: u32,
    cursor: (f64, f64),
    grabbed: bool,
    text_input: bool,
}

/// Shared window/app state. On Android the winit loop runs on the app thread
/// (downdraft_platform_android_main) while all sdl_shim_* calls come from the
/// JS thread, so this is a Mutex; on desktop the same fns run on one thread
/// and the lock is never contended.
static CTX: Mutex<Option<Ctx>> = Mutex::new(None);

#[cfg(not(target_os = "android"))]
thread_local! {
    /// Separate from CTX: pump_app_events dispatches into the handler, which
    /// borrows CTX — holding the loop's borrow across the call would panic.
    /// ManuallyDrop: the event loop outlives all windows (winit allows one
    /// per process) and must not run its X11 teardown during thread-local
    /// destruction at process exit — that can race the display connection.
    static EVENT_LOOP: RefCell<Option<std::mem::ManuallyDrop<EventLoop<()>>>> =
        const { RefCell::new(None) };
}

/// ApplicationHandler that translates winit events into queued shim events.
/// `resumed`/`window_event` are the trait's required methods.
#[cfg(not(target_os = "android"))]
struct Pump;

#[cfg(not(target_os = "android"))]
impl ApplicationHandler for Pump {
    fn resumed(&mut self, _el: &winit::event_loop::ActiveEventLoop) {}

    fn window_event(
        &mut self,
        el: &winit::event_loop::ActiveEventLoop,
        _id: winit::window::WindowId,
        ev: WindowEvent,
    ) {
        if let Some(ctx) = CTX.lock().unwrap().as_mut() {
            events::translate_window_event(ctx, ev, el);
        }
    }

    fn device_event(
        &mut self,
        _el: &winit::event_loop::ActiveEventLoop,
        _id: winit::event::DeviceId,
        ev: DeviceEvent,
    ) {
        if let Some(ctx) = CTX.lock().unwrap().as_mut() {
            events::translate_device_event(ctx, ev);
        }
    }
}

fn with_ctx<R>(f: impl FnOnce(&mut Ctx) -> R) -> Option<R> {
    CTX.lock().unwrap().as_mut().map(f)
}

/// Pump the winit event queue (pump_events extension — desktop targets only;
/// Android's loop is owned by the app thread in android.rs).
/// Queued events are then drained one per poll call, mirroring SDL_PollEvent.
#[cfg(not(target_os = "android"))]
fn pump(timeout: Option<Duration>) {
    EVENT_LOOP.with(|e| {
        if let Some(l) = e.borrow_mut().as_mut() {
            l.pump_app_events(timeout, &mut Pump);
        }
    });
}

// ── Window creation ──

/// Install `window` into shared state, creating Ctx on first use. Shared by
/// the desktop create_window path and Android's deferred resumed() creation.
pub(crate) fn install_window(window: Arc<Window>) {
    let mut guard = CTX.lock().unwrap();
    match guard.as_mut() {
        Some(ctx) => ctx.window = Some(window),
        None => {
            *guard = Some(Ctx {
                window: Some(window),
                mods: 0,
                buttons: 0,
                cursor: (0.0, 0.0),
                grabbed: false,
                text_input: false,
            });
        }
    }
}

fn cstr_title(title: *const c_char) -> String {
    if title.is_null() {
        "Downdraft".to_string()
    } else {
        unsafe { CStr::from_ptr(title) }
            .to_string_lossy()
            .into_owned()
    }
}

#[cfg(not(target_os = "android"))]
#[no_mangle]
pub extern "C" fn sdl_shim_create_window(
    title: *const c_char,
    width: c_int,
    height: c_int,
) -> c_int {
    ffi!(2, {
        // C semantic: already-live window → 0. A destroyed window (CTX present
        // but window None) falls through and recreates on the kept EventLoop.
        if CTX
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|x| x.window.is_some())
        {
            return 0;
        }
        let title = cstr_title(title);

        let created = EVENT_LOOP.with(|e| -> Result<Arc<Window>, c_int> {
            let mut slot = e.borrow_mut();
            if slot.is_none() {
                match EventLoop::new() {
                    Ok(l) => *slot = Some(std::mem::ManuallyDrop::new(l)),
                    Err(err) => {
                        eprintln!("[downdraft_platform] EventLoop::new failed: {err}");
                        return Err(1);
                    }
                }
            }
            let attrs = Window::default_attributes()
                .with_title(title)
                .with_inner_size(LogicalSize::new(width.max(1) as f64, height.max(1) as f64))
                .with_resizable(true)
                .with_visible(true);
            #[allow(deprecated)]
            match slot.as_ref().unwrap().create_window(attrs) {
                Ok(w) => Ok(Arc::new(w)),
                Err(err) => {
                    eprintln!("[downdraft_platform] create_window failed: {err}");
                    Err(2)
                }
            }
        });
        let window = match created {
            Ok(w) => w,
            Err(code) => return code,
        };
        // SDL centers new windows; winit leaves placement to the WM. Center on
        // the primary monitor for parity.
        if let Some(monitor) = window
            .primary_monitor()
            .or_else(|| window.current_monitor())
        {
            let msize = monitor.size();
            let mpos = monitor.position();
            let wsize = window.outer_size();
            window.set_outer_position(PhysicalPosition::new(
                mpos.x + (msize.width as i32 - wsize.width as i32) / 2,
                mpos.y + (msize.height as i32 - wsize.height as i32) / 2,
            ));
        }

        install_window(window);
        // First pump surfaces Resized/focus so the initial state settles.
        pump(Some(Duration::ZERO));
        0
    })
}

// ── Event polling ──

/// No live window → NONE, same as the C shim's g_window null check. (The
/// EventLoop outlives the window — winit allows only one per process.)
/// Desktop-only — Android's emit must NOT gate on this (see below).
#[cfg(not(target_os = "android"))]
fn no_window() -> bool {
    CTX.lock()
        .unwrap()
        .as_ref()
        .is_none_or(|ctx| ctx.window.is_none())
}

/// Write one queued event into out_data. Returns the SDL_SHIM_EVENT_* type.
/// `timeout` bounds the pump's wait: `Some(ZERO)` = SDL_PollEvent (never
/// blocks); a real duration = SDL_WaitEventTimeout. winit's `pump_app_events`
/// treats `None` as "wait indefinitely", so `None` must never be passed.
#[cfg(not(target_os = "android"))]
fn emit(out_data: *mut c_void, timeout: Option<Duration>) -> c_int {
    if no_window() {
        return events::NONE;
    }
    pump(timeout);
    take()
        .map(|ev| events::write(ev, out_data))
        .unwrap_or(events::NONE)
}

/// Android: the app thread's run_app handler fills the shared queue — poll
/// just drains it. We deliberately do NOT gate on no_window: before the first
/// resumed() there is no window, and RESUMED itself is the event JS waits on.
#[cfg(target_os = "android")]
fn emit(out_data: *mut c_void, _timeout: Option<Duration>) -> c_int {
    take()
        .map(|ev| events::write(ev, out_data))
        .unwrap_or(events::NONE)
}

#[no_mangle]
pub extern "C" fn sdl_shim_poll_event(out_data: *mut c_void) -> c_int {
    // SDL_PollEvent semantics: non-blocking. pump_app_events(None) would wait
    // indefinitely for an event — starving the rAF loop between input bursts.
    ffi!(events::NONE, { emit(out_data, Some(Duration::ZERO)) })
}

#[cfg(not(target_os = "android"))]
#[no_mangle]
pub extern "C" fn sdl_shim_wait_event(out_data: *mut c_void, timeout_ms: u32) -> c_int {
    ffi!(events::NONE, {
        if no_window() {
            std::thread::sleep(Duration::from_millis(timeout_ms as u64));
            return events::NONE;
        }
        emit(out_data, Some(Duration::from_millis(timeout_ms as u64)))
    })
}

/// Android: block on the shared queue's condvar — the app thread pushes and
/// notifies. Not gated on no_window (see emit above).
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn sdl_shim_wait_event(out_data: *mut c_void, timeout_ms: u32) -> c_int {
    ffi!(events::NONE, {
        events::take_timeout(Duration::from_millis(timeout_ms as u64))
            .map(|ev| events::write(ev, out_data))
            .unwrap_or(events::NONE)
    })
}

// ── Input grab ──

#[no_mangle]
pub extern "C" fn sdl_shim_grab_input(grab: c_int) {
    ffi!((), {
        with_ctx(|ctx| {
            let Some(w) = &ctx.window else { return };
            let grab = grab != 0;
            if grab {
                // Locked = raw relative motion; Confined is the fallback for
                // compositors that don't support locking.
                if w.set_cursor_grab(CursorGrabMode::Locked).is_err() {
                    let _ = w.set_cursor_grab(CursorGrabMode::Confined);
                }
                w.set_cursor_visible(false);
            } else {
                let _ = w.set_cursor_grab(CursorGrabMode::None);
                w.set_cursor_visible(true);
            }
            ctx.grabbed = grab;
        });
    });
}

// ── Text input (IME) ──

#[no_mangle]
pub extern "C" fn sdl_shim_start_text_input() {
    ffi!((), {
        with_ctx(|ctx| {
            if let Some(w) = &ctx.window {
                w.set_ime_allowed(true);
                ctx.text_input = true;
            }
        });
    });
}

#[no_mangle]
pub extern "C" fn sdl_shim_stop_text_input() {
    ffi!((), {
        with_ctx(|ctx| {
            if let Some(w) = &ctx.window {
                w.set_ime_allowed(false);
                ctx.text_input = false;
            }
        });
    });
}

#[no_mangle]
pub extern "C" fn sdl_shim_set_text_input_rect(x: c_int, y: c_int, w: c_int, h: c_int) {
    ffi!((), {
        with_ctx(|ctx| {
            if let Some(win) = &ctx.window {
                win.set_ime_cursor_area(
                    Position::Physical(PhysicalPosition::new(x, y)),
                    Size::Physical(PhysicalSize::new(w.max(0) as u32, h.max(0) as u32)),
                );
            }
        });
    });
}

// ── Window queries / mutation ──

#[no_mangle]
pub extern "C" fn sdl_shim_get_window_subsystem() -> c_int {
    ffi!(-1, {
        with_ctx(|ctx| {
            let Some(w) = &ctx.window else {
                return syswm::UNKNOWN;
            };
            match w.display_handle().map(|h| h.as_raw()) {
                Ok(RawDisplayHandle::Xlib(_)) | Ok(RawDisplayHandle::Xcb(_)) => syswm::X11,
                Ok(RawDisplayHandle::Wayland(_)) => syswm::WAYLAND,
                Ok(RawDisplayHandle::Windows(_)) => syswm::WINDOWS,
                Ok(RawDisplayHandle::AppKit(_)) => syswm::COCOA,
                Ok(RawDisplayHandle::Android(_)) => syswm::ANDROID,
                _ => syswm::UNKNOWN,
            }
        })
        .unwrap_or(-1)
    })
}

#[no_mangle]
pub extern "C" fn sdl_shim_get_window_size(w_out: *mut c_int, h_out: *mut c_int) {
    ffi!((), {
        let (mut w, mut h) = (0, 0);
        with_ctx(|ctx| {
            if let Some(win) = &ctx.window {
                let s = win.inner_size();
                w = s.width as c_int;
                h = s.height as c_int;
            }
        });
        unsafe {
            if !w_out.is_null() {
                *w_out = w;
            }
            if !h_out.is_null() {
                *h_out = h;
            }
        }
    });
}

#[no_mangle]
pub extern "C" fn sdl_shim_set_window_title(title: *const c_char) {
    ffi!((), {
        if title.is_null() {
            return;
        }
        let title = unsafe { CStr::from_ptr(title) }
            .to_string_lossy()
            .into_owned();
        with_ctx(|ctx| {
            if let Some(w) = &ctx.window {
                w.set_title(&title);
            }
        });
    });
}

#[no_mangle]
pub extern "C" fn sdl_shim_set_fullscreen(enabled: c_int) {
    ffi!((), {
        with_ctx(|ctx| {
            if let Some(w) = &ctx.window {
                w.set_fullscreen(if enabled != 0 {
                    Some(Fullscreen::Borderless(None))
                } else {
                    None
                });
            }
        });
    });
}

#[no_mangle]
pub extern "C" fn sdl_shim_get_window_pos(x_out: *mut c_int, y_out: *mut c_int) {
    ffi!((), {
        let (mut x, mut y) = (0, 0);
        with_ctx(|ctx| {
            if let Some(w) = &ctx.window {
                if let Ok(p) = w.outer_position() {
                    x = p.x;
                    y = p.y;
                }
            }
        });
        unsafe {
            if !x_out.is_null() {
                *x_out = x;
            }
            if !y_out.is_null() {
                *y_out = y;
            }
        }
    });
}

#[no_mangle]
pub extern "C" fn sdl_shim_set_window_pos(x: c_int, y: c_int) {
    ffi!((), {
        with_ctx(|ctx| {
            if let Some(w) = &ctx.window {
                w.set_outer_position(PhysicalPosition::new(x, y));
            }
        });
    });
}

/// Frame extents — winit has no direct API. Approximate from outer−inner:
/// symmetric side/bottom frames (dw/2 each), titlebar takes the height
/// remainder. Returns -1 when the window isn't up or can't report, matching
/// SDL's pre-framing rc — the only consumer is window-state persistence.
#[no_mangle]
pub extern "C" fn sdl_shim_get_window_borders(
    top_out: *mut c_int,
    left_out: *mut c_int,
    bottom_out: *mut c_int,
    right_out: *mut c_int,
) -> c_int {
    ffi!(-1, {
        let rc = with_ctx(|ctx| {
            let Some(w) = &ctx.window else { return -1 };
            let inner = w.inner_size();
            let outer = w.outer_size();
            let dw = outer.width.saturating_sub(inner.width) as c_int;
            let dh = outer.height.saturating_sub(inner.height) as c_int;
            if dw <= 0 || dh <= 0 {
                return -1; // WM hasn't framed the window yet
            }
            let side = dw / 2;
            let top = (dh - side).max(0);
            unsafe {
                if !top_out.is_null() {
                    *top_out = top;
                }
                if !left_out.is_null() {
                    *left_out = side;
                }
                if !bottom_out.is_null() {
                    *bottom_out = side;
                }
                if !right_out.is_null() {
                    *right_out = side;
                }
            }
            0
        })
        .unwrap_or(-1);
        if rc != 0 {
            unsafe {
                if !top_out.is_null() {
                    *top_out = 0;
                }
                if !left_out.is_null() {
                    *left_out = 0;
                }
                if !bottom_out.is_null() {
                    *bottom_out = 0;
                }
                if !right_out.is_null() {
                    *right_out = 0;
                }
            }
        }
        rc
    })
}

#[no_mangle]
pub extern "C" fn sdl_shim_set_window_size(width: c_int, height: c_int) {
    ffi!((), {
        with_ctx(|ctx| {
            if let Some(w) = &ctx.window {
                let _ = w.request_inner_size(PhysicalSize::new(
                    width.max(1) as u32,
                    height.max(1) as u32,
                ));
            }
        });
    });
}

#[no_mangle]
pub extern "C" fn sdl_shim_get_display_info(refresh_out: *mut c_int, scale_out: *mut f32) {
    ffi!((), {
        let mut refresh = 0;
        let mut scale = 1.0f32;
        with_ctx(|ctx| {
            if let Some(w) = &ctx.window {
                if let Some(m) = w.current_monitor() {
                    if let Some(mhz) = m.refresh_rate_millihertz() {
                        refresh = (mhz / 1000) as c_int;
                    }
                    scale = m.scale_factor() as f32;
                }
            }
        });
        unsafe {
            if !refresh_out.is_null() {
                *refresh_out = refresh;
            }
            if !scale_out.is_null() {
                *scale_out = scale;
            }
        }
    });
}

#[no_mangle]
pub extern "C" fn sdl_shim_request_quit() {
    ffi!((), {
        events::push(Ev::Quit);
    });
}

#[no_mangle]
pub extern "C" fn sdl_shim_show_message_box(title: *const c_char, message: *const c_char) -> c_int {
    ffi!(-1, {
        let title = if title.is_null() {
            "Error".to_string()
        } else {
            unsafe { CStr::from_ptr(title) }
                .to_string_lossy()
                .into_owned()
        };
        let message = if message.is_null() {
            String::new()
        } else {
            unsafe { CStr::from_ptr(message) }
                .to_string_lossy()
                .into_owned()
        };
        // rfd's MessageDialog is modal on all desktop targets; Android has no
        // rfd backend — the message reaches logcat via the shell's fd redirect.
        #[cfg(target_os = "android")]
        eprintln!("[downdraft_platform] message box: {title}: {message}");
        #[cfg(not(target_os = "android"))]
        let _ = rfd::MessageDialog::new()
            .set_level(rfd::MessageLevel::Error)
            .set_title(&title)
            .set_description(&message)
            .show();
        0
    })
}

// ── Clipboard ──

#[cfg(not(target_os = "android"))]
#[no_mangle]
pub extern "C" fn sdl_shim_set_clipboard(text: *const c_char) {
    ffi!((), {
        if text.is_null() {
            return;
        }
        let text = unsafe { CStr::from_ptr(text) }
            .to_string_lossy()
            .into_owned();
        if let Ok(mut cb) = arboard::Clipboard::new() {
            let _ = cb.set_text(text);
        }
    });
}

/// Android: arboard has no Android backend; stub until JNI clipboard lands.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn sdl_shim_set_clipboard(_text: *const c_char) {}

/// Android: no arboard backend — report empty clipboard.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn sdl_shim_get_clipboard(out: *mut c_char, _max_len: c_int) -> c_int {
    ffi!(0, {
        if !out.is_null() {
            unsafe { *out = 0 };
        }
        0
    })
}

/// snprintf semantics: returns the untruncated length, copies max_len-1 + NUL.
#[cfg(not(target_os = "android"))]
#[no_mangle]
pub extern "C" fn sdl_shim_get_clipboard(out: *mut c_char, max_len: c_int) -> c_int {
    ffi!(0, {
        if out.is_null() || max_len <= 0 {
            return 0;
        }
        unsafe { *out = 0 };
        let Ok(mut cb) = arboard::Clipboard::new() else {
            return 0;
        };
        let Ok(text) = cb.get_text() else { return 0 };
        let bytes = text.as_bytes();
        let copy = bytes.len().min(max_len as usize - 1);
        unsafe {
            ptr::copy_nonoverlapping(bytes.as_ptr(), out as *mut u8, copy);
            *out.add(copy) = 0;
        }
        bytes.len() as c_int
    })
}

// ── Lifecycle ──

#[no_mangle]
pub extern "C" fn sdl_shim_destroy_window() {
    ffi!((), {
        events::clear();
        if let Some(ctx) = CTX.lock().unwrap().as_mut() {
            ctx.window = None;
        }
        // Keep EVENT_LOOP alive — winit allows exactly one EventLoop per
        // process, and SDL semantics let games destroy + recreate the window.
    });
}

#[no_mangle]
pub extern "C" fn sdl_shim_delay(ms: u32) {
    ffi!((), {
        std::thread::sleep(Duration::from_millis(ms as u64));
    });
}

// ── wgpu surface ──
// winit's Arc<Window> satisfies wgpu's WindowHandle bound, so the surface is
// created directly — the per-platform X11/Wayland/HWND plumbing the C shim
// needed is inside wgpu.

#[no_mangle]
pub extern "C" fn sdl_shim_create_wgpu_surface(instance: *mut c_void) -> *mut c_void {
    ffi!(ptr::null_mut(), {
        let window = CTX
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|ctx| ctx.window.clone());
        match window {
            Some(w) => crate::gpu::create_surface_for_window(instance, w),
            None => ptr::null_mut(),
        }
    })
}
