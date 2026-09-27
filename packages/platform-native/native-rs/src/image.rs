//! image.rs — image_shim_* exports (Rust `image` crate port of image_shim.c /
//! stb_image).
//!
//! Wire contract (must match packages/platform-native/src/image/native-image.ts):
//!   decode / decode_file / info  → 0 ok, 1 decode failure, 2 out buffer too small
//!   decode always writes RGBA8 and reports channels_out = 4
//!   info reports the *source* channel count (matching stbi_info semantics)
//!   on failure (1 or 2) the out params are left untouched — same as the C shim

use image::ImageDecoder as _;
use std::ffi::CStr;
use std::io::Cursor;
use std::os::raw::{c_char, c_int, c_uchar};
use std::ptr;

const OK: c_int = 0;
const ERR_DECODE: c_int = 1;
const ERR_SIZE: c_int = 2;

unsafe fn write_out(p: *mut c_int, v: c_int) {
    if !p.is_null() {
        *p = v;
    }
}

/// Copy an RGBA8 image into the JS-provided buffer, mirroring the C shim's
/// ordering: validate size first, then memcpy, then write outputs.
unsafe fn copy_rgba(
    rgba: image::RgbaImage,
    out_data: *mut c_uchar,
    out_size: c_int,
    w_out: *mut c_int,
    h_out: *mut c_int,
    c_out: *mut c_int,
) -> c_int {
    let need = rgba.len();
    if out_data.is_null() || out_size < 0 || (out_size as usize) < need {
        return ERR_SIZE;
    }
    ptr::copy_nonoverlapping(rgba.as_ptr(), out_data, need);
    write_out(w_out, rgba.width() as c_int);
    write_out(h_out, rgba.height() as c_int);
    write_out(c_out, 4);
    OK
}

unsafe fn decode_bytes(
    bytes: &[u8],
    out_data: *mut c_uchar,
    out_size: c_int,
    w_out: *mut c_int,
    h_out: *mut c_int,
    c_out: *mut c_int,
) -> c_int {
    let img = match image::load_from_memory(bytes) {
        Ok(i) => i,
        Err(_) => return ERR_DECODE,
    };
    copy_rgba(img.to_rgba8(), out_data, out_size, w_out, h_out, c_out)
}

#[no_mangle]
pub unsafe extern "C" fn image_shim_decode(
    data: *const c_uchar,
    size: c_int,
    out_data: *mut c_uchar,
    out_size: c_int,
    w_out: *mut c_int,
    h_out: *mut c_int,
    c_out: *mut c_int,
) -> c_int {
    ffi!(ERR_DECODE, {
        if data.is_null() || size <= 0 {
            return ERR_DECODE;
        }
        let bytes = std::slice::from_raw_parts(data, size as usize);
        decode_bytes(bytes, out_data, out_size, w_out, h_out, c_out)
    })
}

#[no_mangle]
pub unsafe extern "C" fn image_shim_decode_file(
    path: *const c_char,
    out_data: *mut c_uchar,
    out_size: c_int,
    w_out: *mut c_int,
    h_out: *mut c_int,
    c_out: *mut c_int,
) -> c_int {
    ffi!(ERR_DECODE, {
        if path.is_null() {
            return ERR_DECODE;
        }
        let path = CStr::from_ptr(path).to_string_lossy();
        let img = match image::open(path.as_ref()) {
            Ok(i) => i,
            Err(_) => return ERR_DECODE,
        };
        copy_rgba(img.to_rgba8(), out_data, out_size, w_out, h_out, c_out)
    })
}

/// Kept for symbol parity — the Rust port never hands out heap allocations,
/// so there is nothing to free.
#[no_mangle]
pub unsafe extern "C" fn image_shim_free(_ptr: *mut c_uchar) {}

#[no_mangle]
pub unsafe extern "C" fn image_shim_info(
    data: *const c_uchar,
    size: c_int,
    w_out: *mut c_int,
    h_out: *mut c_int,
    c_out: *mut c_int,
) -> c_int {
    ffi!(ERR_DECODE, {
        if data.is_null() || size <= 0 {
            return ERR_DECODE;
        }
        let bytes = std::slice::from_raw_parts(data, size as usize);
        let reader = match image::ImageReader::new(Cursor::new(bytes)).with_guessed_format() {
            Ok(r) => r,
            Err(_) => return ERR_DECODE,
        };
        let dec = match reader.into_decoder() {
            Ok(d) => d,
            Err(_) => return ERR_DECODE,
        };
        let (w, h) = dec.dimensions();
        write_out(w_out, w as c_int);
        write_out(h_out, h as c_int);
        write_out(c_out, dec.color_type().channel_count() as c_int);
        OK
    })
}
