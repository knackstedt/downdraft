// ============================================================================
// menu.rs — native app menus via muda (Windows HMENU / macOS NSMenu)
//
// The menu model arrives as JSON (see HostFileMenuModel on the TS side):
//
//   { "items": [
//       { "type": "submenu", "id": "file", "label": "File", "items": [
//           { "type": "item",  "id": "file.open", "label": "Open…",
//             "accelerator": "CmdOrCtrl+O", "enabled": true },
//           { "type": "check", "id": "view.wrap", "label": "Word Wrap",
//             "checked": true },
//           { "type": "separator" },
//           { "type": "predefined", "kind": "quit" }
//       ]}
//   ]}
//
// Activations arrive through muda's global MenuEvent handler — each pushes
// the item id onto ACTIONS and a DD_EVENT_MENU_ACTION wire event; JS pulls
// ids one at a time with dd_menu_next_action (FIFO, so every event has a
// matching pullable id).
//
// Threading: muda menus are Rc-bound (not Send) so everything lives in
// thread_locals on the JS thread — which is also the only legal menu thread
// on macOS (the JS thread IS the app thread there).
//
// Platforms: Windows installs HMENU via init_for_hwnd, macOS installs the
// global app menu via init_for_nsapp. Linux returns 0 (muda's GTK backend
// needs a gtk::Window our winit surface isn't) and Android returns -1 —
// both fall back to the html-ui in-window menu bar on the JS side.
// ============================================================================

use std::collections::VecDeque;
use std::ffi::{c_char, c_int, c_void, CString};
use std::ptr;
use std::sync::Mutex;

#[cfg(not(target_os = "android"))]
use crate::window::events::{self, Ev};

/// FIFO of activated item ids — each entry pairs 1:1 with a pushed
/// DD_EVENT_MENU_ACTION wire event.
static ACTIONS: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());

#[cfg(not(target_os = "android"))]
fn push_action(id: String) {
    ACTIONS.lock().unwrap().push_back(id);
    events::push(0, Ev::MenuAction);
}

/// dd_menu_set(model_json) → 1 native menu installed, 0 unsupported
/// platform (JS renders the in-window fallback), -1 build/install error.
#[no_mangle]
pub extern "C" fn dd_menu_set(opts_json: *const c_char) -> c_int {
    imp::set(opts_json)
}

/// dd_menu_remove() → 1 menu detached, 0 no menu installed/unsupported.
#[no_mangle]
pub extern "C" fn dd_menu_remove() -> c_int {
    imp::remove()
}

/// dd_menu_set_item_enabled(id, on) → 1 applied, 0 unknown id or no menu.
#[no_mangle]
pub extern "C" fn dd_menu_set_item_enabled(id: *const c_char, on: c_int) -> c_int {
    if id.is_null() {
        return 0;
    }
    imp::set_item_enabled(id, on != 0)
}

/// dd_menu_set_item_checked(id, checked) → 1 applied, 0 unknown id,
/// non-check item, or no menu.
#[no_mangle]
pub extern "C" fn dd_menu_set_item_checked(id: *const c_char, on: c_int) -> c_int {
    if id.is_null() {
        return 0;
    }
    imp::set_item_checked(id, on != 0)
}

/// dd_menu_popup(x, y, model_json) → 1 shown, 0 unsupported. x/y are
/// physical client coordinates on the primary window.
#[no_mangle]
pub extern "C" fn dd_menu_popup(x: c_int, y: c_int, opts_json: *const c_char) -> c_int {
    imp::popup(x, y, opts_json)
}

/// Pull the next queued menu-action id (snprintf semantics — returns the
/// byte count including NUL; out=null sizes without consuming). 0 = none.
#[no_mangle]
pub extern "C" fn dd_menu_next_action(out: *mut c_char, max_len: usize) -> c_int {
    let mut queue = ACTIONS.lock().unwrap();
    // Sizing peek — the front id stays queued for the copy call.
    if out.is_null() || max_len == 0 {
        return queue.front().map(|id| (id.len() + 1) as c_int).unwrap_or(0);
    }
    let id = match queue.pop_front() {
        Some(s) => s,
        None => {
            unsafe { *out = 0 };
            return 0;
        }
    };
    let bytes = CString::new(id).unwrap_or_else(|_| CString::new("").unwrap());
    let bytes = bytes.as_bytes_with_nul();
    let n = bytes.len().min(max_len);
    unsafe {
        ptr::copy_nonoverlapping(bytes.as_ptr() as *const c_void, out as *mut c_void, n);
        *out.add(max_len - 1) = 0;
    }
    bytes.len() as c_int
}

// ---------------------------------------------------------------------------
// Implementation — every non-Android desktop target. On Windows/macOS muda
// has a real platform backend; on Linux/*BSD it's the noop backend (menus
// are pure data — the tray's ksni SNI backend serializes them over DBus).
// Only the window-attach paths (set/remove/popup) stay win/mac-gated.
// ---------------------------------------------------------------------------

#[cfg(not(target_os = "android"))]
pub(crate) mod imp {
    use super::*;
    use crate::dialog::{opt_bool, opt_str, parse_opts};
    use muda::accelerator::Accelerator;
    #[cfg(any(windows, target_os = "macos"))]
    use muda::ContextMenu;
    use muda::{CheckMenuItem, IsMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
    use serde_json::Value;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::str::FromStr;
    use std::sync::Once;

    /// Registry entry — set_enabled applies to every kind; set_checked only
    /// to CheckMenuItem.
    pub(crate) enum ItemHandle {
        Item(MenuItem),
        Check(CheckMenuItem),
        Sub(Submenu),
        // Held only to keep the item alive — predefined items are
        // native-managed (no enabled/checked state).
        Pre(#[allow(dead_code)] PredefinedMenuItem),
    }

    impl ItemHandle {
        fn set_enabled(&self, on: bool) {
            match self {
                Self::Item(i) => i.set_enabled(on),
                Self::Check(i) => i.set_enabled(on),
                Self::Sub(i) => i.set_enabled(on),
                // Predefined items are native-managed — muda exposes no
                // enabled state for them.
                Self::Pre(_) => {}
            }
        }
        fn set_checked(&self, on: bool) -> bool {
            match self {
                Self::Check(i) => {
                    i.set_checked(on);
                    true
                }
                _ => false,
            }
        }
    }

    struct InstalledMenu {
        #[allow(dead_code)] // the Menu handle itself must outlive the install
        menu: Menu,
        items: HashMap<String, ItemHandle>,
    }

    /// A built (not yet attached) menu — the tray hands `menu` to
    /// `TrayIconBuilder::with_menu` and `items` join the shared registry.
    pub(crate) struct MenuBuild {
        pub(crate) menu: Menu,
        pub(crate) items: HashMap<String, ItemHandle>,
    }

    thread_local! {
        static APP_MENU: RefCell<Option<InstalledMenu>> = const { RefCell::new(None) };
        /// Tray-menu items — ids arrive already namespaced ("tray:<id>") so
        /// dd_menu_set_item_* resolves them in one lookup.
        static TRAY_ITEMS: RefCell<HashMap<String, ItemHandle>> =
            RefCell::new(HashMap::new());
        // Transient popup state — the Menu + its items must outlive the
        // native tracking loop. Replaced on the next popup. win/mac only —
        // Linux has no native popup.
        #[cfg(any(windows, target_os = "macos"))]
        static POPUP: RefCell<Option<PopupMenu>> = const { RefCell::new(None) };
    }

    #[cfg(any(windows, target_os = "macos"))]
    struct PopupMenu {
        #[allow(dead_code)]
        menu: Menu,
        #[allow(dead_code)]
        items: Vec<ItemHandle>,
    }

    /// Divert muda's global MenuEvent channel into our action queue — set
    /// once; the handler is Send+Sync so the platform loop can call it on
    /// whatever thread dispatches menu notifications. Serves the app menu,
    /// popups, AND the tray menu (ids are pre-namespaced at build time).
    pub(crate) fn ensure_event_handler() {
        static ONCE: Once = Once::new();
        ONCE.call_once(|| {
            MenuEvent::set_event_handler(Some(|ev: MenuEvent| {
                super::push_action(ev.id.0.clone());
            }));
        });
    }

    fn accelerator(spec: &Value) -> Option<Accelerator> {
        opt_str(spec, "accelerator").and_then(|s| match Accelerator::from_str(s) {
            Ok(a) => Some(a),
            Err(e) => {
                eprintln!("[dd] menu accelerator {:?} rejected: {e}", s);
                None
            }
        })
    }

    fn predefined(kind: &str, label: Option<&str>) -> Option<PredefinedMenuItem> {
        // Normalize so "selectAll", "select_all", and "selectall" all map.
        let k = kind.to_ascii_lowercase().replace('_', "");
        Some(match k.as_str() {
            "separator" => PredefinedMenuItem::separator(),
            "copy" => PredefinedMenuItem::copy(label),
            "cut" => PredefinedMenuItem::cut(label),
            "paste" => PredefinedMenuItem::paste(label),
            "selectall" => PredefinedMenuItem::select_all(label),
            "undo" => PredefinedMenuItem::undo(label),
            "redo" => PredefinedMenuItem::redo(label),
            "quit" => PredefinedMenuItem::quit(label),
            "about" => PredefinedMenuItem::about(label, None),
            "minimize" => PredefinedMenuItem::minimize(label),
            "maximize" => PredefinedMenuItem::maximize(label),
            "closewindow" => PredefinedMenuItem::close_window(label),
            "fullscreen" => PredefinedMenuItem::fullscreen(label),
            "hide" => PredefinedMenuItem::hide(label),
            "hideothers" => PredefinedMenuItem::hide_others(label),
            "showall" => PredefinedMenuItem::show_all(label),
            "services" => PredefinedMenuItem::services(label),
            "bringalltofront" => PredefinedMenuItem::bring_all_to_front(label),
            _ => return None,
        })
    }

    enum Parent<'a> {
        Menu(&'a Menu),
        Sub(&'a Submenu),
    }

    impl Parent<'_> {
        fn append(&self, item: &dyn IsMenuItem) {
            let _ = match self {
                Self::Menu(m) => m.append(item),
                Self::Sub(s) => s.append(item),
            };
        }
    }

    /// `id_prefix` namespaces item ids at construction — the tray passes
    /// "tray:" so tray-item activations arrive through the shared
    /// MenuEvent channel already disambiguated.
    fn add_items(
        parent: &Parent,
        list: &[Value],
        registry: &mut HashMap<String, ItemHandle>,
        id_prefix: &str,
    ) {
        let mut auto_id = 0u32;
        for spec in list {
            let ty = spec.get("type").and_then(|t| t.as_str()).unwrap_or("item");
            let label = opt_str(spec, "label").unwrap_or("");
            let enabled = spec
                .get("enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            auto_id += 1;
            let id = |spec: &Value| {
                format!(
                    "{id_prefix}{}",
                    opt_str(spec, "id").unwrap_or(&format!("auto{auto_id}"))
                )
            };
            match ty {
                "separator" => {
                    parent.append(&PredefinedMenuItem::separator());
                }
                "predefined" => {
                    if let Some(p) =
                        predefined(opt_str(spec, "kind").unwrap_or(""), opt_str(spec, "label"))
                    {
                        parent.append(&p);
                        if opt_str(spec, "id").is_some() {
                            registry.insert(id(spec), ItemHandle::Pre(p));
                        }
                    }
                }
                "check" => {
                    let id = id(spec);
                    let checked = opt_bool(spec, "checked");
                    let it = CheckMenuItem::with_id(
                        id.clone(),
                        label,
                        enabled,
                        checked,
                        accelerator(spec),
                    );
                    parent.append(&it);
                    registry.insert(id, ItemHandle::Check(it));
                }
                "submenu" => {
                    let id = id(spec);
                    let sub = Submenu::with_id(id.clone(), label, enabled);
                    parent.append(&sub);
                    registry.insert(id, ItemHandle::Sub(sub.clone()));
                    if let Some(children) = spec.get("items").and_then(|v| v.as_array()) {
                        add_items(&Parent::Sub(&sub), children, registry, id_prefix);
                    }
                }
                _ => {
                    let id = id(spec);
                    let it = MenuItem::with_id(id.clone(), label, enabled, accelerator(spec));
                    parent.append(&it);
                    registry.insert(id, ItemHandle::Item(it));
                }
            }
        }
    }

    /// Build a detached menu + item registry from the JSON model. Shared by
    /// the app-menu install path and the tray.
    pub(crate) fn build_menu(opts: &Value, id_prefix: &str) -> MenuBuild {
        let mut registry = HashMap::new();
        let menu = Menu::new();
        if let Some(list) = opts.get("items").and_then(|v| v.as_array()) {
            add_items(&Parent::Menu(&menu), list, &mut registry, id_prefix);
        }
        MenuBuild {
            menu,
            items: registry,
        }
    }

    /// Replace the tray-menu half of the item registry (called by tray.rs
    /// whenever the tray menu is rebuilt).
    pub(crate) fn swap_tray_items(items: HashMap<String, ItemHandle>) {
        TRAY_ITEMS.with(|t| *t.borrow_mut() = items);
    }

    pub(super) fn set(opts_json: *const c_char) -> c_int {
        ensure_event_handler();
        let opts = parse_opts(opts_json);
        install_app_menu(build_menu(&opts, ""))
    }

    #[cfg(any(windows, target_os = "macos"))]
    fn install_app_menu(built: MenuBuild) -> c_int {
        let InstalledMenu { menu, items } = InstalledMenu {
            menu: built.menu,
            items: built.items,
        };
        #[cfg(target_os = "macos")]
        menu.init_for_nsapp();
        #[cfg(windows)]
        {
            let hwnd = primary_hwnd();
            if hwnd == 0 {
                return -1;
            }
            // Win32 SetMenu is safe cross-thread (it marshals internally);
            // the menu object itself stays thread_local on this thread.
            if unsafe { menu.init_for_hwnd(hwnd) }.is_err() {
                return -1;
            }
        }
        APP_MENU.with(|m| *m.borrow_mut() = Some(InstalledMenu { menu, items }));
        1
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    fn install_app_menu(_built: MenuBuild) -> c_int {
        0
    }

    pub(super) fn remove() -> c_int {
        APP_MENU.with(|m| {
            let Some(installed) = m.borrow_mut().take() else {
                return 0;
            };
            #[cfg(target_os = "macos")]
            installed.menu.remove_for_nsapp();
            #[cfg(windows)]
            {
                let hwnd = primary_hwnd();
                if hwnd != 0 {
                    let _ = unsafe { installed.menu.remove_for_hwnd(hwnd) };
                }
            }
            #[cfg(not(any(windows, target_os = "macos")))]
            let _ = installed;
            1
        })
    }

    fn item_by_id<R>(id: &str, f: impl Fn(&ItemHandle) -> Option<R>) -> Option<R> {
        APP_MENU
            .with(|m| {
                m.borrow()
                    .as_ref()
                    .and_then(|menu| menu.items.get(id))
                    .and_then(&f)
            })
            .or_else(|| TRAY_ITEMS.with(|t| t.borrow().get(id).and_then(f)))
    }

    pub(super) fn set_item_enabled(id: *const c_char, on: bool) -> c_int {
        let id = unsafe { std::ffi::CStr::from_ptr(id) }.to_string_lossy();
        item_by_id(id.as_ref(), |h| {
            h.set_enabled(on);
            Some(())
        })
        .map(|_| 1)
        .unwrap_or(0)
    }

    pub(super) fn set_item_checked(id: *const c_char, on: bool) -> c_int {
        let id = unsafe { std::ffi::CStr::from_ptr(id) }.to_string_lossy();
        item_by_id(
            id.as_ref(),
            |h| {
                if h.set_checked(on) {
                    Some(())
                } else {
                    None
                }
            },
        )
        .map(|_| 1)
        .unwrap_or(0)
    }

    pub(super) fn popup(x: c_int, y: c_int, opts_json: *const c_char) -> c_int {
        popup_impl(x, y, opts_json)
    }

    #[cfg(any(windows, target_os = "macos"))]
    fn popup_impl(x: c_int, y: c_int, opts_json: *const c_char) -> c_int {
        ensure_event_handler();
        let opts = parse_opts(opts_json);
        let built = build_menu(&opts, "");
        let menu = built.menu;
        let items: Vec<ItemHandle> = built.items.into_values().collect();
        let pos = muda::dpi::PhysicalPosition::new(x as f64, y as f64);
        #[cfg(target_os = "macos")]
        let shown = {
            let view = primary_nsview();
            if view.is_null() {
                return -1;
            }
            unsafe { menu.show_context_menu_for_nsview(view, Some(pos.into())) }
        };
        #[cfg(windows)]
        let shown = {
            let hwnd = primary_hwnd();
            if hwnd == 0 {
                return -1;
            }
            unsafe { menu.show_context_menu_for_hwnd(hwnd, Some(pos.into())) }
        };
        // `shown == false` means the user cancelled — still keep the
        // handles alive until the next popup (muda may deliver the
        // selection event slightly late).
        let _ = shown;
        POPUP.with(|p| *p.borrow_mut() = Some(PopupMenu { menu, items }));
        1
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    fn popup_impl(_x: c_int, _y: c_int, _opts_json: *const c_char) -> c_int {
        0
    }

    #[cfg(windows)]
    fn primary_hwnd() -> isize {
        use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
        let Some(w) = crate::window::window_by_handle(0) else {
            return 0;
        };
        let Ok(h) = w.window_handle() else {
            return 0;
        };
        match h.as_raw() {
            RawWindowHandle::Win32(wh) => wh.hwnd.get() as isize,
            _ => 0,
        }
    }

    #[cfg(target_os = "macos")]
    fn primary_nsview() -> *const std::ffi::c_void {
        use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
        let Some(w) = crate::window::window_by_handle(0) else {
            return std::ptr::null();
        };
        let Ok(h) = w.window_handle() else {
            return std::ptr::null();
        };
        match h.as_raw() {
            RawWindowHandle::AppKit(wh) => wh.ns_view.as_ptr(),
            _ => std::ptr::null(),
        }
    }
}

// ---------------------------------------------------------------------------
// Android stubs — no muda, no menus. (Linux *does* get here via the noop
// backend: dd_menu_set/popup still report 0 but the model parser and the
// tray path are real.)
// ---------------------------------------------------------------------------

#[cfg(target_os = "android")]
mod imp {
    use super::*;

    pub(super) fn set(_opts_json: *const c_char) -> c_int {
        0
    }
    pub(super) fn remove() -> c_int {
        0
    }
    pub(super) fn set_item_enabled(_id: *const c_char, _on: bool) -> c_int {
        0
    }
    pub(super) fn set_item_checked(_id: *const c_char, _on: bool) -> c_int {
        0
    }
    pub(super) fn popup(_x: c_int, _y: c_int, _opts_json: *const c_char) -> c_int {
        0
    }
}
