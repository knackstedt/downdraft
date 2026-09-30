//! downdraft-secrets — OS keychain cdylib (keyring crate).
//!
//! Optional companion to downdraft_platform: the host loads it via
//! `resolveNativeLibrary("downdraft_secrets", { optional: true })`. Absence
//! or a missing session keyring (no dbus / no secret-service daemon) simply
//! means "no credential store" — games should degrade to prompting or a
//! session-scoped token.
//!
//! FFI surface (all strings NUL-terminated UTF-8 `const char*`):
//!
//!   dd_sec_set(service, account, secret) -> i32
//!   dd_sec_get(service, account, out, out_cap) -> i32
//!   dd_sec_del(service, account) -> i32
//!
//! Return codes:
//!    0        success (dd_sec_get: value written to `out`, NUL-terminated)
//!    >0       dd_sec_get only: buffer too small — return value is the
//!             required byte count (excluding NUL); caller retries.
//!   -1        invalid arguments (null ptr)
//!   -2        entry not found
//!   -3        backend unavailable (no secret-service / keychain)
//!   -4        internal error (utf8, backend failure)
//!
//! Calls are blocking (ms-scale IPC to the secret store) — keep them off
//! the render hot path.

use keyring::Entry;
use std::ffi::CStr;
use std::os::raw::c_char;

const ERR_ARGS: i32 = -1;
const ERR_NOT_FOUND: i32 = -2;
const ERR_NO_BACKEND: i32 = -3;
const ERR_INTERNAL: i32 = -4;

unsafe fn read_str<'a>(ptr: *const c_char) -> Option<&'a str> {
    if ptr.is_null() {
        return None;
    }
    CStr::from_ptr(ptr).to_str().ok()
}

fn make_entry(service: &str, account: &str) -> Result<Entry, i32> {
    Entry::new(service, account).map_err(|e| match e {
        keyring::Error::NoStorageAccess(_) | keyring::Error::PlatformFailure(_) => ERR_NO_BACKEND,
        _ => ERR_INTERNAL,
    })
}

fn map_err(e: keyring::Error) -> i32 {
    match e {
        keyring::Error::NoEntry => ERR_NOT_FOUND,
        keyring::Error::NoStorageAccess(_) | keyring::Error::PlatformFailure(_) => ERR_NO_BACKEND,
        _ => ERR_INTERNAL,
    }
}

#[no_mangle]
pub extern "C" fn dd_sec_set(
    service: *const c_char,
    account: *const c_char,
    secret: *const c_char,
) -> i32 {
    unsafe {
        let (Some(s), Some(a), Some(v)) =
            (read_str(service), read_str(account), read_str(secret))
        else {
            return ERR_ARGS;
        };
        let entry = match make_entry(s, a) {
            Ok(e) => e,
            Err(code) => return code,
        };
        entry.set_password(v).map(|_| 0).unwrap_or_else(map_err)
    }
}

#[no_mangle]
pub extern "C" fn dd_sec_get(
    service: *const c_char,
    account: *const c_char,
    out: *mut c_char,
    out_cap: usize,
) -> i32 {
    unsafe {
        let (Some(s), Some(a)) = (read_str(service), read_str(account)) else {
            return ERR_ARGS;
        };
        let entry = match make_entry(s, a) {
            Ok(e) => e,
            Err(code) => return code,
        };
        let secret = match entry.get_password() {
            Ok(v) => v,
            Err(e) => return map_err(e),
        };
        let bytes = secret.as_bytes();
        if bytes.len() + 1 > out_cap {
            return bytes.len() as i32; // required size (excluding NUL)
        }
        if !out.is_null() {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), out as *mut u8, bytes.len());
            *out.add(bytes.len()) = 0;
        }
        0
    }
}

#[no_mangle]
pub extern "C" fn dd_sec_del(service: *const c_char, account: *const c_char) -> i32 {
    unsafe {
        let (Some(s), Some(a)) = (read_str(service), read_str(account)) else {
            return ERR_ARGS;
        };
        let entry = match make_entry(s, a) {
            Ok(e) => e,
            Err(code) => return code,
        };
        match entry.delete_credential() {
            Ok(()) => 0,
            Err(e) => map_err(e),
        }
    }
}
