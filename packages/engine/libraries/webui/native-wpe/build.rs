// Link against the vendored WPE prefix — see scripts/fetch-wpe.mjs, which
// stages the Debian trixie package closure under ../vendor/wpe-<plat>/
// (lib/, libexec/, share/, include/). Absent the prefix the crate still
// builds — dd_webui_global_init just fails and views report unavailable.

use std::env;
use std::path::PathBuf;

fn main() {
    let target = env::var("TARGET").unwrap_or_default();
    let plat = match target.as_str() {
        "x86_64-unknown-linux-gnu" => Some("linux-x64"),
        "aarch64-unknown-linux-gnu" => Some("linux-arm64"),
        "aarch64-linux-android" => Some("android-arm64"),
        "x86_64-linux-android" => Some("android-x64"),
        _ => None,
    };
    let Some(plat) = plat else { return };
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../vendor")
        .join(format!("wpe-{plat}"));
    let lib = dir.join("lib");
    println!("cargo:rerun-if-changed={}", dir.display());
    println!("cargo:rustc-env=DD_WPE_PREFIX={}", dir.display());
    if !lib.join("libWPEWebKit-2.0.so").exists() {
        println!(
            "cargo:warning=WPE prefix not staged at {} — unlinked build; run \
             packages/engine/libraries/webui/scripts/fetch-wpe.mjs first",
            lib.display()
        );
        return;
    }

    println!("cargo:rustc-link-search=native={}", lib.display());
    // Direct refs only — the rest of the closure resolves transitively via
    // the vendored libs' own NEEDED entries + our $ORIGIN/lib rpath.
    for l in [
        "wpe-1.0",
        "WPEBackend-fdo-1.0",
        "WPEWebKit-2.0",
        "wayland-server",
        "glib-2.0",
        "gobject-2.0",
    ] {
        println!("cargo:rustc-link-lib=dylib={l}");
    }
    // Vendored libs stage under <dist>/lib next to the cdylib. RPATH (not
    // RUNPATH) is deliberate: old-style DT_RPATH applies transitively to
    // the whole dependency tree, so the vendored Debian libs — which carry
    // no rpath of their own — also resolve their own NEEDED deps from
    // $ORIGIN/lib without patchelf or LD_LIBRARY_PATH.
    println!("cargo:rustc-link-arg=-Wl,--disable-new-dtags,-rpath,$ORIGIN/lib");
}
