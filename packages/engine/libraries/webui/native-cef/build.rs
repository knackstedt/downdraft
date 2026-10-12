// Locate the staged CEF runtime. fetch-cef.mjs drops the merged
// Release+Resources tree under ../vendor/cef/<ver>/cef_<os>_<arch>/ —
// the same layout cef-dll-sys resolves through CEF_PATH (build-native.mjs
// exports it when the vendor dir exists; otherwise the sys crate
// downloads the pinned archive itself).
//
// DD_CEF_RUNTIME_DIR is consumed by lib.rs at global_init: it seeds
// CefSettings{resources_dir_path,locales_dir_path,browser_subprocess_path}
// and the directory the packager mirrors next to the cdylib. When the
// vendor dir is absent we still build — the sys crate's own download
// lands under OUT_DIR and DD_CEF_RUNTIME_DIR falls back to the .so's
// directory (where the runtime files are staged at packaging time).

use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let vendor = manifest.join("../vendor/cef");
    println!("cargo:rerun-if-changed={}", vendor.display());

    // Pick the single versioned dist dir — fetch-cef.mjs only stages the
    // pinned version; if several exist take the lexically greatest.
    let cef_dir = fs::read_dir(&vendor)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .flat_map(|ver| fs::read_dir(ver.path()).ok().into_iter().flatten().flatten())
        .map(|e| e.path())
        .filter(|p| p.join("archive.json").exists())
        .max();

    match cef_dir {
        Some(dir) => {
            println!("cargo:rustc-env=DD_CEF_RUNTIME_DIR={}", dir.display());
        }
        None => {
            println!("cargo:rustc-env=DD_CEF_RUNTIME_DIR=");
            println!(
                "cargo:warning=CEF runtime not vendored under {} — \
                 cef-dll-sys will download its pinned archive to OUT_DIR; \
                 run packages/engine/libraries/webui/scripts/fetch-cef.mjs \
                 to vendor it",
                vendor.display()
            );
        }
    }

    // $ORIGIN rpath: the cdylib links libcef.so dynamically; the runtime
    // tree is staged beside it in dist/<plat>-<arch>/ and in packaged
    // output. Without this the loader only searches system paths.
    if env::var("TARGET").map(|t| t.contains("linux")).unwrap_or(false) {
        println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN");
    }
}
