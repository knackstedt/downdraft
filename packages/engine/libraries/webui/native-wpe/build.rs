// Link against the vendored WPE prefix:
//   desktop — scripts/fetch-wpe.mjs stages the Debian trixie package
//             closure under ../vendor/wpe-<plat>/ (lib/, libexec/, share/).
//   android — scripts/fetch-wpe-android.mjs stages the wpeview AAR under
//             ../vendor/wpe-android/ (jni/<abi>/, assets/, classes.jar).
// Absent the prefix the crate still builds — dd_webui_global_init just
// fails and views report unavailable.

use std::env;
use std::path::PathBuf;

fn main() {
    let target = env::var("TARGET").unwrap_or_default();
    let android = target.contains("android");
    // (vendor dir, lib subdir, link libs)
    let spec: Option<(&str, &str, &[&str])> = match target.as_str() {
        "x86_64-unknown-linux-gnu" => Some((
            "wpe-linux-x64",
            "lib",
            &[
                "wpe-1.0",
                "WPEBackend-fdo-1.0",
                "WPEWebKit-2.0",
                "wayland-server",
                "glib-2.0",
                "gobject-2.0",
            ],
        )),
        "aarch64-unknown-linux-gnu" => Some((
            "wpe-linux-arm64",
            "lib",
            &[
                "wpe-1.0",
                "WPEBackend-fdo-1.0",
                "WPEWebKit-2.0",
                "wayland-server",
                "glib-2.0",
                "gobject-2.0",
            ],
        )),
        "aarch64-linux-android" => Some((
            "wpe-android",
            "jni/arm64-v8a",
            &[
                "wpe-1.0",
                "WPEBackend-android",
                "WPEWebKit-2.0",
                "glib-2.0",
                "gobject-2.0",
                "gio-2.0",
                "android",
            ],
        )),
        "x86_64-linux-android" => Some((
            "wpe-android",
            "jni/x86_64",
            &[
                "wpe-1.0",
                "WPEBackend-android",
                "WPEWebKit-2.0",
                "glib-2.0",
                "gobject-2.0",
                "gio-2.0",
                "android",
            ],
        )),
        _ => None,
    };
    let Some((plat, librel, libs)) = spec else { return };
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../vendor")
        .join(plat);
    let lib = dir.join(librel);
    println!("cargo:rerun-if-changed={}", dir.display());
    println!("cargo:rustc-env=DD_WPE_PREFIX={}", dir.display());
    if !lib.join("libWPEWebKit-2.0.so").exists() {
        println!(
            "cargo:warning=WPE prefix not staged at {} — unlinked build; run \
             packages/engine/libraries/webui/scripts/fetch-wpe*.mjs first",
            lib.display()
        );
        return;
    }

    println!("cargo:rustc-link-search=native={}", lib.display());
    // Direct refs only — the rest of the closure resolves transitively via
    // the vendored libs' own NEEDED entries (+ our $ORIGIN/lib rpath on
    // linux; the app's jniLibs dir on android).
    for l in libs {
        println!("cargo:rustc-link-lib=dylib={l}");
    }
    if android {
        println!("cargo:rustc-link-lib=dylib=log");
    } else {
        // Vendored libs stage under <dist>/lib next to the cdylib. RPATH
        // (not RUNPATH) is deliberate: old-style DT_RPATH applies
        // transitively to the whole dependency tree, so the vendored
        // Debian libs — which carry no rpath of their own — also resolve
        // their own NEEDED deps from $ORIGIN/lib without patchelf or
        // LD_LIBRARY_PATH.
        println!("cargo:rustc-link-arg=-Wl,--disable-new-dtags,-rpath,$ORIGIN/lib");
    }
}
