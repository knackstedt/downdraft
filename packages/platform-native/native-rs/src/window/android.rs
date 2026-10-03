//! Android entry: owns the winit loop on the app thread and feeds the shared
//! event queue (events.rs) the JS thread drains via poll/wait_event.
//!
//! Lifecycle: `run_app` → `EventLoop::run_app(AndroidPump)` on this thread
//! (it never returns). `resumed` creates the deferred window once
//! `sdl_shim_create_window` has recorded a request; `suspended` drops it so
//! wgpu surfaces invalidate; touch/keyboard events translate through the same
//! code desktop uses.
//!
//! Ordering: Android fires `resumed` as soon as the surface exists — usually
//! long before Node/JS has booted and called sdl_shim_create_window. So the
//! JS-side request wakes the loop via an EventLoopProxy (user_event) — the
//! window is created by whichever arrives second: resumed() or the request.

use std::ffi::c_int;
use std::ffi::c_void;
use std::os::raw::c_char;
use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};
use std::sync::{Arc, Mutex};

use winit::dpi::LogicalSize;
use winit::event::{DeviceEvent, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoop, EventLoopProxy};
use winit::platform::android::activity::AndroidApp;
use winit::platform::android::EventLoopBuilderExtAndroid;
use winit::window::Window;

use super::events::{self, Ev};
use super::{cstr_title, install_window, CTX};

/// Last window request recorded by sdl_shim_create_window (JS thread). Kept
/// (not consumed) so resume-after-suspend can recreate the window — JS never
/// re-issues the request.
static REQ: Mutex<Option<(String, u32, u32)>> = Mutex::new(None);

/// Proxy to wake the loop from the JS thread when a create request arrives
/// while already resumed (the common case — Node boots after first resume).
static PROXY: Mutex<Option<EventLoopProxy<()>>> = Mutex::new(None);

struct AndroidPump {
    /// True between resumed() and suspended(). Window creation is only legal
    /// while resumed — a pending request waits otherwise.
    resumed: bool,
}

impl AndroidPump {
    fn try_create_window(&mut self, el: &ActiveEventLoop) {
        if !self.resumed {
            return;
        }
        if CTX
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|x| x.window.is_some())
        {
            return;
        }
        let req = REQ.lock().unwrap().clone();
        let Some((title, w, h)) = req else { return };
        let attrs = Window::default_attributes()
            .with_title(title)
            .with_inner_size(LogicalSize::new(w.max(1) as f64, h.max(1) as f64))
            .with_resizable(true)
            .with_visible(true);
        match el.create_window(attrs) {
            Ok(win) => {
                install_window(Arc::new(win));
                // RESUMED means "a live window exists" — JS may have been
                // blocked on it since boot, or rebinds its surface here on
                // resume-after-suspend. Never emit it without a window.
                events::push(Ev::Resumed);
            }
            Err(err) => eprintln!("[downdraft_platform] android create_window failed: {err}"),
        }
    }
}

impl winit::application::ApplicationHandler for AndroidPump {
    fn resumed(&mut self, el: &ActiveEventLoop) {
        self.resumed = true;
        self.try_create_window(el);
    }

    fn suspended(&mut self, _el: &ActiveEventLoop) {
        self.resumed = false;
        // Drop the window first — JS's suspend handler re-checks CTX.window
        // before dropping the wgpu surface against a stale ANativeWindow.
        if let Some(ctx) = CTX.lock().unwrap().as_mut() {
            ctx.window = None;
        }
        events::push(Ev::Suspended);
    }

    /// Wakeup sent by sdl_shim_create_window — if the loop is already resumed
    /// this is what actually creates the window (the request may arrive long
    /// after the first resumed).
    fn user_event(&mut self, el: &ActiveEventLoop, _ev: ()) {
        self.try_create_window(el);
    }

    fn window_event(
        &mut self,
        el: &ActiveEventLoop,
        _id: winit::window::WindowId,
        ev: WindowEvent,
    ) {
        if let Some(ctx) = CTX.lock().unwrap().as_mut() {
            events::translate_window_event(ctx, ev, el);
        }
    }

    fn device_event(
        &mut self,
        _el: &ActiveEventLoop,
        _id: winit::event::DeviceId,
        ev: DeviceEvent,
    ) {
        if let Some(ctx) = CTX.lock().unwrap().as_mut() {
            events::translate_device_event(ctx, ev);
        }
    }
}

/// Record the JS window request and wake the app loop. The Window
/// materializes on the app thread when resumed + request have both landed;
/// RESUMED on the wire tells JS the surface is ready.
/// Returns 0 = accepted, 2 = already live.
#[no_mangle]
pub extern "C" fn sdl_shim_create_window(
    title: *const c_char,
    width: c_int,
    height: c_int,
) -> c_int {
    if CTX
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|x| x.window.is_some())
    {
        return 0;
    }
    *REQ.lock().unwrap() = Some((cstr_title(title), width.max(1) as u32, height.max(1) as u32));
    if let Some(p) = PROXY.lock().unwrap().as_ref() {
        let _ = p.send_event(());
    }
    0
}

/// Called by the shell crate's android_main with the android_app handle.
/// Builds the Android-bound EventLoop and runs it — owns this thread for the
/// process lifetime (Android apps never return from the activity loop).
pub fn run_app(app: AndroidApp) -> ! {
    let el = match EventLoop::<()>::with_user_event()
        .with_android_app(app)
        .build()
    {
        Ok(el) => el,
        Err(err) => {
            eprintln!("[downdraft_platform] android EventLoop::build failed: {err}");
            std::process::exit(1);
        }
    };
    *PROXY.lock().unwrap() = Some(el.create_proxy());
    choreo::start();
    if let Err(err) = el.run_app(&mut AndroidPump { resumed: false }) {
        eprintln!("[downdraft_platform] run_app exited: {err}");
    }
    std::process::exit(0);
}

// ── Vsync (Choreographer) ───────────────────────────────────────────────────
//
// A dedicated thread owns an ALooper + AChoreographer: it can't share the app
// thread's looper (winit owns its poll cadence there) and the JS thread has
// no looper at all (libuv drives it). Frame callbacks push Ev::Vsync into the
// shared queue the JS pump drains — rAF dispatch then phase-aligns to the
// display's real refresh instead of a software 60Hz guess.
mod choreo {
    use super::*;

    const ALOOPER_PREPARE_ALLOW_NON_CALLBACKS: c_int = 1;

    type FrameCb = unsafe extern "C" fn(i64, *mut c_void);

    #[link(name = "android")]
    extern "C" {
        fn ALooper_prepare(opts: c_int) -> *mut c_void;
        fn ALooper_pollAll(
            timeout_ms: c_int,
            out_fd: *mut c_int,
            out_events: *mut c_int,
            out_data: *mut *mut c_void,
        ) -> c_int;
        fn ALooper_wake(looper: *mut c_void);
        fn AChoreographer_getInstance() -> *mut c_void;
        fn AChoreographer_postFrameCallback(ch: *mut c_void, cb: FrameCb, data: *mut c_void);
    }

    /// JS wants vsync ticks (has pending rAF callbacks). When false the
    /// callback chain is allowed to lapse — no wakeups while idle/suspended.
    static WANTED: AtomicBool = AtomicBool::new(false);
    /// A frame callback is registered and will fire — prevents double-posting.
    /// Only mutated on the choreographer thread, but read there after wake.
    static POSTED: AtomicBool = AtomicBool::new(false);
    static LOOPER: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

    unsafe extern "C" fn frame_cb(nanos: i64, _data: *mut c_void) {
        POSTED.store(false, Ordering::Relaxed);
        events::push(Ev::Vsync { nanos });
        if WANTED.load(Ordering::Acquire) {
            AChoreographer_postFrameCallback(CH.load(Ordering::Relaxed), frame_cb, std::ptr::null_mut());
            POSTED.store(true, Ordering::Relaxed);
        }
    }

    static CH: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

    pub fn start() {
        let _ = std::thread::Builder::new()
            .name("dd-vsync".into())
            .spawn(|| unsafe {
                let looper = ALooper_prepare(ALOOPER_PREPARE_ALLOW_NON_CALLBACKS);
                let ch = AChoreographer_getInstance();
                if looper.is_null() || ch.is_null() {
                    eprintln!("[downdraft_platform] choreographer unavailable — vsync ticks disabled");
                    return;
                }
                LOOPER.store(looper, Ordering::Release);
                CH.store(ch, Ordering::Release);
                loop {
                    // Frame callbacks dispatch inside this poll. The timeout
                    // self-heals any missed wake; WANTED transitions also wake
                    // via ALooper_wake below.
                    ALooper_pollAll(500, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut());
                    if WANTED.load(Ordering::Acquire) && !POSTED.load(Ordering::Relaxed) {
                        AChoreographer_postFrameCallback(ch, frame_cb, std::ptr::null_mut());
                        POSTED.store(true, Ordering::Relaxed);
                    }
                }
            });
    }

    /// Called from the JS thread via FFI. Wakes the looper so a wanted→true
    /// edge arms the callback chain without waiting for the poll timeout.
    pub fn set_wanted(wanted: bool) {
        WANTED.store(wanted, Ordering::Release);
        let looper = LOOPER.load(Ordering::Acquire);
        if !looper.is_null() {
            unsafe { ALooper_wake(looper) };
        }
    }
}

/// Arm/disarm vsync ticks. No-op off-Android (the symbol exists on every
/// build so the JS side can call unconditionally).
#[no_mangle]
pub extern "C" fn sdl_shim_set_vsync_wanted(wanted: c_int) {
    choreo::set_wanted(wanted != 0);
}
