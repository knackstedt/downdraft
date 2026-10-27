//! window/ — dd_window_* exports backed by winit instead of SDL2.
//!
//! Wire contract (must match src/window/window-ffi.ts + native-window.ts):
//!   dd_window_create(title, w, h)          → i32 (0 ok, 1/2 fail)
//!   dd_window_get_subsystem()              → i32 subsystem tag
//!   dd_window_get_size(w_out, h_out)       → void (physical px)
//!   dd_window_set_title(title)             → void
//!   dd_window_focus()                      → void (request activation)
//!   dd_window_poll_event(out_data)                → i32 event type
//!   dd_window_wait_event(out_data, timeout_ms)    → i32 event type
//!   dd_window_grab_input(grab)                    → void (cursor lock + hide)
//!   dd_window_start_text_input / stop_text_input  → void (IME on/off)
//!   dd_window_set_text_input_rect(x,y,w,h)        → void (IME cursor area)
//!   dd_window_destroy()                    → void
//!   dd_window_delay(ms)                           → void
//!   dd_window_create_wgpu_surface(instance)       → ptr (Phase 5 — stub)
//!   dd_window_set_fullscreen(enabled)             → void (borderless)
//!   dd_window_get_pos(x_out, y_out)        → void (outer pos)
//!   dd_window_set_pos(x, y)                → void
//!   dd_window_get_borders(t,l,b,r out)     → i32 (best-effort)
//!   dd_window_set_size(w, h)               → void
//!   dd_window_get_display_info(refresh, scale)    → void
//!   dd_window_request_quit()                      → void (pushes QUIT event)
//!   dd_window_show_message_box(title, msg)        → i32 (0 ok)
//!   dd_window_set_clipboard(text)                 → void
//!   dd_window_get_clipboard(out, max_len)         → i32 (snprintf semantics)
//!
//! Event out_data slot layout (all i32 unless noted) — identical to the C shim:
//!   Key:        [0]=wire keycode, [1]=KMOD bitmask, [2]=repeat
//!   Mouse move: [0]=x, [1]=y, [2]=xrel, [3]=yrel, [4]=button bitmask, [5]=mod
//!   Mouse btn:  [0]=x, [1]=y, [2]=button(1=l,2=m,3=r), [3]=button mask, [4]=mod
//!   Wheel:      f32[0]=dx, f32[1]=dy (line detents), [2]=mod, [3]=mx, [4]=my
//!   Resize/Moved: [0],[1]
//!   Text input / drop file: char buffer (31 / 255 bytes + NUL)
//!
//! Threading: on Android winit's event loop runs on the app thread (created
//! by android_main); on Linux/Windows it runs on a dedicated pump thread
//! spawned at first dd_window_create; macOS alone keeps winit on the
//! JS thread (EventLoop must live on the process main thread there) via the
//! pump_events extension. Everywhere except macOS the JS side never touches
//! winit — poll/wait_event are pure queue ops on the shared QUEUE + condvar,
//! woken instantly when the pump thread's ApplicationHandler translates an
//! OS event, and events keep flowing into the queue while JS is mid-frame.
//! Shared state is a Mutex<Ctx>; winit's Window is Send+Sync on the desktop
//! backends, and JS-facing calls take the Arc out of the lock so a window
//! op that marshals to the loop thread can never deadlock against a
//! translate handler holding CTX.
//! Keycodes: SDL3-derived values — ASCII for printables, scancode|0x40000000
//! for named keys — so the TS SPECIAL_KEYS table keeps working unchanged.
//! Wheel deltas are line detents; winit PixelDelta is converted (~16px/line).
//! Resize reports *physical* pixels (what the surface needs); the old SDL2
//! shim reported logical — identical at scale factor 1.0, which is the common
//! case on the native Linux path.

#[cfg(target_os = "android")]
pub mod android;
mod events;
mod hotkey;
mod keys;

use events::{take, Ev};
use raw_window_handle::{HasDisplayHandle, RawDisplayHandle};
#[cfg(target_os = "macos")]
use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::{c_char, c_int, c_void, CStr};
use std::ptr;
#[cfg(all(not(target_os = "android"), not(target_os = "macos")))]
use std::sync::mpsc;
#[cfg(all(not(target_os = "android"), not(target_os = "macos")))]
use std::sync::Condvar;
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
#[cfg(all(not(target_os = "android"), not(target_os = "macos")))]
use winit::event_loop::EventLoopProxy;
#[cfg(target_os = "macos")]
use winit::platform::pump_events::EventLoopExtPumpEvents;
#[cfg(not(target_os = "android"))]
use winit::window::WindowAttributes;
use winit::window::{CursorGrabMode, Fullscreen, Window, WindowId, WindowLevel};

/// Subsystem tags — dd_window_get_subsystem wire value.
mod syswm {
    pub const UNKNOWN: i32 = 0;
    pub const WINDOWS: i32 = 1;
    pub const X11: i32 = 2;
    pub const WAYLAND: i32 = 3;
    pub const COCOA: i32 = 4;
    /// Android subsystem tag
    pub const ANDROID: i32 = 13;
}

/// Key-modifier bits — combined L|R (TS masks with KMOD_SHIFT etc.).
const KMOD_SHIFT: i32 = 0x0001 | 0x0002;
const KMOD_CTRL: i32 = 0x0040 | 0x0080;
const KMOD_ALT: i32 = 0x0100 | 0x0200;
const KMOD_GUI: i32 = 0x0400 | 0x0800;

/// Per-window mutable input bookkeeping — keyed by winit WindowId so each
/// window tracks its own cursor, button latch, grab, and text-input mode
/// (secondary windows must not bleed pointer state into the primary).
#[derive(Default)]
pub(crate) struct WinInput {
    cursor: (f64, f64),
    /// Wire button-state bitmask (bit n-1 = button n).
    buttons: u32,
    grabbed: bool,
    text_input: bool,
    /// Armed via dd_window_secondary_set_close_intercept: CloseRequested
    /// pushes a vetoable CLOSE_REQUEST event (window stays mapped) instead
    /// of the immediate-hide Quit/WindowClose path.
    close_intercept: bool,
}

pub(crate) struct Ctx {
    /// Primary window (handle 0). Arc so Phase 5's create_surface can own a
    /// 'static reference.
    window: Option<Arc<Window>>,
    /// Secondary windows by handle (1+), created via dd_window_secondary_create.
    extras: HashMap<u32, Arc<Window>>,
    /// winit WindowId → shim handle (primary registers as 0).
    ids: HashMap<WindowId, u32>,
    /// Per-window input state keyed by winit WindowId.
    input: HashMap<WindowId, WinInput>,
    next_handle: u32,
    mods: i32,
}

/// Resolve a winit WindowId to its Arc — primary and secondaries alike.
/// Returns None for ids that were never installed (e.g. events arriving
/// after a window's Arc dropped).
pub(crate) fn window_by_id(ctx: &Ctx, id: WindowId) -> Option<Arc<Window>> {
    match ctx.ids.get(&id) {
        Some(0) => ctx.window.clone(),
        Some(&h) => ctx.extras.get(&h).cloned(),
        None => None,
    }
}

/// Resolve a shim handle (0 = primary) to its Arc.
fn window_by_handle(h: u32) -> Option<Arc<Window>> {
    let guard = CTX.lock().unwrap();
    let ctx = guard.as_ref()?;
    if h == 0 {
        return ctx.window.clone();
    }
    ctx.extras.get(&h).cloned()
}

/// Shared window/app state. The winit loop runs on a non-JS thread
/// everywhere except macOS (app thread on Android, pump thread on
/// Linux/Windows) while all dd_window_* calls come from the JS thread —
/// so this is a Mutex.
static CTX: Mutex<Option<Ctx>> = Mutex::new(None);

/// Take the window Arc out of CTX without holding the lock across the
/// call. JS-facing window ops use this instead of `with_ctx`: on Windows a
/// cross-thread window call can marshal to the loop thread, and the loop
/// thread's translate handlers lock CTX — holding CTX across a marshaling
/// call deadlocks.
fn win() -> Option<Arc<Window>> {
    CTX.lock().unwrap().as_ref().and_then(|c| c.window.clone())
}

#[cfg(target_os = "macos")]
thread_local! {
    /// Separate from CTX: pump_app_events dispatches into the handler, which
    /// borrows CTX — holding the loop's borrow across the call would panic.
    /// ManuallyDrop: the event loop outlives all windows (winit allows one
    /// per process) and must not run its AppKit teardown during thread-local
    /// destruction at process exit.
    static EVENT_LOOP: RefCell<Option<std::mem::ManuallyDrop<EventLoop<()>>>> =
        const { RefCell::new(None) };
}

/// ApplicationHandler that translates winit events into queued shim events.
/// `resumed`/`window_event` are the trait's required methods.
#[cfg(not(target_os = "android"))]
struct Pump;

#[cfg(target_os = "macos")]
impl ApplicationHandler for Pump {
    fn resumed(&mut self, _el: &winit::event_loop::ActiveEventLoop) {}

    fn window_event(
        &mut self,
        el: &winit::event_loop::ActiveEventLoop,
        id: winit::window::WindowId,
        ev: WindowEvent,
    ) {
        if let Some(ctx) = CTX.lock().unwrap().as_mut() {
            events::translate_window_event(ctx, id, ev, el);
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

/// Pump the winit event queue (pump_events extension — macOS only; the
/// event loop must live on the process main thread there, which is the JS
/// thread). Queued events are then drained one per poll call.
#[cfg(target_os = "macos")]
fn pump(timeout: Option<Duration>) {
    EVENT_LOOP.with(|e| {
        if let Some(l) = e.borrow_mut().as_mut() {
            l.pump_app_events(timeout, &mut Pump);
        }
    });
}

// ── Pump thread (Linux/Windows) ──────────────────────────────────────────
// A dedicated thread builds the EventLoop and runs run_app for the process
// lifetime. winit's OS poll wakes on events, the handler translates + pushes
// to the shared queue, and NOTIFY wakes any parked JS wait_event — no
// pump calls or epoll trips ever happen on the JS thread.

/// dd_window_secondary_create flag bits — WindowAttributes can't cross the FFI
/// boundary, so secondary-window creation packs its options into one u32.
const WF_RESIZABLE: u32 = 1;
const WF_DECORATIONS: u32 = 2;
const WF_TRANSPARENT: u32 = 4;
const WF_ALWAYS_ON_TOP: u32 = 8;
const WF_SKIP_TASKBAR: u32 = 16;
const WF_CLICK_THROUGH: u32 = 32;
/// Create mapped-invisible (overlays show once they've drawn a frame).
const WF_HIDDEN: u32 = 64;

/// User event sent to the pump thread. The create request's payload lives
/// in CREATE_REQ, so the same wakeup works whether it lands before or after
/// the loop's first resumed().
#[cfg(all(not(target_os = "android"), not(target_os = "macos")))]
enum LoopCmd {
    CreateWindow,
    CreateExtraWindow,
    /// Destroy a secondary window — the Arc drops pump-side because Window
    /// teardown is loop-thread-affine on Windows.
    DropWindow(u32),
    CreateSurface,
}

#[cfg(all(not(target_os = "android"), not(target_os = "macos")))]
struct CreateReq {
    title: String,
    w: u32,
    h: u32,
    /// One-shot reply: 0 created, 2 create failed. dd_window_create
    /// blocks on it, keeping the call synchronous on the JS side.
    reply: mpsc::Sender<c_int>,
}

#[cfg(all(not(target_os = "android"), not(target_os = "macos")))]
static CREATE_REQ: Mutex<Option<CreateReq>> = Mutex::new(None);

/// Deferred dd_window_create ack — held briefly after install_window
/// so the reply lands after the compositor's first configure burst (real
/// size, Wayland fractional scale) instead of letting JS snapshot the
/// pre-settle scale=1 defaults into NativeSurface. Bounded: about_to_wait
/// flushes it at the deadline even on silent WMs, and JS additionally
/// bounds the whole create via recv_timeout.
#[cfg(all(not(target_os = "android"), not(target_os = "macos")))]
static CREATE_ACK: Mutex<Option<(mpsc::Sender<c_int>, std::time::Instant)>> = Mutex::new(None);

/// How long to hold the create ack waiting for the initial window-event
/// burst. Wayland's first configure lands in single-digit ms; the bound
/// only bites on unusually slow compositors / VM displays.
#[cfg(all(not(target_os = "android"), not(target_os = "macos")))]
const CREATE_SETTLE: Duration = Duration::from_millis(200);

/// Payload for LoopCmd::CreateExtraWindow — mirrors CreateReq but carries
/// the WF_* option flags and a position (i32::MIN = unset → WM placement),
/// and replies with the new window's handle (>=1) or a negative error.
#[cfg(all(not(target_os = "android"), not(target_os = "macos")))]
struct ExtraReq {
    title: String,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    flags: u32,
    reply: mpsc::Sender<c_int>,
}

#[cfg(all(not(target_os = "android"), not(target_os = "macos")))]
static EXTRA_REQ: Mutex<Option<ExtraReq>> = Mutex::new(None);

/// Payload for LoopCmd::CreateSurface — mirrors CreateReq. winit refuses to
/// hand out the raw window handle off the event-loop thread on Windows
/// (HandleError::Unavailable), so the wgpu surface must be created pump-side.
/// Handles travel as usize: *mut c_void isn't Send.
#[cfg(all(not(target_os = "android"), not(target_os = "macos")))]
struct SurfaceReq {
    instance: usize,
    /// Shim window handle the surface binds to (0 = primary).
    window: u32,
    reply: mpsc::Sender<usize>,
}

#[cfg(all(not(target_os = "android"), not(target_os = "macos")))]
static SURFACE_REQ: Mutex<Option<SurfaceReq>> = Mutex::new(None);

/// Pending desktop identity applied to the next created window — set via
/// dd_window_set_app_name / dd_window_set_icon_file because JS-side
/// process.env writes don't reach the environ a dlopen'd lib reads (Bun
/// materializes env only for spawned children). The pump-side
/// DD_APP_ID / DD_APP_ICON env reads remain for launcher-exported env.
static PENDING_APP_NAME: Mutex<Option<(String, String)>> = Mutex::new(None);
static PENDING_ICON: Mutex<Option<winit::window::Icon>> = Mutex::new(None);

/// Pending create-time options for the PRIMARY window — set via
/// dd_window_set_create_options (the same PENDING_* pattern as app_name).
/// Absent = the legacy defaults (resizable, decorated, visible, WM-placed).
/// Present = the flags are authoritative: resizable iff WF_RESIZABLE,
/// decorations iff WF_DECORATIONS, mapped iff !WF_HIDDEN. Consumed (taken)
/// at the next create so a destroy+recreate doesn't silently re-apply them.
struct CreateOpts {
    flags: u32,
    /// i32::MIN = unset → WM placement.
    x: i32,
    y: i32,
    /// <=0 = unset.
    min_w: i32,
    min_h: i32,
    max_w: i32,
    max_h: i32,
}
static PENDING_CREATE_OPTS: Mutex<Option<CreateOpts>> = Mutex::new(None);

/// Fold PENDING_CREATE_OPTS into the primary window's attributes. Shared by
/// the pump-thread create (Linux/Windows) and the inline create (macOS).
#[cfg(not(target_os = "android"))]
fn apply_pending_create_opts(mut attrs: WindowAttributes) -> WindowAttributes {
    let Some(o) = PENDING_CREATE_OPTS.lock().unwrap().take() else {
        return attrs;
    };
    attrs = attrs
        .with_resizable(o.flags & WF_RESIZABLE != 0)
        .with_decorations(o.flags & WF_DECORATIONS != 0)
        .with_transparent(o.flags & WF_TRANSPARENT != 0)
        .with_visible(o.flags & WF_HIDDEN == 0);
    if o.x != i32::MIN && o.y != i32::MIN {
        attrs = attrs.with_position(PhysicalPosition::new(o.x, o.y));
    }
    if o.min_w > 0 || o.min_h > 0 {
        attrs = attrs.with_min_inner_size(LogicalSize::new(
            o.min_w.max(1) as f64,
            o.min_h.max(1) as f64,
        ));
    }
    if o.max_w > 0 || o.max_h > 0 {
        attrs = attrs.with_max_inner_size(LogicalSize::new(
            o.max_w.max(1) as f64,
            o.max_h.max(1) as f64,
        ));
    }
    if o.flags & WF_ALWAYS_ON_TOP != 0 {
        attrs = attrs.with_window_level(WindowLevel::AlwaysOnTop);
    }
    // Taskbar exclusion — same platform split as extra_window_attrs.
    #[cfg(target_os = "linux")]
    if o.flags & WF_SKIP_TASKBAR != 0 {
        use winit::platform::x11::{WindowAttributesExtX11, WindowType};
        attrs = WindowAttributesExtX11::with_x11_window_type(attrs, vec![WindowType::Utility]);
    }
    #[cfg(target_os = "windows")]
    if o.flags & WF_SKIP_TASKBAR != 0 {
        use winit::platform::windows::WindowAttributesExtWindows;
        attrs = WindowAttributesExtWindows::with_skip_taskbar(attrs, true);
    }
    attrs
}
#[cfg(all(not(target_os = "android"), not(target_os = "macos")))]
static LOOP_PROXY: Mutex<Option<EventLoopProxy<LoopCmd>>> = Mutex::new(None);

#[cfg(all(not(target_os = "android"), not(target_os = "macos")))]
#[derive(PartialEq)]
enum PumpState {
    /// Not spawned yet.
    Cold,
    /// EventLoop built, run_app entered (or about to be).
    Ready,
    /// EventLoop::build failed or run_app returned — unrecoverable.
    Dead,
}

#[cfg(all(not(target_os = "android"), not(target_os = "macos")))]
static PUMP_STATE: (Mutex<PumpState>, Condvar) = (Mutex::new(PumpState::Cold), Condvar::new());

/// The event loop's owned display handle, stashed once the pump thread has
/// built the EventLoop. wgpu's GLES backend needs the platform display
/// (e.g. the wl_display) bound at InstanceDescriptor.display to present on
/// Wayland; Vulkan/Metal/Dx12 ignore it.
#[cfg(all(not(target_os = "android"), not(target_os = "macos")))]
static DISPLAY_HANDLE: Mutex<Option<winit::event_loop::OwnedDisplayHandle>> = Mutex::new(None);

/// The event loop's display handle, bringing the pump thread up if needed.
/// Called at wgpu instance creation (which precedes the first window) so
/// GLES can bind the platform display for presentation. `None` when the
/// loop can't start (headless) or was never reached.
#[cfg(all(not(target_os = "android"), not(target_os = "macos")))]
pub(crate) fn ensure_display() -> Option<winit::event_loop::OwnedDisplayHandle> {
    ensure_pump();
    DISPLAY_HANDLE.lock().unwrap().clone()
}

/// Non-Linux desktop / mobile builds: the GLES-Wayland display bind is
/// irrelevant (Metal/Dx12/ANativeWindow paths don't use it).
#[cfg(any(target_os = "android", target_os = "macos"))]
pub(crate) fn ensure_display() -> Option<winit::event_loop::OwnedDisplayHandle> {
    None
}

#[cfg(all(not(target_os = "android"), not(target_os = "macos")))]
fn pump_thread_main() {
    let (lock, cond) = &PUMP_STATE;
    let mut builder = EventLoop::<LoopCmd>::with_user_event();
    // The loop deliberately lives on this spawned thread, not the process
    // main thread — winit requires opting into that on Linux (the hazard it
    // guards against is backend-specific main-thread assumptions; our JS
    // thread never touches winit at all).
    #[cfg(target_os = "linux")]
    {
        use winit::platform::wayland::EventLoopBuilderExtWayland;
        use winit::platform::x11::EventLoopBuilderExtX11;
        EventLoopBuilderExtX11::with_any_thread(&mut builder, true);
        EventLoopBuilderExtWayland::with_any_thread(&mut builder, true);
    }
    #[cfg(target_os = "windows")]
    {
        use winit::platform::windows::EventLoopBuilderExtWindows;
        EventLoopBuilderExtWindows::with_any_thread(&mut builder, true);
    }
    let el = match builder.build() {
        Ok(el) => el,
        Err(err) => {
            eprintln!("[downdraft_platform] EventLoop::build failed: {err}");
            *lock.lock().unwrap() = PumpState::Dead;
            cond.notify_all();
            return;
        }
    };
    *LOOP_PROXY.lock().unwrap() = Some(el.create_proxy());
    *DISPLAY_HANDLE.lock().unwrap() = Some(el.owned_display_handle());
    // Wait blocks the pump thread on the OS poll until events arrive —
    // zero wakeups while idle. Default Poll would spin a core.
    el.set_control_flow(winit::event_loop::ControlFlow::Wait);
    *lock.lock().unwrap() = PumpState::Ready;
    cond.notify_all();
    if let Err(err) = el.run_app(&mut Pump) {
        eprintln!("[downdraft_platform] run_app exited: {err}");
        *lock.lock().unwrap() = PumpState::Dead;
        cond.notify_all();
    }
}

/// Spawn the pump thread once and wait for its EventLoop. false = the
/// loop can never come up — callers treat it like EventLoop::new failing.
#[cfg(all(not(target_os = "android"), not(target_os = "macos")))]
fn ensure_pump() -> bool {
    let (lock, cond) = &PUMP_STATE;
    let mut state = lock.lock().unwrap();
    if *state == PumpState::Cold {
        if std::thread::Builder::new()
            .name("dd-winit".into())
            .spawn(pump_thread_main)
            .is_err()
        {
            *state = PumpState::Dead;
        }
    }
    while *state == PumpState::Cold {
        state = cond.wait(state).unwrap();
    }
    *state == PumpState::Ready
}

/// Consume a pending create request on the pump thread — called from
/// resumed() (request preceded loop startup) and user_event() (request
/// landed while running).
#[cfg(all(not(target_os = "android"), not(target_os = "macos")))]
fn pump_create_window(el: &winit::event_loop::ActiveEventLoop) {
    let req = CREATE_REQ.lock().unwrap().take();
    let Some(req) = req else { return };
    let reply = |code: c_int| {
        let _ = req.reply.send(code);
    };
    if CTX
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|x| x.window.is_some())
    {
        return reply(0);
    }
    let attrs = Window::default_attributes()
        .with_title(req.title)
        .with_inner_size(LogicalSize::new(req.w.max(1) as f64, req.h.max(1) as f64))
        .with_resizable(true)
        .with_visible(true)
        // Never request focus at map time — a freshly spawned app window
        // must not steal activation. Apps that want launch focus call
        // dd_window_focus; the WM may still focus per its own policy.
        .with_active(false);
    // Explicit create options (resizable/decorations/position/min/max/
    // hidden/level/skip-taskbar) — authoritative when set, so they land
    // after the base defaults and before platform identity. mut only on
    // linux: the identity block below reassigns attrs there (Windows has
    // no post-apply mutation).
    #[allow(unused_mut)]
    let mut attrs = apply_pending_create_opts(attrs);
    // Desktop-entry identity. DD_APP_ID is the packaged app's desktop id
    // (e.g. "dev.cruiser.app") — it becomes the Wayland app_id and the X11
    // WM_CLASS general+instance so the WM can match the running window to
    // <app-id>.desktop and show its icon. DD_APP_ICON is a path to an image
    // decoded for the window icon (_NET_WM_ICON on X11; Wayland ignores it —
    // icon resolution there is app_id → desktop file only).
    #[cfg(target_os = "linux")]
    if let Ok(id) = std::env::var("DD_APP_ID") {
        if !id.is_empty() {
            use winit::platform::wayland::WindowAttributesExtWayland;
            use winit::platform::x11::WindowAttributesExtX11;
            attrs = WindowAttributesExtX11::with_name(attrs, id.clone(), id.clone());
            attrs = WindowAttributesExtWayland::with_name(attrs, id.clone(), id);
        }
    }
    if let Ok(path) = std::env::var("DD_APP_ICON") {
        let icon = std::fs::read(&path)
            .ok()
            .and_then(|b| image::load_from_memory(&b).ok())
            .and_then(|i| {
                let rgba = i.to_rgba8();
                let (w, h) = rgba.dimensions();
                winit::window::Icon::from_rgba(rgba.into_raw(), w, h).ok()
            });
        if let Some(icon) = icon {
            attrs = attrs.with_window_icon(Some(icon));
        }
    }
    // Explicit FFI-set identity wins over env — the JS side can only reach
    // us this way under runtimes whose process.env writes aren't setenv.
    #[cfg(target_os = "linux")]
    if let Some((g, i)) = PENDING_APP_NAME.lock().unwrap().clone() {
        use winit::platform::wayland::WindowAttributesExtWayland;
        use winit::platform::x11::WindowAttributesExtX11;
        attrs = WindowAttributesExtX11::with_name(attrs, g.clone(), i.clone());
        attrs = WindowAttributesExtWayland::with_name(attrs, g, i);
    }
    if let Some(icon) = PENDING_ICON.lock().unwrap().clone() {
        attrs = attrs.with_window_icon(Some(icon));
    }
    match el.create_window(attrs) {
        Ok(w) => {
            let window = Arc::new(w);
            // We center new windows (winit leaves placement to the WM otherwise).
            // Center on the primary monitor for parity.
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
            // Hold the ack until the first window event (initial size /
            // scale-factor report) or CREATE_SETTLE, whichever comes first.
            *CREATE_ACK.lock().unwrap() =
                Some((req.reply.clone(), std::time::Instant::now() + CREATE_SETTLE));
            el.set_control_flow(winit::event_loop::ControlFlow::WaitUntil(
                std::time::Instant::now() + CREATE_SETTLE,
            ));
        }
        Err(err) => {
            eprintln!("[downdraft_platform] create_window failed: {err}");
            reply(2);
        }
    }
}

/// Flush the deferred create ack. `settle` = a window event just arrived —
/// the initial state report has landed and the reply can go immediately;
/// without it, only the deadline releases the ack. Restores Wait control
/// flow once the ack is consumed.
#[cfg(all(not(target_os = "android"), not(target_os = "macos")))]
fn flush_create_ack(el: &winit::event_loop::ActiveEventLoop, settle: bool) {
    let ack = {
        let mut slot = CREATE_ACK.lock().unwrap();
        match slot.as_ref() {
            Some((_, deadline)) if settle || std::time::Instant::now() >= *deadline => slot.take(),
            _ => None,
        }
    };
    if let Some((tx, _)) = ack {
        let _ = tx.send(0);
        el.set_control_flow(winit::event_loop::ControlFlow::Wait);
    }
}

/// Consume a pending secondary-window request on the pump thread. Replies
/// with the new handle (>=1) or a negative error.
#[cfg(all(not(target_os = "android"), not(target_os = "macos")))]
fn pump_create_extra_window(el: &winit::event_loop::ActiveEventLoop) {
    let req = EXTRA_REQ.lock().unwrap().take();
    let Some(req) = req else { return };
    let reply = |code: c_int| {
        let _ = req.reply.send(code);
    };
    if CTX
        .lock()
        .unwrap()
        .as_ref()
        .is_none_or(|x| x.window.is_none())
    {
        return reply(-1); // secondaries require a live primary
    }
    let attrs = extra_window_attrs(req.title, req.x, req.y, req.w, req.h, req.flags);
    match el.create_window(attrs) {
        Ok(w) => {
            let window = Arc::new(w);
            if req.flags & WF_CLICK_THROUGH != 0 {
                let _ = window.set_cursor_hittest(false);
            }
            match install_extra(window) {
                Some(h) => reply(h as c_int),
                None => reply(-2),
            }
        }
        Err(err) => {
            eprintln!("[downdraft_platform] create extra window failed: {err}");
            reply(-3);
        }
    }
}

#[cfg(all(not(target_os = "android"), not(target_os = "macos")))]
impl ApplicationHandler<LoopCmd> for Pump {
    fn resumed(&mut self, el: &winit::event_loop::ActiveEventLoop) {
        pump_create_window(el);
    }

    fn user_event(&mut self, el: &winit::event_loop::ActiveEventLoop, ev: LoopCmd) {
        match ev {
            LoopCmd::CreateWindow => pump_create_window(el),
            LoopCmd::CreateExtraWindow => pump_create_extra_window(el),
            LoopCmd::DropWindow(h) => {
                // Arc drops here on the loop thread — Window teardown is
                // loop-thread-affine on Windows.
                let w = CTX
                    .lock()
                    .unwrap()
                    .as_mut()
                    .and_then(|ctx| remove_extra(ctx, h));
                drop(w);
            }
            LoopCmd::CreateSurface => {
                let req = SURFACE_REQ.lock().unwrap().take();
                if let Some(req) = req {
                    let window = {
                        let guard = CTX.lock().unwrap();
                        guard.as_ref().and_then(|ctx| {
                            if req.window == 0 {
                                ctx.window.clone()
                            } else {
                                ctx.extras.get(&req.window).cloned()
                            }
                        })
                    };
                    let h = match window {
                        Some(w) => {
                            crate::gpu::create_surface_for_window(req.instance as *mut c_void, w)
                        }
                        None => ptr::null_mut(),
                    };
                    let _ = req.reply.send(h as usize);
                }
            }
        }
    }

    fn window_event(
        &mut self,
        el: &winit::event_loop::ActiveEventLoop,
        id: winit::window::WindowId,
        ev: WindowEvent,
    ) {
        if let Some(ctx) = CTX.lock().unwrap().as_mut() {
            events::translate_window_event(ctx, id, ev, el);
        }
        // First window event = the compositor's initial state report —
        // release the deferred create ack.
        flush_create_ack(el, true);
    }

    fn about_to_wait(&mut self, el: &winit::event_loop::ActiveEventLoop) {
        // Deadline path — a WM that sends no initial events must not hold
        // dd_window_create hostage.
        flush_create_ack(el, false);
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

/// The primary window's input state — the window-less grab/text-input shim
/// calls (dd_window_grab_input etc.) are primary-scoped by contract; per-
/// window control goes through dd_window_secondary_* (handle-addressed).
fn primary_input(ctx: &mut Ctx) -> Option<&mut WinInput> {
    let id = ctx.window.as_ref()?.id();
    Some(ctx.input.entry(id).or_default())
}

// ── Window creation ──

/// Install `window` into shared state, creating Ctx on first use. Shared by
/// the desktop create_window path and Android's deferred resumed() creation.
/// The first installed window is the primary (handle 0).
pub(crate) fn install_window(window: Arc<Window>) {
    let id = window.id();
    let mut guard = CTX.lock().unwrap();
    let ctx = guard.get_or_insert_with(|| Ctx {
        window: None,
        extras: HashMap::new(),
        ids: HashMap::new(),
        input: HashMap::new(),
        next_handle: 1,
        mods: 0,
    });
    ctx.ids.insert(id, 0);
    ctx.input.entry(id).or_default();
    ctx.window = Some(window);
}

/// Install a secondary window; returns its handle (1+). None when no Ctx
/// exists (secondary before primary — callers treat as create failure).
#[cfg_attr(target_os = "android", allow(dead_code))]
fn install_extra(window: Arc<Window>) -> Option<u32> {
    let id = window.id();
    let mut guard = CTX.lock().unwrap();
    let ctx = guard.as_mut()?;
    let h = ctx.next_handle.max(1);
    ctx.next_handle = h.saturating_add(1);
    ctx.ids.insert(id, h);
    ctx.input.entry(id).or_default();
    ctx.extras.insert(h, window);
    Some(h)
}

/// Detach a secondary window from the registry; the caller drops the Arc
/// (pump-side on Linux/Windows — Window teardown is loop-thread-affine).
fn remove_extra(ctx: &mut Ctx, h: u32) -> Option<Arc<Window>> {
    let w = ctx.extras.remove(&h)?;
    if let Some(id) = ctx.ids.iter().find_map(|(id, &v)| (v == h).then_some(*id)) {
        ctx.ids.remove(&id);
        ctx.input.remove(&id);
    }
    Some(w)
}

/// WindowAttributes for a secondary window from the packed WF_* bits. The
/// primary keeps its own creation path (desktop identity, icon, centering) —
/// secondaries are utility windows: never active-at-map, WM-placed unless a
/// position was passed.
#[cfg(not(target_os = "android"))]
fn extra_window_attrs(
    title: String,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    flags: u32,
) -> WindowAttributes {
    let mut attrs = Window::default_attributes()
        .with_title(title)
        .with_inner_size(LogicalSize::new(w.max(1) as f64, h.max(1) as f64))
        .with_resizable(flags & WF_RESIZABLE != 0)
        .with_decorations(flags & WF_DECORATIONS != 0)
        .with_transparent(flags & WF_TRANSPARENT != 0)
        .with_visible(flags & WF_HIDDEN == 0)
        .with_active(false);
    if x != i32::MIN && y != i32::MIN {
        attrs = attrs.with_position(PhysicalPosition::new(x, y));
    }
    if flags & WF_ALWAYS_ON_TOP != 0 {
        attrs = attrs.with_window_level(WindowLevel::AlwaysOnTop);
    }
    // Taskbar exclusion is a platform extension — X11 has no direct
    // skip-taskbar attr, but _NET_WM_WINDOW_TYPE_UTILITY gets it from every
    // common WM; Windows has a real attr. Wayland has no taskbar concept.
    #[cfg(target_os = "linux")]
    if flags & WF_SKIP_TASKBAR != 0 {
        use winit::platform::x11::{WindowAttributesExtX11, WindowType};
        attrs = WindowAttributesExtX11::with_x11_window_type(attrs, vec![WindowType::Utility]);
    }
    #[cfg(target_os = "windows")]
    if flags & WF_SKIP_TASKBAR != 0 {
        use winit::platform::windows::WindowAttributesExtWindows;
        attrs = WindowAttributesExtWindows::with_skip_taskbar(attrs, true);
    }
    attrs
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

/// dd_window_set_app_name(general, instance) — desktop-entry identity for
/// the next created window: Wayland app_id = `general`, X11 WM_CLASS =
/// "instance", "general". Pass the packaged app's desktop id (e.g.
/// "dev.cruiser.app") for both so the WM matches the window to
/// <app-id>.desktop's icon. Must be called before dd_window_create.
#[no_mangle]
pub extern "C" fn dd_window_set_app_name(general: *const c_char, instance: *const c_char) {
    if general.is_null() || instance.is_null() {
        return;
    }
    let g = unsafe { CStr::from_ptr(general) }
        .to_string_lossy()
        .into_owned();
    let i = unsafe { CStr::from_ptr(instance) }
        .to_string_lossy()
        .into_owned();
    if g.is_empty() {
        return;
    }
    *PENDING_APP_NAME.lock().unwrap() = Some((g, i));
}

/// dd_window_set_icon_file(path) → 0 ok, 1 read/decode failure.
/// Decodes an image file, applies it to the live window if one exists,
/// and remembers it for the next create.
#[no_mangle]
pub extern "C" fn dd_window_set_icon_file(path: *const c_char) -> c_int {
    if path.is_null() {
        return 1;
    }
    let p = unsafe { CStr::from_ptr(path) }
        .to_string_lossy()
        .into_owned();
    let icon = std::fs::read(&p)
        .ok()
        .and_then(|b| image::load_from_memory(&b).ok())
        .and_then(|i| {
            let rgba = i.to_rgba8();
            let (w, h) = rgba.dimensions();
            winit::window::Icon::from_rgba(rgba.into_raw(), w, h).ok()
        });
    match icon {
        Some(icon) => {
            *PENDING_ICON.lock().unwrap() = Some(icon.clone());
            if let Some(w) = win() {
                w.set_window_icon(Some(icon));
            }
            0
        }
        None => 1,
    }
}

/// Linux/Windows: the window can only be created on the pump thread —
/// record the request, wake the loop via the proxy, and block on the
/// one-shot reply so the call keeps its synchronous contract.
#[cfg(all(not(target_os = "android"), not(target_os = "macos")))]
#[no_mangle]
pub extern "C" fn dd_window_create(title: *const c_char, width: c_int, height: c_int) -> c_int {
    ffi!(2, {
        if CTX
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|x| x.window.is_some())
        {
            return 0;
        }
        if !ensure_pump() {
            return 1;
        }
        let (tx, rx) = mpsc::channel();
        *CREATE_REQ.lock().unwrap() = Some(CreateReq {
            title: cstr_title(title),
            w: width.max(1) as u32,
            h: height.max(1) as u32,
            reply: tx,
        });
        let sent = LOOP_PROXY
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|p| p.send_event(LoopCmd::CreateWindow).is_ok());
        if !sent {
            CREATE_REQ.lock().unwrap().take();
            return 2;
        }
        // Bounded wait — a wedged pump thread must surface as a create
        // failure, not a startup hang.
        match rx.recv_timeout(Duration::from_secs(10)) {
            Ok(code) => code,
            Err(_) => {
                CREATE_REQ.lock().unwrap().take();
                2
            }
        }
    })
}

#[cfg(target_os = "macos")]
#[no_mangle]
pub extern "C" fn dd_window_create(title: *const c_char, width: c_int, height: c_int) -> c_int {
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
                .with_visible(true)
                // Never request focus at map time — a freshly spawned app
                // window must not steal activation (e.g. dev-shell restarts
                // while the user is typing elsewhere). Apps that want
                // launch focus call dd_window_focus (focused: true in
                // NativeWindowConfig); the WM may still focus the window per
                // its own policy — that's not stealing, it's the WM's call.
                .with_active(false);
            let attrs = apply_pending_create_opts(attrs);
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
        // We center new windows (winit leaves placement to the WM otherwise). Center on
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

// ── Secondary windows ──
// The dd_window_secondary_* family drives overlay/splitscreen-style utility
// windows. Handles are 1+; 0 always names the primary window, so the
// window-less legacy calls are just the h=0 case.

/// Linux/Windows: same request/wakeup/reply choreography as
/// dd_window_create — the window can only be born on the pump thread.
#[cfg(all(not(target_os = "android"), not(target_os = "macos")))]
#[no_mangle]
pub extern "C" fn dd_window_secondary_create(
    title: *const c_char,
    x: c_int,
    y: c_int,
    width: c_int,
    height: c_int,
    flags: c_int,
) -> c_int {
    ffi!(-4, {
        if CTX
            .lock()
            .unwrap()
            .as_ref()
            .is_none_or(|c| c.window.is_none())
        {
            return -1;
        }
        if !ensure_pump() {
            return -2;
        }
        let (tx, rx) = mpsc::channel();
        *EXTRA_REQ.lock().unwrap() = Some(ExtraReq {
            title: cstr_title(title),
            x,
            y,
            w: width.max(1) as u32,
            h: height.max(1) as u32,
            flags: flags.max(0) as u32,
            reply: tx,
        });
        let sent = LOOP_PROXY
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|p| p.send_event(LoopCmd::CreateExtraWindow).is_ok());
        if !sent {
            EXTRA_REQ.lock().unwrap().take();
            return -3;
        }
        match rx.recv_timeout(Duration::from_secs(10)) {
            Ok(h) => h,
            Err(_) => {
                EXTRA_REQ.lock().unwrap().take();
                -3
            }
        }
    })
}

/// macOS: the JS thread IS the loop thread, so the window is created inline
/// (same pattern as the primary's dd_window_create).
#[cfg(target_os = "macos")]
#[no_mangle]
pub extern "C" fn dd_window_secondary_create(
    title: *const c_char,
    x: c_int,
    y: c_int,
    width: c_int,
    height: c_int,
    flags: c_int,
) -> c_int {
    ffi!(-4, {
        if CTX
            .lock()
            .unwrap()
            .as_ref()
            .is_none_or(|c| c.window.is_none())
        {
            return -1;
        }
        let attrs = extra_window_attrs(
            cstr_title(title),
            x,
            y,
            width.max(1) as u32,
            height.max(1) as u32,
            flags.max(0) as u32,
        );
        let created = EVENT_LOOP.with(|e| -> Result<Arc<Window>, c_int> {
            let slot = e.borrow();
            let Some(el) = slot.as_ref() else {
                return Err(-2);
            };
            #[allow(deprecated)]
            match el.create_window(attrs) {
                Ok(w) => Ok(Arc::new(w)),
                Err(err) => {
                    eprintln!("[downdraft_platform] create extra window failed: {err}");
                    Err(-3)
                }
            }
        });
        let window = match created {
            Ok(w) => w,
            Err(code) => return code,
        };
        if flags & WF_CLICK_THROUGH as i32 != 0 {
            let _ = window.set_cursor_hittest(false);
        }
        match install_extra(window) {
            Some(h) => {
                pump(Some(Duration::ZERO));
                h as c_int
            }
            None => -2,
        }
    })
}

/// Android: single-window platform — no secondary windows.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn dd_window_secondary_create(
    _title: *const c_char,
    _x: c_int,
    _y: c_int,
    _width: c_int,
    _height: c_int,
    _flags: c_int,
) -> c_int {
    -1
}

/// Destroy one window. handle 0 forwards to the primary destroy path (full
/// app teardown semantics); secondaries unmap + drop immediately.
#[no_mangle]
pub extern "C" fn dd_window_secondary_destroy(handle: c_int) {
    ffi!((), {
        if handle <= 0 {
            dd_window_destroy();
            return;
        }
        let h = handle as u32;
        #[cfg(all(not(target_os = "android"), not(target_os = "macos")))]
        {
            let _ = LOOP_PROXY
                .lock()
                .unwrap()
                .as_ref()
                .map(|p| p.send_event(LoopCmd::DropWindow(h)));
        }
        #[cfg(any(target_os = "macos", target_os = "android"))]
        {
            let w = CTX
                .lock()
                .unwrap()
                .as_mut()
                .and_then(|ctx| remove_extra(ctx, h));
            drop(w);
        }
    });
}

/// Show/hide without destroying — overlay toggle visibility.
#[no_mangle]
pub extern "C" fn dd_window_secondary_set_visible(handle: c_int, visible: c_int) {
    ffi!((), {
        if let Some(w) = window_by_handle(handle.max(0) as u32) {
            w.set_visible(visible != 0);
        }
    });
}

/// Cursor hit-testing — false = click-through (events fall to windows
/// below). Wayland returns Unsupported; callers treat failure as sticky.
#[no_mangle]
pub extern "C" fn dd_window_secondary_set_hittest(handle: c_int, hittest: c_int) -> c_int {
    ffi!(-1, {
        let Some(w) = window_by_handle(handle.max(0) as u32) else {
            return -1;
        };
        match w.set_cursor_hittest(hittest != 0) {
            Ok(()) => 0,
            Err(_) => -1,
        }
    })
}

/// Z-order band: 1 always-on-top, 0 normal, -1 always-on-bottom.
#[no_mangle]
pub extern "C" fn dd_window_secondary_set_level(handle: c_int, level: c_int) {
    ffi!((), {
        let Some(w) = window_by_handle(handle.max(0) as u32) else {
            return;
        };
        let lvl = match level.cmp(&0) {
            std::cmp::Ordering::Greater => WindowLevel::AlwaysOnTop,
            std::cmp::Ordering::Less => WindowLevel::AlwaysOnBottom,
            std::cmp::Ordering::Equal => WindowLevel::Normal,
        };
        w.set_window_level(lvl);
    });
}

#[no_mangle]
pub extern "C" fn dd_window_secondary_set_title(handle: c_int, title: *const c_char) {
    ffi!((), {
        if title.is_null() {
            return;
        }
        let title = unsafe { CStr::from_ptr(title) }
            .to_string_lossy()
            .into_owned();
        if let Some(w) = window_by_handle(handle.max(0) as u32) {
            w.set_title(&title);
        }
    });
}

#[no_mangle]
pub extern "C" fn dd_window_secondary_focus(handle: c_int) {
    ffi!((), {
        if let Some(w) = window_by_handle(handle.max(0) as u32) {
            w.focus_window();
        }
    });
}

#[no_mangle]
pub extern "C" fn dd_window_secondary_set_decorations(handle: c_int, on: c_int) {
    ffi!((), {
        if let Some(w) = window_by_handle(handle.max(0) as u32) {
            w.set_decorations(on != 0);
        }
    });
}

#[no_mangle]
pub extern "C" fn dd_window_secondary_set_fullscreen(handle: c_int, enabled: c_int) {
    ffi!((), {
        if let Some(w) = window_by_handle(handle.max(0) as u32) {
            w.set_fullscreen(if enabled != 0 {
                Some(Fullscreen::Borderless(None))
            } else {
                None
            });
        }
    });
}

/// Physical inner size — same contract as dd_window_get_size.
#[no_mangle]
pub extern "C" fn dd_window_secondary_get_size(
    handle: c_int,
    w_out: *mut c_int,
    h_out: *mut c_int,
) {
    ffi!((), {
        let (mut w, mut h) = (0, 0);
        if let Some(win) = window_by_handle(handle.max(0) as u32) {
            let s = win.inner_size();
            w = s.width as c_int;
            h = s.height as c_int;
        }
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
pub extern "C" fn dd_window_secondary_set_size(handle: c_int, width: c_int, height: c_int) {
    ffi!((), {
        if let Some(w) = window_by_handle(handle.max(0) as u32) {
            let _ =
                w.request_inner_size(PhysicalSize::new(width.max(1) as u32, height.max(1) as u32));
        }
    });
}

#[no_mangle]
pub extern "C" fn dd_window_secondary_get_pos(handle: c_int, x_out: *mut c_int, y_out: *mut c_int) {
    ffi!((), {
        let (mut x, mut y) = (0, 0);
        if let Some(w) = window_by_handle(handle.max(0) as u32) {
            if let Ok(p) = w.outer_position() {
                x = p.x;
                y = p.y;
            }
        }
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
pub extern "C" fn dd_window_secondary_set_pos(handle: c_int, x: c_int, y: c_int) {
    ffi!((), {
        if let Some(w) = window_by_handle(handle.max(0) as u32) {
            w.set_outer_position(PhysicalPosition::new(x, y));
        }
    });
}

/// Per-window cursor grab — same Locked→Confined→None semantics as
/// dd_window_grab_input, keyed to `handle`'s input slot.
#[no_mangle]
pub extern "C" fn dd_window_secondary_grab(handle: c_int, grab: c_int) {
    ffi!((), {
        let Some(w) = window_by_handle(handle.max(0) as u32) else {
            return;
        };
        let grab = grab != 0;
        if grab {
            if w.set_cursor_grab(CursorGrabMode::Locked).is_err() {
                let _ = w.set_cursor_grab(CursorGrabMode::Confined);
            }
            w.set_cursor_visible(false);
        } else {
            let _ = w.set_cursor_grab(CursorGrabMode::None);
            w.set_cursor_visible(true);
        }
        let id = w.id();
        with_ctx(|ctx| {
            ctx.input.entry(id).or_default().grabbed = grab;
        });
    });
}

// ── Desktop window controls ──
// Primary-window create options + handle-addressed runtime ops. Every op
// resolves through window_by_handle, so handle 0 works on the primary too —
// the dd_window_secondary_* prefix names the family, not the audience.

/// dd_window_set_create_options(flags, x, y, min_w, min_h, max_w, max_h) —
/// pre-create call (same PENDING_* pattern as dd_window_set_app_name):
/// the next dd_window_create applies the WF_* flag bits (resizable iff bit0,
/// decorations iff bit1, mapped iff !bit6 — authoritative, not defaults),
/// position (i32::MIN = WM placement), and min/max inner size (<=0 = unset).
#[no_mangle]
pub extern "C" fn dd_window_set_create_options(
    flags: c_int,
    x: c_int,
    y: c_int,
    min_w: c_int,
    min_h: c_int,
    max_w: c_int,
    max_h: c_int,
) {
    ffi!((), {
        *PENDING_CREATE_OPTS.lock().unwrap() = Some(CreateOpts {
            flags: flags.max(0) as u32,
            x,
            y,
            min_w,
            min_h,
            max_w,
            max_h,
        });
    });
}

/// Iconify (minimize) the window — set_minimized(false) restores.
#[no_mangle]
pub extern "C" fn dd_window_secondary_set_minimized(handle: c_int, on: c_int) {
    ffi!((), {
        if let Some(w) = window_by_handle(handle.max(0) as u32) {
            w.set_minimized(on != 0);
        }
    });
}

/// Maximize/unmaximize. is_maximized pairs for state queries.
#[no_mangle]
pub extern "C" fn dd_window_secondary_set_maximized(handle: c_int, on: c_int) {
    ffi!((), {
        if let Some(w) = window_by_handle(handle.max(0) as u32) {
            w.set_maximized(on != 0);
        }
    });
}

/// 1 maximized / 0 not (or no such window).
#[no_mangle]
pub extern "C" fn dd_window_secondary_is_maximized(handle: c_int) -> c_int {
    ffi!(0, {
        let Some(w) = window_by_handle(handle.max(0) as u32) else {
            return 0;
        };
        w.is_maximized() as c_int
    })
}

/// Resize affordance toggle. 0,0 on the size setters clears the bound.
#[no_mangle]
pub extern "C" fn dd_window_secondary_set_resizable(handle: c_int, on: c_int) {
    ffi!((), {
        if let Some(w) = window_by_handle(handle.max(0) as u32) {
            w.set_resizable(on != 0);
        }
    });
}

#[no_mangle]
pub extern "C" fn dd_window_secondary_set_min_size(handle: c_int, w: c_int, h: c_int) {
    ffi!((), {
        if let Some(win) = window_by_handle(handle.max(0) as u32) {
            // Physical px — the same unit dd_window_get/set_size speaks.
            win.set_min_inner_size((w > 0 || h > 0)
                .then(|| Size::Physical(PhysicalSize::new(w.max(1) as u32, h.max(1) as u32))));
        }
    });
}

#[no_mangle]
pub extern "C" fn dd_window_secondary_set_max_size(handle: c_int, w: c_int, h: c_int) {
    ffi!((), {
        if let Some(win) = window_by_handle(handle.max(0) as u32) {
            win.set_max_inner_size((w > 0 || h > 0)
                .then(|| Size::Physical(PhysicalSize::new(w.max(1) as u32, h.max(1) as u32))));
        }
    });
}

/// Taskbar/dock attention request — 1 = critical (bounces until focused),
/// 0 = informational. No-op on platforms without an urgency concept.
#[no_mangle]
pub extern "C" fn dd_window_secondary_request_attention(handle: c_int, urgent: c_int) {
    ffi!((), {
        if let Some(w) = window_by_handle(handle.max(0) as u32) {
            use winit::window::UserAttentionType;
            w.request_user_attention(Some(if urgent != 0 {
                UserAttentionType::Critical
            } else {
                UserAttentionType::Informational
            }));
        }
    });
}

/// Window's effective theme — 0 unknown, 1 light, 2 dark (winit's
/// Window::theme, which follows the OS preference where reported).
#[no_mangle]
pub extern "C" fn dd_window_secondary_get_theme(handle: c_int) -> c_int {
    ffi!(0, {
        let Some(w) = window_by_handle(handle.max(0) as u32) else {
            return 0;
        };
        match w.theme() {
            Some(winit::window::Theme::Light) => 1,
            Some(winit::window::Theme::Dark) => 2,
            None => 0,
        }
    })
}

/// Arm/disarm the vetoable close path for `handle`. Armed: CloseRequested
/// pushes DD_EVENT_CLOSE_REQUEST and the window STAYS mapped — JS dispatches
/// a cancelable event and explicitly proceeds (request_quit for the primary,
/// secondary_destroy for extras) or vetoes. Disarmed: the legacy
/// hide-then-Quit/WindowClose path.
#[no_mangle]
pub extern "C" fn dd_window_secondary_set_close_intercept(handle: c_int, on: c_int) {
    ffi!((), {
        let Some(w) = window_by_handle(handle.max(0) as u32) else {
            return;
        };
        let id = w.id();
        with_ctx(|ctx| {
            ctx.input.entry(id).or_default().close_intercept = on != 0;
        });
    });
}

// ── Event polling ──

/// No live window → NONE, same as the C shim's g_window null check. (The
/// EventLoop outlives the window — winit allows only one per process.)
/// Desktop contract: a quit pushed after destroy_window is dead — poll and
/// wait report no events at all. Android deliberately does NOT gate:
/// RESUMED itself is the event JS waits on before any window exists.
#[cfg(not(target_os = "android"))]
fn no_window() -> bool {
    CTX.lock()
        .unwrap()
        .as_ref()
        .is_none_or(|ctx| ctx.window.is_none())
}

/// macOS: take before pumping — the JS side drains the queue in a loop, and
/// pumping per pop cost one `pump_app_events` (OS poll + dispatch) per
/// queued event — hundreds of extra calls per frame under an input flood.
/// A queued event returns without touching winit; only an empty queue pays
/// the pump, which then enqueues the whole OS burst for subsequent takes.
/// `pump_app_events` treats `None` as "wait indefinitely", so `None` must
/// never be passed.
#[cfg(target_os = "macos")]
fn emit(out_data: *mut c_void, timeout: Option<Duration>) -> c_int {
    if no_window() {
        return events::NONE;
    }
    if let Some((wid, ev)) = take() {
        return events::write(wid, ev, out_data);
    }
    pump(timeout);
    take()
        .map(|(wid, ev)| events::write(wid, ev, out_data))
        .unwrap_or(events::NONE)
}

/// Linux/Windows pump thread: the loop thread pushes continuously, so a
/// poll is a pure queue pop — no winit calls on the JS thread at all.
/// Still gated on no_window for the desktop destroy contract.
#[cfg(all(not(target_os = "android"), not(target_os = "macos")))]
fn emit(out_data: *mut c_void, _timeout: Option<Duration>) -> c_int {
    if no_window() {
        return events::NONE;
    }
    take()
        .map(|(wid, ev)| events::write(wid, ev, out_data))
        .unwrap_or(events::NONE)
}

/// Android: the app thread's run_app handler fills the shared queue — poll
/// just drains it. Deliberately ungated: before the first resumed() there
/// is no window, and RESUMED itself is the event JS waits on.
#[cfg(target_os = "android")]
fn emit(out_data: *mut c_void, _timeout: Option<Duration>) -> c_int {
    take()
        .map(|(wid, ev)| events::write(wid, ev, out_data))
        .unwrap_or(events::NONE)
}

#[no_mangle]
pub extern "C" fn dd_window_poll_event(out_data: *mut c_void) -> c_int {
    // Non-blocking poll semantics.
    ffi!(events::NONE, { emit(out_data, Some(Duration::ZERO)) })
}

/// Linux/Windows pump thread: block on the shared queue's condvar — the
/// loop thread pushes and notifies. no_window keeps the old sleep
/// contract: a dead window's waits still expire on time and report NONE.
#[cfg(all(not(target_os = "android"), not(target_os = "macos")))]
#[no_mangle]
pub extern "C" fn dd_window_wait_event(out_data: *mut c_void, timeout_ms: u32) -> c_int {
    ffi!(events::NONE, {
        if no_window() {
            std::thread::sleep(Duration::from_millis(timeout_ms as u64));
            return events::NONE;
        }
        events::take_timeout(Duration::from_millis(timeout_ms as u64))
            .map(|(wid, ev)| events::write(wid, ev, out_data))
            .unwrap_or(events::NONE)
    })
}

/// Android: block on the shared queue's condvar — the app thread pushes and
/// notifies. Not gated on no_window (see emit above).
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn dd_window_wait_event(out_data: *mut c_void, timeout_ms: u32) -> c_int {
    ffi!(events::NONE, {
        events::take_timeout(Duration::from_millis(timeout_ms as u64))
            .map(|(wid, ev)| events::write(wid, ev, out_data))
            .unwrap_or(events::NONE)
    })
}

/// macOS: the JS thread IS the event-loop thread — wait_event pumps winit
/// for up to timeout_ms, so OS events wake it instantly and JS task sources
/// are only starved by the capped duration.
#[cfg(target_os = "macos")]
#[no_mangle]
pub extern "C" fn dd_window_wait_event(out_data: *mut c_void, timeout_ms: u32) -> c_int {
    ffi!(events::NONE, {
        if no_window() {
            std::thread::sleep(Duration::from_millis(timeout_ms as u64));
            return events::NONE;
        }
        emit(out_data, Some(Duration::from_millis(timeout_ms as u64)))
    })
}

/// Opt-in window activation — windows map inactive (see create_window); a
/// app that wants focus on launch calls this right after creating it.
/// Best-effort: WMs are free to ignore activation requests.
#[no_mangle]
pub extern "C" fn dd_window_focus() {
    ffi!((), {
        if let Some(w) = win() {
            w.focus_window();
        }
    });
}

// ── Input grab ──

#[no_mangle]
pub extern "C" fn dd_window_grab_input(grab: c_int) {
    ffi!((), {
        let Some(w) = win() else { return };
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
        with_ctx(|ctx| {
            if let Some(st) = primary_input(ctx) {
                st.grabbed = grab;
            }
        });
    });
}

// ── Text input (IME) ──

#[no_mangle]
pub extern "C" fn dd_window_start_text_input() {
    ffi!((), {
        if let Some(w) = win() {
            w.set_ime_allowed(true);
            with_ctx(|ctx| {
                if let Some(st) = primary_input(ctx) {
                    st.text_input = true;
                }
            });
        }
    });
}

#[no_mangle]
pub extern "C" fn dd_window_stop_text_input() {
    ffi!((), {
        if let Some(w) = win() {
            w.set_ime_allowed(false);
            with_ctx(|ctx| {
                if let Some(st) = primary_input(ctx) {
                    st.text_input = false;
                }
            });
        }
    });
}

#[no_mangle]
pub extern "C" fn dd_window_set_text_input_rect(x: c_int, y: c_int, w: c_int, h: c_int) {
    ffi!((), {
        if let Some(win) = win() {
            win.set_ime_cursor_area(
                Position::Physical(PhysicalPosition::new(x, y)),
                Size::Physical(PhysicalSize::new(w.max(0) as u32, h.max(0) as u32)),
            );
        }
    });
}

// ── Window queries / mutation ──

#[no_mangle]
pub extern "C" fn dd_window_get_subsystem() -> c_int {
    ffi!(-1, {
        let Some(w) = win() else {
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
}

#[no_mangle]
pub extern "C" fn dd_window_get_size(w_out: *mut c_int, h_out: *mut c_int) {
    ffi!((), {
        let (mut w, mut h) = (0, 0);
        if let Some(win) = win() {
            let s = win.inner_size();
            w = s.width as c_int;
            h = s.height as c_int;
        }
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
pub extern "C" fn dd_window_set_title(title: *const c_char) {
    ffi!((), {
        if title.is_null() {
            return;
        }
        let title = unsafe { CStr::from_ptr(title) }
            .to_string_lossy()
            .into_owned();
        if let Some(w) = win() {
            w.set_title(&title);
        }
    });
}

#[no_mangle]
pub extern "C" fn dd_window_set_fullscreen(enabled: c_int) {
    ffi!((), {
        if let Some(w) = win() {
            w.set_fullscreen(if enabled != 0 {
                Some(Fullscreen::Borderless(None))
            } else {
                None
            });
        }
    });
}

#[no_mangle]
pub extern "C" fn dd_window_get_pos(x_out: *mut c_int, y_out: *mut c_int) {
    ffi!((), {
        let (mut x, mut y) = (0, 0);
        if let Some(w) = win() {
            if let Ok(p) = w.outer_position() {
                x = p.x;
                y = p.y;
            }
        }
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
pub extern "C" fn dd_window_set_pos(x: c_int, y: c_int) {
    ffi!((), {
        if let Some(w) = win() {
            w.set_outer_position(PhysicalPosition::new(x, y));
        }
    });
}

/// Frame extents — winit has no direct API. Approximate from outer−inner:
/// symmetric side/bottom frames (dw/2 each), titlebar takes the height
/// remainder. Returns -1 when the window isn't up or can't report, matching
/// The wire format's pre-framing rc — the only consumer is window-state persistence.
#[no_mangle]
pub extern "C" fn dd_window_get_borders(
    top_out: *mut c_int,
    left_out: *mut c_int,
    bottom_out: *mut c_int,
    right_out: *mut c_int,
) -> c_int {
    ffi!(-1, {
        let rc = (|| {
            let Some(w) = win() else { return -1 };
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
        })();
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
pub extern "C" fn dd_window_set_size(width: c_int, height: c_int) {
    ffi!((), {
        if let Some(w) = win() {
            let _ =
                w.request_inner_size(PhysicalSize::new(width.max(1) as u32, height.max(1) as u32));
        }
    });
}

#[no_mangle]
pub extern "C" fn dd_window_get_display_info(refresh_out: *mut c_int, scale_out: *mut f32) {
    ffi!((), {
        let mut refresh = 0;
        let mut scale = 1.0f32;
        if let Some(w) = win() {
            if let Some(m) = w.current_monitor() {
                if let Some(mhz) = m.refresh_rate_millihertz() {
                    refresh = (mhz / 1000) as c_int;
                }
                scale = m.scale_factor() as f32;
            }
        }
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
pub extern "C" fn dd_window_request_quit() {
    ffi!((), {
        // Same contract as CloseRequested: hide immediately so the window
        // doesn't sit mapped through JS teardown (see events.rs).
        if let Some(w) = win() {
            w.set_visible(false);
        }
        events::push(0, Ev::Quit);
    });
}

#[no_mangle]
pub extern "C" fn dd_window_show_message_box(
    title: *const c_char,
    message: *const c_char,
) -> c_int {
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
/// Long-lived process clipboard. A fresh `arboard::Clipboard` per call is wrong
/// on X11: its `Drop` hands contents to the clipboard manager and destroys the
/// server window, racing requesters and leaving stale/empty contents. Keeping
/// one context alive for the process is the normal-app pattern — we stay the
/// selection owner and keep serving requests while running.
#[cfg(not(target_os = "android"))]
fn shared_clipboard() -> Option<std::sync::MutexGuard<'static, arboard::Clipboard>> {
    static CB: std::sync::OnceLock<Option<Mutex<arboard::Clipboard>>> = std::sync::OnceLock::new();
    CB.get_or_init(|| arboard::Clipboard::new().ok().map(Mutex::new))
        .as_ref()
        .and_then(|m| m.lock().ok())
}

#[cfg(not(target_os = "android"))]
#[no_mangle]
pub extern "C" fn dd_window_set_clipboard(text: *const c_char) {
    ffi!((), {
        if text.is_null() {
            return;
        }
        let text = unsafe { CStr::from_ptr(text) }
            .to_string_lossy()
            .into_owned();
        if let Some(mut cb) = shared_clipboard() {
            let _ = cb.set_text(text);
        }
    });
}

/// Android: arboard has no Android backend; stub until JNI clipboard lands.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn dd_window_set_clipboard(_text: *const c_char) {}

/// Android: no arboard backend — report empty clipboard.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn dd_window_get_clipboard(out: *mut c_char, _max_len: c_int) -> c_int {
    ffi!(0, {
        if !out.is_null() {
            unsafe { *out = 0 };
        }
        0
    })
}

/// Non-Android: no Choreographer — vsync ticks are a no-op and the JS pump
/// falls back to its software timer. Kept for ABI parity so JS can call it
/// unconditionally.
#[cfg(not(target_os = "android"))]
#[no_mangle]
pub extern "C" fn dd_window_set_vsync_wanted(_wanted: c_int) {}

/// snprintf semantics: returns the untruncated length, copies max_len-1 + NUL.
#[cfg(not(target_os = "android"))]
#[no_mangle]
pub extern "C" fn dd_window_get_clipboard(out: *mut c_char, max_len: c_int) -> c_int {
    ffi!(0, {
        if out.is_null() || max_len <= 0 {
            return 0;
        }
        unsafe { *out = 0 };
        let Some(mut cb) = shared_clipboard() else {
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
pub extern "C" fn dd_window_destroy() {
    ffi!((), {
        events::clear();
        // Take the windows out under the lock, then hide without it — a
        // set_visible that marshals to the loop thread can't run while the
        // loop's handler waits on CTX.
        let (w, extras) = {
            let mut guard = CTX.lock().unwrap();
            match guard.as_mut() {
                Some(ctx) => {
                    ctx.ids.clear();
                    ctx.input.clear();
                    (ctx.window.take(), std::mem::take(&mut ctx.extras))
                }
                None => (None, HashMap::new()),
            }
        };
        for (_, w) in extras {
            w.set_visible(false);
        }
        // A live wgpu surface holds its own Arc<Window> — if it wasn't
        // released first, the drop below leaves the window mapped.
        // Hiding guarantees the window is gone from the screen either
        // way; the OS window itself dies with the last Arc.
        if let Some(w) = w {
            w.set_visible(false);
        }
        // Keep the event loop alive — winit allows exactly one EventLoop
        // per process, and the wire semantics let apps destroy + recreate the
        // window.
    });
}

#[no_mangle]
pub extern "C" fn dd_window_delay(ms: u32) {
    ffi!((), {
        std::thread::sleep(Duration::from_millis(ms as u64));
    });
}

// ── wgpu surface ──
// winit's Arc<Window> satisfies wgpu's WindowHandle bound, so the surface is
// created directly — the per-platform X11/Wayland/HWND plumbing the C shim
// needed is inside wgpu.

/// Windows/Linux: the window handle is only vended on the pump thread
/// (winit thread-affinity check), so surface creation is proxied through
/// LoopCmd like window creation — request, wakeup, bounded wait on reply.
#[cfg(all(not(target_os = "android"), not(target_os = "macos")))]
#[no_mangle]
pub extern "C" fn dd_window_create_wgpu_surface(
    instance: *mut c_void,
    window: c_int,
) -> *mut c_void {
    ffi!(ptr::null_mut(), {
        let h = window.max(0) as u32;
        let has_window = {
            let guard = CTX.lock().unwrap();
            guard.as_ref().is_some_and(|ctx| {
                if h == 0 {
                    ctx.window.is_some()
                } else {
                    ctx.extras.contains_key(&h)
                }
            })
        };
        if !has_window {
            return ptr::null_mut();
        }
        if !ensure_pump() {
            return ptr::null_mut();
        }
        let (tx, rx) = mpsc::channel();
        *SURFACE_REQ.lock().unwrap() = Some(SurfaceReq {
            instance: instance as usize,
            window: h,
            reply: tx,
        });
        let sent = LOOP_PROXY
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|p| p.send_event(LoopCmd::CreateSurface).is_ok());
        if !sent {
            SURFACE_REQ.lock().unwrap().take();
            return ptr::null_mut();
        }
        match rx.recv_timeout(Duration::from_secs(10)) {
            Ok(h) => h as *mut c_void,
            Err(_) => {
                SURFACE_REQ.lock().unwrap().take();
                ptr::null_mut()
            }
        }
    })
}

#[cfg(any(target_os = "android", target_os = "macos"))]
#[no_mangle]
pub extern "C" fn dd_window_create_wgpu_surface(
    instance: *mut c_void,
    window: c_int,
) -> *mut c_void {
    ffi!(ptr::null_mut(), {
        let h = window.max(0) as u32;
        let target = {
            let guard = CTX.lock().unwrap();
            guard.as_ref().and_then(|ctx| {
                if h == 0 {
                    ctx.window.clone()
                } else {
                    ctx.extras.get(&h).cloned()
                }
            })
        };
        match target {
            Some(w) => crate::gpu::create_surface_for_window(instance, w),
            None => ptr::null_mut(),
        }
    })
}
