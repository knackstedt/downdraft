//! pty.rs — pty_shim_* exports: pseudo-terminal spawn/read/write/resize/kill.
//!
//! Wire contract (consumed by packages/platform-native/src/terminal/pty-ffi.ts):
//!   spawn(cmd, args \x1f-joined, cwd, cols, rows) → handle (0 = failure)
//!   read(handle, buf, cap)   → bytes copied (nonblocking; 0 = none, -1 = bad handle)
//!   write(handle, buf, len)  → bytes written (-1 = bad handle)
//!   resize(handle, cols, rows)
//!   exited(handle)           → 0 running, 1 exited, -1 bad handle
//!   exit_code(handle)        → exit code or -1
//!   kill(handle), release(handle)
//!
//! The pty reader thread drains the master fd into a shared buffer so JS-side
//! `read` never blocks; the buffer is capped and drops the oldest bytes when
//! the consumer falls too far behind.

use portable_pty::{Child, CommandBuilder, MasterPty, PtySize};
use std::collections::VecDeque;
use std::ffi::CStr;
use std::io::{Read, Write};
use std::os::raw::{c_char, c_int, c_uchar};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::thread;

/// Cap on buffered-but-unread pty output; beyond this the oldest bytes are
/// dropped (a flooded terminal with a stalled UI must not OOM the host).
const OUT_CAP: usize = 8 * 1024 * 1024;

struct Pty {
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    writer: Box<dyn Write + Send>,
    out: Arc<Mutex<VecDeque<u8>>>,
    dead: Arc<AtomicBool>,
}

fn table() -> MutexGuard<'static, Vec<Option<Pty>>> {
    static T: OnceLock<Mutex<Vec<Option<Pty>>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(Vec::new())).lock().unwrap()
}

fn slot(h: u64) -> Option<usize> {
    let i = (h as usize).checked_sub(1)?;
    let t = table();
    match t.get(i) {
        Some(Some(_)) => Some(i),
        _ => None,
    }
}

unsafe fn cstr<'a>(p: *const c_char) -> &'a str {
    if p.is_null() {
        return "";
    }
    CStr::from_ptr(p).to_str().unwrap_or("")
}

/// Spawn `cmd` under a PTY. `args` is a single UTF-8 string with arguments
/// separated by \x1f (unit separator); empty = no args. Returns a handle, 0 on
/// failure.
#[no_mangle]
pub extern "C" fn pty_shim_spawn(
    cmd: *const c_char,
    args: *const c_char,
    cwd: *const c_char,
    cols: u32,
    rows: u32,
) -> u64 {
    ffi!(0, {
        let cmd_s = unsafe { cstr(cmd) };
        if cmd_s.is_empty() {
            return 0;
        }
        let arg_s = unsafe { cstr(args) };
        let cwd_s = unsafe { cstr(cwd) };

        let size = PtySize {
            rows: rows.clamp(1, 512) as u16,
            cols: cols.clamp(1, 1024) as u16,
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = match portable_pty::native_pty_system().openpty(size) {
            Ok(p) => p,
            Err(_) => return 0,
        };
        let mut cb = CommandBuilder::new(cmd_s);
        for a in arg_s.split('\x1f') {
            if !a.is_empty() {
                cb.arg(a);
            }
        }
        if !cwd_s.is_empty() {
            cb.cwd(cwd_s);
        }
        // A real term env so full-screen apps pick a usable code path.
        if std::env::var_os("TERM").is_none() {
            cb.env("TERM", "xterm-256color");
        }
        let child = match pair.slave.spawn_command(cb) {
            Ok(c) => c,
            Err(_) => return 0,
        };
        // The slave side must be dropped in the parent or reads never see EOF.
        drop(pair.slave);

        let writer = match pair.master.take_writer() {
            Ok(w) => w,
            Err(_) => return 0,
        };
        let mut reader = match pair.master.try_clone_reader() {
            Ok(r) => r,
            Err(_) => return 0,
        };

        let out = Arc::new(Mutex::new(VecDeque::<u8>::new()));
        let dead = Arc::new(AtomicBool::new(false));
        let mut t = table();
        t.push(Some(Pty {
            master: pair.master,
            child,
            writer,
            out: Arc::clone(&out),
            dead: Arc::clone(&dead),
        }));
        let idx = t.len();
        drop(t);

        // Reader thread: blocking reads → shared buffer. Exits on EOF/error.
        thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => {
                        let mut q = out.lock().unwrap();
                        let over = q.len() + n;
                        if over > OUT_CAP {
                            let drop_n = (over - OUT_CAP).min(q.len());
                            q.drain(..drop_n);
                        }
                        q.extend(&chunk[..n]);
                    }
                    Err(_) => break,
                }
            }
            dead.store(true, Ordering::SeqCst);
        });

        idx as u64
    })
}

/// Nonblocking drain of buffered pty output. Returns bytes copied, 0 when the
/// buffer is empty, -1 on a bad handle.
#[no_mangle]
pub extern "C" fn pty_shim_read(h: u64, buf: *mut c_uchar, cap: c_int) -> c_int {
    ffi!(-1, {
        if buf.is_null() || cap <= 0 {
            return 0;
        }
        let i = match slot(h) {
            Some(i) => i,
            None => return -1,
        };
        let mut t = table();
        let p = match t.get_mut(i).and_then(|s| s.as_mut()) {
            Some(p) => p,
            None => return -1,
        };
        let mut q = p.out.lock().unwrap();
        let n = q.len().min(cap as usize);
        let (a, b) = q.as_slices();
        unsafe {
            let first = a.len().min(n);
            std::ptr::copy_nonoverlapping(a.as_ptr(), buf, first);
            if first < n {
                std::ptr::copy_nonoverlapping(b.as_ptr(), buf.add(first), n - first);
            }
        }
        q.drain(..n);
        n as c_int
    })
}

/// Write `len` bytes to the pty. Returns bytes written or -1 on a bad handle.
#[no_mangle]
pub extern "C" fn pty_shim_write(h: u64, data: *const c_uchar, len: c_int) -> c_int {
    ffi!(-1, {
        let i = match slot(h) {
            Some(i) => i,
            None => return -1,
        };
        if data.is_null() || len <= 0 {
            return 0;
        }
        let mut t = table();
        let p = match t.get_mut(i).and_then(|s| s.as_mut()) {
            Some(p) => p,
            None => return -1,
        };
        let slice = unsafe { std::slice::from_raw_parts(data, len as usize) };
        match p.writer.write(slice) {
            Ok(n) => {
                let _ = p.writer.flush();
                n as c_int
            }
            Err(_) => -1,
        }
    })
}

/// Resize the pty window (SIGWINCH the child on unix).
#[no_mangle]
pub extern "C" fn pty_shim_resize(h: u64, cols: u32, rows: u32) {
    ffi!((), {
        let i = match slot(h) {
            Some(i) => i,
            None => return,
        };
        let t = table();
        if let Some(Some(p)) = t.get(i) {
            let _ = p.master.resize(PtySize {
                rows: rows.clamp(1, 512) as u16,
                cols: cols.clamp(1, 1024) as u16,
                pixel_width: 0,
                pixel_height: 0,
            });
        }
    })
}

/// 0 = running, 1 = exited (or reader EOF), -1 = bad handle.
#[no_mangle]
pub extern "C" fn pty_shim_exited(h: u64) -> c_int {
    ffi!(-1, {
        let i = match slot(h) {
            Some(i) => i,
            None => return -1,
        };
        let mut t = table();
        let p = match t.get_mut(i).and_then(|s| s.as_mut()) {
            Some(p) => p,
            None => return -1,
        };
        if p.dead.load(Ordering::SeqCst) {
            return 1;
        }
        match p.child.try_wait() {
            Ok(Some(_)) => 1,
            _ => 0,
        }
    })
}

/// Exit code once `pty_shim_exited` reports 1, else -1.
#[no_mangle]
pub extern "C" fn pty_shim_exit_code(h: u64) -> c_int {
    ffi!(-1, {
        let i = match slot(h) {
            Some(i) => i,
            None => return -1,
        };
        let mut t = table();
        let p = match t.get_mut(i).and_then(|s| s.as_mut()) {
            Some(p) => p,
            None => return -1,
        };
        match p.child.try_wait() {
            Ok(Some(st)) => st.exit_code() as c_int,
            _ => -1,
        }
    })
}

/// Kill the child process.
#[no_mangle]
pub extern "C" fn pty_shim_kill(h: u64) {
    ffi!((), {
        let i = match slot(h) {
            Some(i) => i,
            None => return,
        };
        let mut t = table();
        if let Some(Some(p)) = t.get_mut(i) {
            let _ = p.child.kill();
        }
    })
}

/// Drop the handle (kills the child first if still running).
#[no_mangle]
pub extern "C" fn pty_shim_release(h: u64) {
    ffi!((), {
        let i = match slot(h) {
            Some(i) => i,
            None => return,
        };
        let mut t = table();
        if let Some(slot) = t.get_mut(i) {
            if let Some(mut p) = slot.take() {
                let _ = p.child.kill();
            }
        }
    })
}
