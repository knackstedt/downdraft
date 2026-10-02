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
use std::os::raw::c_char;
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
    if let Err(err) = el.run_app(&mut AndroidPump { resumed: false }) {
        eprintln!("[downdraft_platform] run_app exited: {err}");
    }
    std::process::exit(0);
}
