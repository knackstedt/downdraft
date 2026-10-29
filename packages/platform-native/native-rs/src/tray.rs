// ============================================================================
// tray.rs — system tray icon via tray-icon
//
// Backends: Windows/macOS native impls; Linux/*BSD via the ksni backend —
// a pure-Rust StatusNotifierItem over session DBus (no GTK, no
// libappindicator runtime dependency). The tray menu reuses menu.rs's
// AppMenuModel builder with ids namespaced "tray:<id>" so activations land
// on the same DD_EVENT_MENU_ACTION channel already disambiguated.
//
// opts for dd_tray_create:
//   { "icon": "/abs/path.png",   // decoded via image::open → RGBA
//     "title": "App",            // macOS status-item title (optional)
//     "tooltip": "hover text",
//     "menu": { "items": [...] },// AppMenuModel — ids get the tray: prefix
//     "menuOnLeftClick": false } // show menu on left click (default: right)
//
// TrayIconEvent routes through set_event_handler into Ev::TrayEvent —
// DD_EVENT_TRAY_EVENT slots: kind/button/state/x/y.
//
// Threading: everything lives on the JS thread (thread_local) — muda menus
// are Rc-bound anyway and macOS requires main-thread status-item ops.
// ============================================================================

use std::ffi::{c_char, c_int};

#[cfg(not(target_os = "android"))]
mod imp {
    use crate::dialog::{opt_bool, opt_str, parse_opts};
    use crate::menu::imp as menus;
    use crate::window::events::{self, Ev};
    use serde_json::Value;
    use std::cell::RefCell;
    use std::ffi::{c_char, c_int};
    use std::sync::Once;
    use tray_icon::{
        Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent,
    };

    thread_local! {
        static TRAY: RefCell<Option<TrayIcon>> = const { RefCell::new(None) };
    }

    /// Route TrayIconEvent into the shared event queue — OnceLock handler,
    /// same pattern as the menu-event divert.
    fn ensure_tray_events() {
        static ONCE: Once = Once::new();
        ONCE.call_once(|| {
            fn btn(b: MouseButton) -> i32 {
                match b {
                    MouseButton::Left => 1,
                    MouseButton::Right => 2,
                    MouseButton::Middle => 3,
                }
            }
            TrayIconEvent::set_event_handler(Some(|ev: TrayIconEvent| {
                use TrayIconEvent as T;
                let (kind, button, state, pos) = match ev {
                    T::Click {
                        button,
                        button_state,
                        position,
                        ..
                    } => (
                        1,
                        btn(button),
                        match button_state {
                            MouseButtonState::Up => 0,
                            MouseButtonState::Down => 1,
                        },
                        position,
                    ),
                    T::DoubleClick {
                        button, position, ..
                    } => (2, btn(button), 0, position),
                    T::Enter { position, .. } => (3, 0, 0, position),
                    T::Move { position, .. } => (4, 0, 0, position),
                    T::Leave { position, .. } => (5, 0, 0, position),
                    _ => return,
                };
                events::push(
                    0,
                    Ev::TrayEvent {
                        kind,
                        button,
                        state,
                        x: pos.x as i32,
                        y: pos.y as i32,
                    },
                );
            }));
        });
    }

    /// Decode an icon file path → tray Icon (RGBA). Empty path → None.
    fn load_icon(path: &str) -> Option<Icon> {
        if path.is_empty() {
            return None;
        }
        let img = image::open(path).ok()?.to_rgba8();
        let (w, h) = img.dimensions();
        Icon::from_rgba(img.into_raw(), w, h).ok()
    }

    fn build_tray(opts: &Value) -> Option<TrayIcon> {
        let mut b = TrayIconBuilder::new().with_tooltip(opt_str(opts, "tooltip").unwrap_or(""));
        if let Some(t) = opt_str(opts, "title") {
            b = b.with_title(t);
        }
        if let Some(icon) = opt_str(opts, "icon").and_then(load_icon) {
            b = b.with_icon(icon);
        }
        if let Some(menu) = opts.get("menu") {
            let built = menus::build_menu(menu, "tray:");
            b = b.with_menu(Box::new(built.menu));
            menus::swap_tray_items(built.items);
        }
        if opts.get("menuOnLeftClick").is_some() {
            b = b.with_menu_on_left_click(opt_bool(opts, "menuOnLeftClick"));
        }
        b.build().ok()
    }

    pub(super) fn create(opts_json: *const c_char) -> c_int {
        ensure_tray_events();
        menus::ensure_event_handler();
        let opts = parse_opts(opts_json);
        match build_tray(&opts) {
            Some(tray) => {
                TRAY.with(|t| *t.borrow_mut() = Some(tray));
                1
            }
            None => 0,
        }
    }

    pub(super) fn set_icon(path: *const c_char) -> c_int {
        let path = if path.is_null() {
            String::new()
        } else {
            unsafe { std::ffi::CStr::from_ptr(path) }
                .to_string_lossy()
                .into_owned()
        };
        let icon = if path.is_empty() {
            None
        } else {
            load_icon(&path)
        };
        if path.len() > 0 && icon.is_none() {
            return 0;
        }
        TRAY.with(|t| {
            t.borrow_mut()
                .as_mut()
                .map(|tray| {
                    let _ = tray.set_icon(icon);
                    1
                })
                .unwrap_or(0)
        })
    }

    pub(super) fn set_tooltip(text: *const c_char) -> c_int {
        let text = if text.is_null() {
            String::new()
        } else {
            unsafe { std::ffi::CStr::from_ptr(text) }
                .to_string_lossy()
                .into_owned()
        };
        TRAY.with(|t| {
            t.borrow_mut()
                .as_mut()
                .map(|tray| {
                    let _ = tray.set_tooltip(Some(text));
                    1
                })
                .unwrap_or(0)
        })
    }

    pub(super) fn set_menu(opts_json: *const c_char) -> c_int {
        let opts = parse_opts(opts_json);
        let built = menus::build_menu(&opts, "tray:");
        TRAY.with(|t| {
            t.borrow_mut()
                .as_mut()
                .map(|tray| {
                    tray.set_menu(Some(Box::new(built.menu)));
                    menus::swap_tray_items(built.items);
                    1
                })
                .unwrap_or(0)
        })
    }

    pub(super) fn destroy() -> c_int {
        TRAY.with(|t| {
            if t.borrow_mut().take().is_some() {
                menus::swap_tray_items(Default::default());
                1
            } else {
                0
            }
        })
    }
}

/// dd_tray_create(opts_json) → 1 created, 0 unavailable/failed.
/// Replaces any existing tray icon.
#[no_mangle]
pub extern "C" fn dd_tray_create(opts_json: *const c_char) -> c_int {
    #[cfg(not(target_os = "android"))]
    return imp::create(opts_json);
    #[cfg(target_os = "android")]
    {
        let _ = opts_json;
        0
    }
}

/// dd_tray_set_icon(path) → 1 applied, 0 no tray or decode failed.
/// Empty path clears the icon.
#[no_mangle]
pub extern "C" fn dd_tray_set_icon(path: *const c_char) -> c_int {
    #[cfg(not(target_os = "android"))]
    return imp::set_icon(path);
    #[cfg(target_os = "android")]
    {
        let _ = path;
        0
    }
}

/// dd_tray_set_tooltip(text) → 1 applied, 0 no tray.
#[no_mangle]
pub extern "C" fn dd_tray_set_tooltip(text: *const c_char) -> c_int {
    #[cfg(not(target_os = "android"))]
    return imp::set_tooltip(text);
    #[cfg(target_os = "android")]
    {
        let _ = text;
        0
    }
}

/// dd_tray_set_menu(model_json) → 1 applied, 0 no tray.
#[no_mangle]
pub extern "C" fn dd_tray_set_menu(opts_json: *const c_char) -> c_int {
    #[cfg(not(target_os = "android"))]
    return imp::set_menu(opts_json);
    #[cfg(target_os = "android")]
    {
        let _ = opts_json;
        0
    }
}

/// dd_tray_destroy() → 1 destroyed, 0 no tray.
#[no_mangle]
pub extern "C" fn dd_tray_destroy() -> c_int {
    #[cfg(not(target_os = "android"))]
    return imp::destroy();
    #[cfg(target_os = "android")]
    0
}
