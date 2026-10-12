// Probe the vendored WPE SDK/runtime prefix. The WebKit SDK container build
// drops an installable prefix under ../vendor/wpe-<plat>/ (libglib, libgobject,
// libwpe-2.0, libWPEWebKit-2.0, the GIO platform modules, helper binaries).
// Absent the prefix the crate builds as a stub (dd_webui_create → null).

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
    println!("cargo:rerun-if-changed={}", dir.display());
    println!("cargo:rustc-env=DD_WPE_PREFIX={}", dir.display());
    if !dir.exists() {
        println!(
            "cargo:warning=WPE prefix not staged at {} — stub build; see \
             packages/engine/libraries/webui/scripts/build-wpe.sh (WebKit SDK \
             container) for a real build",
            dir.display()
        );
        return;
    }
    // Phase 2 wires the real link line against the prefix's pkg-config set
    // plus a $ORIGIN rpath so the staged runtime resolves.
}
