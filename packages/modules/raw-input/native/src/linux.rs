// ============================================================================
// Linux raw mouse capture — X11 (XInput2) + Wayland detection
// ============================================================================
//
// X11 path (covers native X11 + XWayland):
//   1. Open a dedicated X11 connection (independent of Chromium's).
//   2. Query the XInput2 extension and select for XI_RawMotion events on the
//      root window. Raw motion events are delivered regardless of which window
//      the pointer is on — they're raw device events.
//   3. Read RawMotion events: extract dx/dy from the valuator state.
//   4. Cursor hiding: create an empty 1x1 transparent cursor and define it
//      on the root window.
//
// The capture runs on a dedicated thread that polls the X11 event queue.
// Deltas are forwarded to JS via the ThreadsafeFunction callback.

use super::{CaptureStatus, Platform, NapiError, NapiResult};
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use x11rb::connection::Connection as _;
use x11rb::errors::ReplyOrIdError;
use x11rb::protocol::xinput::{ConnectionExt as _, Device, EventMask, XIEventMask};
use x11rb::protocol::xproto::{self, ConnectionExt as _};
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;

pub struct Backend {
    capturing: Arc<AtomicBool>,
    capture_thread: Option<thread::JoinHandle<()>>,
    platform: Platform,
    detail: String,
}

impl Backend {
    pub fn new() -> Self {
        let (platform, detail) = detect_platform_with_detail();
        Self {
            capturing: Arc::new(AtomicBool::new(false)),
            capture_thread: None,
            platform,
            detail,
        }
    }

    pub fn start(
        &mut self,
        window_handle: &[u8],
        callback: ThreadsafeFunction<(f64, f64), ErrorStrategy::CalleeHandled>,
    ) -> NapiResult<()> {
        if self.capturing.load(Ordering::SeqCst) {
            return Ok(());
        }

        if self.platform != Platform::X11 {
            return Err(NapiError::from_reason(format!(
                "Raw input not available on platform: {}",
                self.platform
            )));
        }

        // Parse the window handle (X11 Window ID, 4 bytes little-endian on Linux)
        if window_handle.len() < 4 {
            return Err(NapiError::from_reason(
                "Invalid window handle: expected at least 4 bytes (X11 Window ID)",
            ));
        }
        let win_id = u32::from_le_bytes([
            window_handle[0],
            window_handle[1],
            window_handle[2],
            window_handle[3],
        ]);

        self.capturing.store(true, Ordering::SeqCst);
        let capturing = self.capturing.clone();

        self.capture_thread = Some(thread::spawn(move || {
            run_x11_capture(win_id, capturing, callback);
        }));

        Ok(())
    }

    pub fn stop(&mut self) -> NapiResult<()> {
        self.capturing.store(false, Ordering::SeqCst);
        if let Some(handle) = self.capture_thread.take() {
            let _ = handle.join();
        }
        Ok(())
    }

    pub fn set_cursor_visible(&mut self, _visible: bool) -> NapiResult<()> {
        Ok(())
    }

    pub fn status(&self) -> CaptureStatus {
        CaptureStatus {
            platform: self.platform,
            capturing: self.capturing.load(Ordering::SeqCst),
            detail: self.detail.clone(),
        }
    }
}

impl Drop for Backend {
    fn drop(&mut self) {
        self.capturing.store(false, Ordering::SeqCst);
        if let Some(handle) = self.capture_thread.take() {
            let _ = handle.join();
        }
    }
}

/// Detect whether we're on X11 or Wayland.
pub fn detect_platform() -> Platform {
    detect_platform_with_detail().0
}

fn detect_platform_with_detail() -> (Platform, String) {
    if std::env::var("DISPLAY").is_ok() {
        match x11rb::connect(None) {
            Ok((conn, _)) => {
                drop(conn);
                return (
                    Platform::X11,
                    "XInput2 raw motion + XWarpPointer confinement".to_string(),
                );
            }
            Err(e) => {
                eprintln!("[raw-input] X11 display found in env but connect failed: {}", e);
            }
        }
    }

    if std::env::var("WAYLAND_DISPLAY").is_ok() {
        return (
            Platform::Wayland,
            "Wayland native (portal RemoteDesktop + libei) — not yet implemented".to_string(),
        );
    }

    (Platform::Unsupported, "No display server detected".to_string())
}

/// Run the X11 raw mouse capture loop on a dedicated thread.
fn run_x11_capture(
    win_id: u32,
    capturing: Arc<AtomicBool>,
    callback: ThreadsafeFunction<(f64, f64), ErrorStrategy::CalleeHandled>,
) {
    let (conn, screen_num) = match x11rb::connect(None) {
        Ok(result) => result,
        Err(e) => {
            eprintln!("[raw-input] Failed to connect to X server: {}", e);
            return;
        }
    };

    let root = match conn.setup().roots.get(screen_num) {
        Some(screen) => screen.root,
        None => {
            eprintln!("[raw-input] Invalid screen number: {}", screen_num);
            return;
        }
    };

    // Query the XInput extension
    let _xi_opcode = match query_xinput_extension(&conn) {
        Ok(opcode) => opcode,
        Err(e) => {
            eprintln!("[raw-input] XInput extension not available: {}", e);
            return;
        }
    };

    // Select for XI_RawMotion events on the root window.
    // Device::ALL_MASTER selects all master pointer devices.
    let mask = EventMask {
        deviceid: Device::ALL_MASTER.into(),
        mask: vec![XIEventMask::RAW_MOTION],
    };

    if let Err(e) = conn.xinput_xi_select_events(root, &[mask]) {
        eprintln!("[raw-input] Failed to select XI events: {}", e);
        return;
    }

    if let Err(e) = conn.flush() {
        eprintln!("[raw-input] Failed to flush X11 connection: {}", e);
        return;
    }

    // Hide the cursor
    let _ = hide_cursor(&conn, root);

    // Compute the initial center point of the game window in root coordinates.
    // We re-query the geometry periodically (window can be moved/resized).
    let mut center_x: i16 = 0;
    let mut center_y: i16 = 0;
    let mut last_geometry_check: std::time::Instant = std::time::Instant::now();
    update_window_center(&conn, win_id, root, &mut center_x, &mut center_y);
    eprintln!("[raw-input] Window 0x{:x} center: ({}, {})", win_id, center_x, center_y);

    // Confinement strategy: XWarpPointer re-centering only (no XGrabPointer).
    //
    // We intentionally do NOT use XGrabPointer because it swallows button
    // events. When a grab is active on the root window, button events that
    // would normally go to the Electron game window (a child of root) are
    // intercepted by the grab. Since our grab's event_mask only selects
    // POINTER_MOTION, button press/release events are discarded instead of
    // forwarded to the game window — breaking click input.
    //
    // XWarpPointer re-centering after each raw motion event is sufficient for
    // confinement: the cursor is snapped back to the window center before it
    // can reach the edge, so it can't escape to the title bar or another
    // monitor. This is the same approach SDL2 uses for
    // SDL_SetRelativeMouseMode on X11.

    // Warp pointer to center immediately on capture start
    let _ = conn.warp_pointer(x11rb::NONE, root, 0, 0, 0, 0, center_x, center_y);
    let _ = conn.flush();

    // Main capture loop: poll for X11 events
    let mut last_warp: std::time::Instant = std::time::Instant::now();
    let mut last_focus_check: std::time::Instant = std::time::Instant::now();
    while capturing.load(Ordering::SeqCst) {
        // Re-query window geometry every 500ms (handles move/resize)
        if last_geometry_check.elapsed() > std::time::Duration::from_millis(500) {
            update_window_center(&conn, win_id, root, &mut center_x, &mut center_y);
            last_geometry_check = std::time::Instant::now();
        }

        // Check if the game window still has keyboard focus every 100ms.
        // If focus was lost (alt-tab, clicking another window, etc.), stop
        // capture immediately — the cursor should be restored and the user
        // should be free to interact with other windows. The renderer's
        // window.blur handler will also fire and call exitPointerLock(), but
        // this native-side check is a safety net that stops the XWarpPointer
        // re-centering and cursor hiding without waiting for IPC round-trip.
        if last_focus_check.elapsed() > std::time::Duration::from_millis(100) {
            if let Ok(focus_cookie) = conn.get_input_focus() {
                if let Ok(focus_reply) = focus_cookie.reply() {
                    // The focus can be on the game window itself or on a
                    // descendant (e.g. a child window used by Chromium for
                    // rendering). Check if the focus window is within the
                    // game window's subtree by comparing against win_id.
                    // For simplicity, we check if focus == win_id OR if
                    // focus is a child of win_id via query_tree.
                    if !is_focus_in_window(&conn, focus_reply.focus, win_id) {
                        eprintln!(
                            "[raw-input] Window lost focus (focus=0x{:x}, expected 0x{:x}) — stopping capture",
                            focus_reply.focus, win_id
                        );
                        capturing.store(false, Ordering::SeqCst);
                        break;
                    }
                }
            }
            last_focus_check = std::time::Instant::now();
        }

        // Re-warp periodically even without motion events, in case the
        // cursor drifted away from center between events (e.g. from
        // Chromium's own cursor handling).
        if last_warp.elapsed() > std::time::Duration::from_millis(50) {
            let _ = conn.warp_pointer(x11rb::NONE, root, 0, 0, 0, 0, center_x, center_y);
            let _ = conn.flush();
            last_warp = std::time::Instant::now();
        }

        match conn.poll_for_event() {
            Ok(Some(event)) => {
                if let Some((dx, dy)) = parse_raw_motion(&event) {
                    if dx != 0.0 || dy != 0.0 {
                        callback.call(Ok((dx, dy)), ThreadsafeFunctionCallMode::NonBlocking);
                        // Re-center the cursor after each motion event.
                        // MUST flush — otherwise the warp request sits in the
                        // X11 output buffer and the cursor isn't actually moved.
                        let _ = conn.warp_pointer(x11rb::NONE, root, 0, 0, 0, 0, center_x, center_y);
                        let _ = conn.flush();
                        last_warp = std::time::Instant::now();
                    }
                }
            }
            Ok(None) => {
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            Err(e) => {
                eprintln!("[raw-input] X11 event poll error: {}", e);
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
    }

    // Restore the cursor on stop
    let _ = restore_cursor(&conn, root);
    let _ = conn.flush();
}

/// Query the game window's geometry and compute its center in root coordinates.
/// Updates center_x/center_y in place. Falls back to screen center on error.
fn update_window_center(
    conn: &RustConnection,
    win_id: u32,
    root: xproto::Window,
    center_x: &mut i16,
    center_y: &mut i16,
) {
    // Get the window's geometry (position + size relative to parent)
    let geo = match conn.get_geometry(win_id) {
        Ok(cookie) => match cookie.reply() {
            Ok(reply) => reply,
            Err(e) => {
                eprintln!("[raw-input] get_geometry reply error: {}", e);
                return;
            }
        },
        Err(e) => {
            eprintln!("[raw-input] get_geometry request error: {}", e);
            return;
        }
    };

    // get_geometry gives position relative to the parent window. We need
    // root-relative coordinates. Use get_window_attributes or translate
    // coordinates. translate_coordinates is the most reliable.
    let translated = conn.translate_coordinates(win_id, root, 0, 0);
    let (win_root_x, win_root_y) = match translated {
        Ok(cookie) => match cookie.reply() {
            Ok(reply) => (reply.dst_x, reply.dst_y),
            Err(_) => {
                // Fallback: use geometry x/y (may be relative to parent, not root)
                (geo.x, geo.y)
            }
        },
        Err(_) => (geo.x, geo.y),
    };

    // Center of the window in root coordinates
    *center_x = win_root_x + (geo.width / 2) as i16;
    *center_y = win_root_y + (geo.height / 2) as i16;
}

/// Check if the current keyboard focus window is the game window or a
/// descendant of it. Chromium may use child windows for rendering, so we
/// walk up the tree from the focus window to see if win_id is an ancestor.
fn is_focus_in_window(conn: &RustConnection, focus: u32, win_id: u32) -> bool {
    if focus == win_id {
        return true;
    }
    if focus == 0 || focus == 1 {
        // 0 = None, 1 = PointerRoot — not our window
        return false;
    }
    // Walk up the window tree from the focus window to see if win_id
    // is an ancestor.
    let mut current = focus;
    for _ in 0..32 {
        // Limit depth to prevent infinite loops
        match conn.query_tree(current) {
            Ok(cookie) => match cookie.reply() {
                Ok(reply) => {
                    if reply.parent == win_id {
                        return true;
                    }
                    if reply.parent == 0 || reply.parent == reply.root {
                        // Reached root — win_id is not an ancestor
                        return false;
                    }
                    current = reply.parent;
                }
                Err(_) => return false,
            },
            Err(_) => return false,
        }
    }
    false
}

/// Query the XInput extension and return its major opcode.
fn query_xinput_extension(conn: &RustConnection) -> Result<u8, x11rb::errors::ReplyError> {
    let query = conn.query_extension(b"XInputExtension")?;
    let reply = query.reply()?;
    if !reply.present {
        return Err(x11rb::errors::ReplyError::ConnectionError(
            x11rb::errors::ConnectionError::UnsupportedExtension,
        ));
    }
    Ok(reply.major_opcode)
}

/// Parse a RawMotion event and extract (dx, dy) from the valuator state.
fn parse_raw_motion(event: &Event) -> Option<(f64, f64)> {
    match event {
        Event::XinputRawMotion(raw_event) => {
            // Fp3232 has integral (i32) and frac (u32) parts.
            let dx = raw_event
                .axisvalues
                .get(0)
                .map(|v| v.integral as f64 + v.frac as f64 / 4294967296.0)
                .unwrap_or(0.0);
            let dy = raw_event
                .axisvalues
                .get(1)
                .map(|v| v.integral as f64 + v.frac as f64 / 4294967296.0)
                .unwrap_or(0.0);
            Some((dx, dy))
        }
        _ => None,
    }
}

/// Hide the OS cursor by creating an empty (transparent) cursor.
fn hide_cursor(conn: &RustConnection, window: xproto::Window) -> Result<(), ReplyOrIdError> {
    let depth = 1;
    let pixmap = conn.generate_id()?;
    conn.create_pixmap(depth, pixmap, window, 1, 1)?;

    let gc = conn.generate_id()?;
    let gc_aux = xproto::CreateGCAux::new().foreground(0).background(0);
    conn.create_gc(gc, pixmap, &gc_aux)?;

    let _ = conn.poly_fill_rectangle(pixmap, gc, &[xproto::Rectangle { x: 0, y: 0, width: 1, height: 1 }]);

    // Create the cursor from the empty pixmap.
    // create_cursor takes individual arguments (not an aux struct in x11rb 0.13).
    let cursor = conn.generate_id()?;
    conn.create_cursor(cursor, pixmap, x11rb::NONE, 0, 0, 0, 0, 0, 0, 0, 0)?;

    // Define the cursor on the root window (so it's hidden everywhere)
    let _ = conn.change_window_attributes(window, &xproto::ChangeWindowAttributesAux::new().cursor(cursor));

    // Free the temporary resources
    let _ = conn.free_gc(gc);
    let _ = conn.free_pixmap(pixmap);

    let _ = conn.flush();
    Ok(())
}

/// Restore the default cursor by setting cursor=None on the window.
fn restore_cursor(conn: &RustConnection, window: xproto::Window) -> Result<(), ReplyOrIdError> {
    let _ = conn.change_window_attributes(window, &xproto::ChangeWindowAttributesAux::new().cursor(x11rb::NONE));
    let _ = conn.flush();
    Ok(())
}
