//! text.rs — ft_shim_* exports (cosmic-text port of font_shim.c / SDL2_ttf).
//!
//! Wire contract (must match src/image/native-freetype.ts):
//!   ft_shim_init(font_path)        → i64 font handle (0 on failure)
//!   ft_shim_render_text(font, text, size, out, out_size, max_w, max_h, w_out, h_out)
//!                                  → i32 bytes written (0 on failure / empty)
//!     out = premultiplied coverage RGBA — every texel is (cov,cov,cov,cov);
//!     callers composite color themselves. Dimensions clamp to max_w/max_h
//!     (clip, same as the C shim). On failure w_out/h_out are set to 0.
//!   ft_shim_measure(font, text, size) → i32 advance width in pixels
//!   ft_shim_done(font)             → frees the handle
//!
//! Each handle owns a FontSystem loaded with *only* the requested font file —
//! matching TTF_OpenFont semantics (no system-font fallback).

use cosmic_text::fontdb;
use cosmic_text::{Attrs, Buffer, Color, Family, FontSystem, Metrics, Shaping, SwashCache, Wrap};
use std::ffi::CStr;
use std::os::raw::{c_char, c_int, c_uchar};
use std::ptr;
use std::sync::Arc;

struct TextRenderer {
    fs: FontSystem,
    swash: SwashCache,
    /// Family name of the loaded face — set in Attrs so shaping picks it.
    family: String,
}

const LINE_HEIGHT_SCALE: f32 = 1.2;

unsafe fn write_out(p: *mut c_int, v: c_int) {
    if !p.is_null() {
        *p = v;
    }
}

/// Shape the text with the handle's font, returning (advance_width, Buffer).
fn shape(r: &mut TextRenderer, text: &str, size: f32) -> Buffer {
    let metrics = Metrics::new(size, size * LINE_HEIGHT_SCALE);
    let mut buf = Buffer::new(&mut r.fs, metrics);
    let attrs = Attrs::new().family(Family::Name(&r.family));
    buf.set_wrap(&mut r.fs, Wrap::None);
    buf.set_size(&mut r.fs, Some(f32::MAX), Some(size * LINE_HEIGHT_SCALE));
    buf.set_text(&mut r.fs, text, &attrs, Shaping::Advanced);
    buf
}

#[no_mangle]
pub unsafe extern "C" fn ft_shim_init(font_path: *const c_char) -> i64 {
    crate::ffi!(0i64, {
        if font_path.is_null() {
            return 0;
        }
        let path = CStr::from_ptr(font_path).to_string_lossy();
        let data = match std::fs::read(path.as_ref()) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("[downdraft_platform] ft_shim_init: cannot read {path}: {e}");
                return 0;
            }
        };
        // Load ONLY the requested file — FontSystem::new_with_fonts also pulls
        // in every system font, and picking faces().next() from that db resolves
        // to an arbitrary installed face (e.g. MathJax symbol fonts whose
        // capitals are double-struck glyphs).
        let mut db = fontdb::Database::new();
        let ids = db.load_font_source(fontdb::Source::Binary(Arc::new(data)));
        let family = ids
            .first()
            .and_then(|id| db.face(*id))
            .and_then(|f| f.families.first())
            .map(|(name, _)| name.clone())
            .unwrap_or_else(|| "sans-serif".to_string());
        if ids.is_empty() {
            eprintln!("[downdraft_platform] ft_shim_init: no usable face in {path}");
            return 0;
        }
        let locale = std::env::var("LANG")
            .ok()
            .and_then(|l| l.split('.').next().map(str::to_string))
            .filter(|l| !l.is_empty())
            .unwrap_or_else(|| "en-US".to_string());
        let fs = FontSystem::new_with_locale_and_db(locale, db);
        Box::into_raw(Box::new(TextRenderer {
            fs,
            swash: SwashCache::new(),
            family,
        })) as i64
    })
}

#[no_mangle]
pub unsafe extern "C" fn ft_shim_render_text(
    font_ptr: i64,
    text: *const c_char,
    font_size: c_int,
    out_data: *mut c_uchar,
    out_size: c_int,
    max_width: c_int,
    max_height: c_int,
    width_out: *mut c_int,
    height_out: *mut c_int,
) -> c_int {
    crate::ffi!(0, {
        write_out(width_out, 0);
        write_out(height_out, 0);
        if font_ptr == 0 || text.is_null() || out_data.is_null() {
            return 0;
        }
        let r = &mut *(font_ptr as *mut TextRenderer);
        let text = CStr::from_ptr(text).to_string_lossy();
        if text.is_empty() {
            return 0;
        }
        let size = font_size.max(1) as f32;
        let buf = shape(r, &text, size);

        // Emit h = line height (≈ TTF_FontHeight), w = advance width — same
        // contract as TTF_RenderUTF8_Blended + the C clamp to max dims.
        let mut advance: f32 = 0.0;
        for run in buf.layout_runs() {
            advance = advance.max(run.line_w);
        }
        let w = (advance.ceil() as c_int).max(0).min(max_width);
        let h = ((size * LINE_HEIGHT_SCALE).ceil() as c_int)
            .max(0)
            .min(max_height);
        if w <= 0 || h <= 0 {
            return 0;
        }
        let buf_size = (w * h * 4) as usize;
        if out_size < 0 || (out_size as usize) < buf_size {
            return 0;
        }
        ptr::write_bytes(out_data, 0, buf_size);
        let out = std::slice::from_raw_parts_mut(out_data, buf_size);
        let stride = (w * 4) as usize;

        // White text — draw callback gives (x, y, w, h, color) pixel runs
        // where color's alpha is coverage. Write premultiplied (cov×4).
        buf.draw(
            &mut r.fs,
            &mut r.swash,
            Color::rgb(255, 255, 255),
            |x, y, rw, rh, color| {
                let a = color.a() as i32;
                if a <= 0 {
                    return;
                }
                let cov = a.min(255) as u8;
                let y0 = y.max(0);
                let y1 = (y + rh as i32).min(h);
                let x0 = x.max(0);
                let x1 = (x + rw as i32).min(w);
                for py in y0..y1 {
                    let row = py as usize * stride;
                    for px in x0..x1 {
                        let o = row + px as usize * 4;
                        out[o] = cov;
                        out[o + 1] = cov;
                        out[o + 2] = cov;
                        out[o + 3] = cov;
                    }
                }
            },
        );

        write_out(width_out, w);
        write_out(height_out, h);
        buf_size as c_int
    })
}

#[no_mangle]
pub unsafe extern "C" fn ft_shim_measure(
    font_ptr: i64,
    text: *const c_char,
    font_size: c_int,
) -> c_int {
    crate::ffi!(0, {
        if font_ptr == 0 || text.is_null() {
            return 0;
        }
        let r = &mut *(font_ptr as *mut TextRenderer);
        let text = CStr::from_ptr(text).to_string_lossy();
        if text.is_empty() {
            return 0;
        }
        let size = font_size.max(1) as f32;
        let buf = shape(r, &text, size);
        let mut advance: f32 = 0.0;
        for run in buf.layout_runs() {
            advance = advance.max(run.line_w);
        }
        advance.ceil() as c_int
    })
}

#[no_mangle]
pub unsafe extern "C" fn ft_shim_done(font_ptr: i64) {
    if font_ptr != 0 {
        drop(Box::from_raw(font_ptr as *mut TextRenderer));
    }
}
