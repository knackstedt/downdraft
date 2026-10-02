// Link config for the Android shell cdylib — just liblog for
// __android_log_write.
//
// libnode.so is deliberately NOT linked (no DT_NEEDED): Node addons (.node
// files) carry no DT_NEEDED on it and resolve napi_* from the global group,
// but a dep-loaded lib stays in the caller's local group. The shell instead
// dlopen()s libnode RTLD_GLOBAL as its first load — see load_node() in
// src/lib.rs.

fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("android") {
        return;
    }

    println!("cargo:rustc-link-lib=log");
}
