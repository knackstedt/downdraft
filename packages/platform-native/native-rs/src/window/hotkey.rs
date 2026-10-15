//! Global hotkeys — X11 XGrabKey on the root window over a dedicated
//! connection + pump thread, pushing Ev::Hotkey into the shared event
//! queue. Wayland has no passive-grab equivalent (portal territory); the
//! FFI fails cleanly there and on non-Linux builds.

use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Mutex, OnceLock};

// Key modifier mask bits mirror XCB (Shift=1, Lock=2, Control=4,
// Mod1..5=8/16/32/64/128). JS maps accelerator strings onto these.
#[cfg(target_os = "linux")]
mod x11 {
    use super::super::events::{push, Ev};
    use std::collections::HashMap;
    use std::sync::mpsc::{channel, Sender};
    use std::thread;
    use std::time::Duration;
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::*;
    use x11rb::protocol::Event;
    use x11rb::rust_connection::RustConnection;

    const XCB_LOCK_MASK: u16 = 2;
    const XCB_MOD2_MASK: u16 = 16; // NumLock on virtually every layout

    enum Cmd {
        Grab {
            id: i32,
            mods: u16,
            keysym: u32,
            reply: Sender<i32>,
        },
        Ungrab {
            id: i32,
            reply: Sender<i32>,
        },
    }

    pub struct HotkeyMgr {
        tx: Sender<Cmd>,
    }

    /// Resolve a keysym to every keycode that produces it (keyboards map
    /// a keysym per group/shift column — grab them all).
    fn keycodes_for(conn: &RustConnection, keysym: u32) -> Vec<u8> {
        let setup = conn.setup();
        let lo = setup.min_keycode;
        let count = setup.max_keycode - lo + 1;
        let Ok(map) = conn.get_keyboard_mapping(lo, count) else {
            return Vec::new();
        };
        let Ok(reply) = map.reply() else {
            return Vec::new();
        };
        let per = reply.keysyms_per_keycode as usize;
        let mut out = Vec::new();
        for i in 0..count as usize {
            let kc = (lo as usize + i) as u8;
            if reply.keysyms[i * per..(i + 1) * per].contains(&keysym) {
                out.push(kc);
            }
        }
        out
    }

    fn run(conn: RustConnection, rx: std::sync::mpsc::Receiver<Cmd>) {
        let root = conn.setup().roots[0].root;
        // Grab-delivered KeyPresses still need the mask selected on the
        // grab window; KEY_PRESS on root is shareable (unlike the
        // exclusive SubstructureRedirect family).
        let _ = conn.change_window_attributes(
            root,
            &ChangeWindowAttributesAux::new().event_mask(EventMask::KEY_PRESS),
        );
        let _ = conn.flush();
        // id → (keycodes grabbed, base mods) for ungrab/re-grab bookkeeping.
        let mut grabs: HashMap<i32, (Vec<u8>, u16)> = HashMap::new();
        // (keycode, normalized mods) → id for event dispatch.
        let mut dispatch: HashMap<(u8, u16), i32> = HashMap::new();
        const VARIANTS: [u16; 4] = [
            0,
            XCB_LOCK_MASK,
            XCB_MOD2_MASK,
            XCB_LOCK_MASK | XCB_MOD2_MASK,
        ];

        loop {
            while let Ok(Some(ev)) = conn.poll_for_event() {
                if let Event::KeyPress(kp) = ev {
                    let norm = u16::from(kp.state) & !(XCB_LOCK_MASK | XCB_MOD2_MASK);
                    if let Some(&id) = dispatch.get(&(kp.detail, norm)) {
                        push(0, Ev::Hotkey { id });
                    }
                }
            }
            match rx.recv_timeout(Duration::from_millis(30)) {
                Ok(Cmd::Grab {
                    id,
                    mods,
                    keysym,
                    reply,
                }) => {
                    let keycodes = keycodes_for(&conn, keysym);
                    let mut ok = !keycodes.is_empty();
                    for &kc in &keycodes {
                        for extra in VARIANTS {
                            let m = mods | extra;
                            let ck = conn.grab_key(
                                false,
                                root,
                                ModMask::from(m),
                                kc,
                                GrabMode::ASYNC,
                                GrabMode::ASYNC,
                            );
                            match ck {
                                Ok(c) => {
                                    if let Err(e) = c.check() {
                                        eprintln!("[hotkey] grab kc={kc} mods={m:#x}: {e}");
                                        ok = false;
                                    }
                                }
                                Err(e) => {
                                    eprintln!("[hotkey] grab kc={kc} mods={m:#x}: {e}");
                                    ok = false;
                                }
                            }
                            dispatch.insert((kc, mods), id);
                        }
                    }
                    if ok {
                        grabs.insert(id, (keycodes, mods));
                    }
                    let _ = conn.flush();
                    let _ = reply.send(if ok { 0 } else { -1 });
                }
                Ok(Cmd::Ungrab { id, reply }) => {
                    if let Some((keycodes, mods)) = grabs.remove(&id) {
                        for kc in keycodes {
                            for extra in VARIANTS {
                                let _ = conn.ungrab_key(kc, root, ModMask::from(mods | extra));
                            }
                            dispatch.remove(&(kc, mods));
                        }
                        let _ = conn.flush();
                    }
                    let _ = reply.send(0);
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
    }

    pub fn spawn() -> Option<HotkeyMgr> {
        let (conn, _screen) = RustConnection::connect(None).ok()?;
        let (tx, rx) = channel::<Cmd>();
        thread::Builder::new()
            .name("hotkey-x11".into())
            .spawn(move || run(conn, rx))
            .ok()?;
        Some(HotkeyMgr { tx })
    }

    impl HotkeyMgr {
        pub fn grab(&self, mods: u16, keysym: u32, id: i32) -> i32 {
            let (reply, rx) = channel();
            if self
                .tx
                .send(Cmd::Grab {
                    id,
                    mods,
                    keysym,
                    reply,
                })
                .is_err()
            {
                return -1;
            }
            rx.recv_timeout(Duration::from_secs(2)).unwrap_or(-1)
        }

        pub fn ungrab(&self, id: i32) -> i32 {
            let (reply, rx) = channel();
            if self.tx.send(Cmd::Ungrab { id, reply }).is_err() {
                return -1;
            }
            rx.recv_timeout(Duration::from_secs(2)).unwrap_or(-1)
        }
    }
}

#[cfg(target_os = "linux")]
static MGR: OnceLock<Option<x11::HotkeyMgr>> = OnceLock::new();

#[cfg(target_os = "linux")]
fn manager() -> Option<&'static x11::HotkeyMgr> {
    MGR.get_or_init(x11::spawn).as_ref()
}

static NEXT_ID: AtomicI32 = AtomicI32::new(1);
/// Tracks live grab ids so ungrab is a safe no-op on unknown ids.
static LIVE: Mutex<Vec<i32>> = Mutex::new(Vec::new());

/// Grab a global hotkey. `mods` uses the XCB modifier mask layout
/// (Shift=1, Control=4, Mod1/Alt=8, Mod4/Super=64); `keysym` is the X11
/// keysym (F1=0xFFBE). Returns a hotkey id >0 on success, <=0 on failure
/// (no X connection, keycode unresolvable, grab conflict). The id arrives
/// in Ev::Hotkey events on the shared queue.
#[no_mangle]
pub extern "C" fn dd_hotkey_grab(mods: u32, keysym: u32) -> i32 {
    #[cfg(target_os = "linux")]
    {
        let Some(mgr) = manager() else { return -1 };
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        if mgr.grab(mods as u16, keysym, id) == 0 {
            LIVE.lock().unwrap().push(id);
            return id;
        }
        -2
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (mods, keysym);
        -1
    }
}

/// Release a grabbed hotkey id. No-op for unknown ids.
#[no_mangle]
pub extern "C" fn dd_hotkey_ungrab(id: i32) -> i32 {
    #[cfg(target_os = "linux")]
    {
        let mut live = LIVE.lock().unwrap();
        let Some(pos) = live.iter().position(|&v| v == id) else {
            return 0;
        };
        live.remove(pos);
        drop(live);
        manager().map_or(-1, |m| m.ungrab(id))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = id;
        0
    }
}
