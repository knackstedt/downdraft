//! libdowndraft_android — Android NativeActivity entry point.
//!
//! On Android this cdylib IS the process: it statically links
//! downdraft-platform (rlib), so every sdl_shim_*/wgpu_shim_* export lives in
//! this one .so. The JS side dlopens *this* library for FFI — that keeps a
//! single copy of the platform statics (the winit event state in particular
//! MUST be the same instance the JS thread drains).
//!
//! Boot order:
//!   ANativeActivity_onCreate (android-activity) → android_main()
//!     1. redirect stdout/stderr → logcat (all println!/JS console output)
//!     2. spawn JS thread → extract APK asset bundle → node::Start()
//!     3. downdraft_platform_run_android_app(app) — winit loop, never returns

#![cfg(target_os = "android")]

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use android_activity::AndroidApp;
use ndk::asset::AssetManager;

// node::Start is C++ ABI — resolved by its Itanium-mangled symbol.
// Signature: int node::Start(int argc, char** argv).
const NODE_START_SYM: &CStr = c"_ZN4node5StartEiPPc";
type NodeStart = unsafe extern "C" fn(c_int, *const *const c_char) -> c_int;

extern "C" {
    fn __android_log_write(prio: c_int, tag: *const c_char, text: *const c_char) -> c_int;
}

const LOG_INFO: c_int = 4;
const LOG_ERROR: c_int = 6;
const TAG: &CStr = c"downdraft";

fn log(prio: c_int, msg: &str) {
    let Ok(msg) = CString::new(msg) else { return };
    unsafe { __android_log_write(prio, TAG.as_ptr(), msg.as_ptr()) };
}

/// Asset subtree inside the APK → extracted to internalDataPath/bundle/.
/// The file node::Start runs is bundle/index.js — the packaging contract
/// owned by scripts/package-mobile.mjs.
const BUNDLE_ASSET_DIR: &str = "bundle";
const BUNDLE_ENTRY: &str = "index.js";

#[no_mangle]
fn android_main(app: AndroidApp) {
    redirect_stdio_to_logcat();
    log(LOG_INFO, "android_main: booting");

    let js_app = app.clone();
    // JS + V8 interpreter frames + FFI call chains need a real stack —
    // Rust's 2 MiB thread default (bionic's own is 1 MiB) is far too thin;
    // Node's main thread on desktop gets ~8 MiB of system stack. Give the
    // engine thread headroom comparable to a desktop main thread.
    std::thread::Builder::new()
        .stack_size(32 * 1024 * 1024)
        .spawn(move || js_thread(js_app))
        .expect("spawn js thread");

    // winit owns the app thread from here on.
    downdraft_platform::downdraft_platform_run_android_app(app);
}

/// Bridge Rust/JS stdio into logcat: dup2 a pipe onto fds 1+2 and forward each
/// line. Covers println!/eprintln!, Node's own stdout/stderr writes, and any
/// FFI-side fprintf we don't control.
fn redirect_stdio_to_logcat() {
    unsafe {
        let mut fds = [0i32; 2];
        if libc::pipe(fds.as_mut_ptr()) != 0 {
            return;
        }
        libc::dup2(fds[1], libc::STDOUT_FILENO);
        libc::dup2(fds[1], libc::STDERR_FILENO);
        libc::close(fds[1]);
        let rfd = fds[0];
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut line = Vec::with_capacity(256);
            loop {
                let n = libc::read(rfd, buf.as_mut_ptr().cast::<c_void>(), buf.len());
                if n <= 0 {
                    break;
                }
                for &b in &buf[..n as usize] {
                    if b == b'\n' {
                        write_line(&line);
                        line.clear();
                    } else {
                        line.push(b);
                    }
                }
            }
            if !line.is_empty() {
                write_line(&line);
            }
        });
    }
}

fn write_line(line: &[u8]) {
    let Ok(text) = CString::new(line) else { return };
    unsafe { __android_log_write(LOG_INFO, TAG.as_ptr(), text.as_ptr()) };
}

/// JS thread: extract the bundled engine+game assets, then hand control to
/// libnode for the process lifetime.
fn js_thread(app: AndroidApp) {
    let root = match prepare_bundle(&app) {
        Ok(p) => p,
        Err(e) => {
            log(LOG_ERROR, &format!("bundle extraction failed: {e}"));
            return;
        }
    };
    let entry = root.join(BUNDLE_ENTRY);
    log(LOG_INFO, &format!("node_start → {}", entry.display()));

    // Process env for the JS side: HOME/TMPDIR keep node + the engine's
    // save/path code pointed at writable storage; DOWNDRAFT_BUNDLE_DIR is
    // the extraction root the packaged bundle resolves paths against
    // (import.meta.dir rewrites, worker files, dd-assets).
    let data = app.internal_data_path().unwrap_or_else(|| root.clone());
    let _ = std::fs::create_dir_all(data.join("tmp"));
    set_env(c"HOME", &data);
    set_env(c"TMPDIR", &data.join("tmp"));
    set_env(c"DOWNDRAFT_DATA_DIR", &data);
    set_env(c"DOWNDRAFT_BUNDLE_DIR", &root);

    // Native addons (.node) resolve napi_* symbols from the namespace's
    // reloc-time global group — they carry no DT_NEEDED libnode.so. On
    // bionic that group consists ONLY of libraries whose own DT_FLAGS_1
    // carries DF_1_GLOBAL (RTLD_GLOBAL request flags do NOT enter it);
    // our libnode.so is linked -Wl,-z,global for exactly this reason.
    // We still dlopen it ourselves rather than DT_NEEDED so the first
    // load happens under our control before node::Start runs.
    let node_start = match load_node(&app) {
        Some(f) => f,
        None => {
            log(LOG_ERROR, "libnode.so not loadable — aborting node start");
            return;
        }
    };

    let argv0 = CString::new("node").unwrap();
    let argv1 = CString::new(entry.as_os_str().as_bytes()).unwrap();
    let argv = [argv0.as_ptr(), argv1.as_ptr()];

    let rc = unsafe { node_start(2, argv.as_ptr()) };
    log(LOG_ERROR, &format!("node_start exited rc={rc}"));
}

/// First-load libnode.so RTLD_GLOBAL and resolve node::Start via dlsym.
/// Bare soname first (the classloader namespace searches the app lib dir);
/// falls back to an absolute path derived from our own .so via dladdr
/// (bionic has no dlinfo).
fn load_node(app: &AndroidApp) -> Option<NodeStart> {
    let _ = app;
    unsafe {
        let mut h = libc::dlopen(c"libnode.so".as_ptr(), libc::RTLD_NOW | libc::RTLD_GLOBAL);
        if h.is_null() {
            // Derive <our lib dir>/libnode.so from this .so's mapped path.
            let mut info: libc::Dl_info = std::mem::zeroed();
            if libc::dladdr(load_node as usize as *const c_void, &mut info) != 0
                && !info.dli_fname.is_null()
            {
                let self_path = CStr::from_ptr(info.dli_fname).to_string_lossy();
                if let Some(dir) = Path::new(self_path.as_ref()).parent() {
                    let p = CString::new(dir.join("libnode.so").as_os_str().as_bytes()).ok()?;
                    h = libc::dlopen(p.as_ptr(), libc::RTLD_NOW | libc::RTLD_GLOBAL);
                }
            }
        }
        if h.is_null() {
            let e = libc::dlerror();
            let msg = if e.is_null() { "unknown".into() } else { CStr::from_ptr(e).to_string_lossy().into_owned() };
            log(LOG_ERROR, &format!("dlopen libnode.so: {msg}"));
            return None;
        }
        let sym = libc::dlsym(h, NODE_START_SYM.as_ptr());
        if sym.is_null() {
            log(LOG_ERROR, "dlsym node::Start failed");
            return None;
        }
        // Probe: RTLD_DEFAULT searches the global group — the same scope
        // .node addons resolve their undefined napi_* symbols against.
        let probe = libc::dlsym(libc::RTLD_DEFAULT, c"napi_delete_reference".as_ptr());
        log(LOG_INFO, &format!("napi probe via RTLD_DEFAULT: {}", if probe.is_null() { "MISSING" } else { "ok" }));
        Some(std::mem::transmute::<*mut c_void, NodeStart>(sym))
    }
}

fn set_env(key: &'static CStr, value: &Path) {
    let Ok(val) = CString::new(value.as_os_str().as_bytes()) else {
        return;
    };
    unsafe { libc::setenv(key.as_ptr(), val.as_ptr(), 1) };
}

/// Mirror assets/<BUNDLE_ASSET_DIR>/ into internalDataPath/<BUNDLE_ASSET_DIR>/.
/// Always copies — bundles are small and this doubles as the
/// "fresh install on every deploy" semantic APK updates need anyway.
fn prepare_bundle(app: &AndroidApp) -> std::io::Result<PathBuf> {
    let mgr = app.asset_manager();
    let dest_root = app
        .internal_data_path()
        .ok_or_else(|| std::io::Error::other("internal_data_path unavailable"))?
        .join(BUNDLE_ASSET_DIR);
    extract_dir(&mgr, &dest_root)?;
    Ok(dest_root)
}

/// AAssetDir does NOT enumerate subdirectories (only direct child file
/// names), so a nested bundle can't be discovered by walking. The packager
/// writes bundle/manifest.txt listing every bundled file — extraction just
/// follows the list.
fn extract_dir(mgr: &AssetManager, dest: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;

    let manifest_rel = format!("{BUNDLE_ASSET_DIR}/manifest.txt");
    let manifest = read_asset(mgr, &manifest_rel)?;
    for line in manifest.split(|&b| b == b'\n') {
        if line.is_empty() || line == b"manifest.txt" {
            continue;
        }
        // Lines are "asset_path\tdest_path" — aapt2 drops dot-prefixed
        // path segments, so the packager stages those files under sanitized
        // names while dest_path stays verbatim. Pre-mapping manifests (no
        // tab) still work: asset == dest.
        let text = String::from_utf8_lossy(line);
        let (asset_rel, dest_rel) = text.split_once('\t').unwrap_or((&text, &text));
        let src = format!("{BUNDLE_ASSET_DIR}/{asset_rel}");
        let bytes = read_asset(mgr, &src)?;
        let out_path = dest.join(dest_rel);
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::File::create(&out_path)?.write_all(&bytes)?;
    }
    Ok(())
}

fn read_asset(mgr: &AssetManager, rel: &str) -> std::io::Result<Vec<u8>> {
    let c =
        CString::new(rel).map_err(|_| std::io::Error::other(format!("nul in asset path {rel}")))?;
    let mut asset = mgr
        .open(&c)
        .ok_or_else(|| std::io::Error::other(format!("asset {rel} missing")))?;
    Ok(asset.buffer()?.to_vec())
}
