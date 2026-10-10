// Copyright 2026 the Vello Authors and the Parley Authors
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! FreeType-backed glyph mask rasterization (DownDraft patch).
//!
//! Rasterizes hinted glyph coverage masks with the real FreeType engine
//! instead of walking skrifa outlines through vello_cpu's coverage AA.
//! FreeType's TrueType interpreter executes both X and Y instructions and
//! produces the same stems Chrome does on Linux. Masks are uploaded into the
//! same atlas slots the outline path uses, so compositing (AlphaMask tinting,
//! subpixel-phase cache buckets) is shared.
//!
//! With `DD_LCD_TEXT=1` (opt-in), glyphs render as LCD subpixel masks
//! (`FT_RENDER_MODE_LCD`, 3x horizontal coverage) and composite through a
//! two-pass multiply+add blend for true per-channel subpixel AA. LCD output
//! is only correct when the raster lands unscaled on an RGB-subpixel-ordered
//! panel — any resample, BGR panel, or semi-transparent destination smears
//! it into color fringes, so grayscale masks are the default.
//!
//! Runtime toggles: `DD_FREETYPE_TEXT=0` disables this module entirely,
//! `DD_LCD_TEXT=1` enables the LCD variant (grayscale masks are default).

use alloc::sync::Arc;
use alloc::vec::Vec;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use freetype_sys as ft;

use crate::Pixmap;
use crate::atlas::RasterMetrics;
use crate::peniko::FontData;
use crate::peniko::color::PremulRgba8;

/// A glyph mask produced by FreeType.
pub(crate) enum FtMask {
    /// Glyph has no ink (space, zero-width marks, etc.) — render nothing.
    Empty,
    /// Coverage mask ready to upload into an atlas slot.
    Mask {
        /// Premultiplied RGBA8 coverage (alpha channel is what AlphaMask uses).
        pixmap: Arc<Pixmap>,
        /// Atlas metrics in the same convention the outline path produces:
        /// `bearing_y` is the (negative) top edge in glyph space.
        metrics: RasterMetrics,
    },
    /// Pair of RGB subpixel masks for LCD compositing:
    /// `mask` has (r,g,b) = subpixel coverage, `inv` has (r,g,b) = 255-coverage.
    /// Both use `a = max(r,g,b)` so blended fills respect coverage.
    Lcd {
        /// `mask.rgb` = per-subpixel coverage.
        mask: Arc<Pixmap>,
        /// `inv.rgb` = 1 - coverage (for the Multiply pass).
        inv: Arc<Pixmap>,
        /// Metrics in whole pixels (the LCD bitmap is 3x wider internally).
        metrics: RasterMetrics,
    },
}

impl core::fmt::Debug for FtMask {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Empty => f.write_str("FtMask::Empty"),
            Self::Mask { metrics, .. } => f
                .debug_struct("FtMask::Mask")
                .field("metrics", metrics)
                .finish_non_exhaustive(),
            Self::Lcd { metrics, .. } => f
                .debug_struct("FtMask::Lcd")
                .field("metrics", metrics)
                .finish_non_exhaustive(),
        }
    }
}

/// A live FreeType face plus the font blob that backs its memory region.
struct FtFaceEntry {
    face: ft::FT_Face,
    /// Keep the blob alive — `FT_New_Memory_Face` borrows the bytes.
    _font: FontData,
    /// Pixel size the face is currently configured for, in 26.6 fixed point.
    size64: u32,
}

impl Drop for FtFaceEntry {
    fn drop(&mut self) {
        unsafe { ft::FT_Done_Face(self.face) };
    }
}

// SAFETY: FT_Face handles are only ever used inside `rasterize`, which holds
// the `FACES` mutex for the whole call, and the entry Drop runs under the same
// mutex via HashMap drop.
unsafe impl Send for FtFaceEntry {}

/// Newtype wrapper so the raw library handle can live in a `static`.
#[derive(Clone, Copy)]
struct FtLib(ft::FT_Library);
// SAFETY: the library pointer is only dereferenced inside `rasterize`, which
// serializes all FT calls through the `FACES` mutex.
unsafe impl Send for FtLib {}
unsafe impl Sync for FtLib {}

static FT_LIB: OnceLock<Option<FtLib>> = OnceLock::new();
static FACES: Mutex<Option<HashMap<u64, FtFaceEntry>>> = Mutex::new(None);
static ENABLED: OnceLock<bool> = OnceLock::new();
static LCD_ENABLED: OnceLock<bool> = OnceLock::new();

fn library() -> Option<ft::FT_Library> {
    FT_LIB
        .get_or_init(|| unsafe {
            let mut lib = core::ptr::null_mut();
            if ft::FT_Init_FreeType(&mut lib) != 0 {
                return None;
            }
            // FT's LCD filter is off unless explicitly requested — without it
            // FT_RENDER_MODE_LCD emits raw per-subpixel coverage, which shows
            // as saturated red/blue fringes. FT_LCD_FILTER_DEFAULT is the
            // 5-tap FIR Chrome uses (it lands coverage equally on neighbouring
            // subpixels, muting the colour error at the cost of slight blur).
            ft::FT_Library_SetLcdFilter(lib, ft::FT_LCD_FILTER_DEFAULT);
            Some(FtLib(lib))
        })
        .map(|l| l.0)
}

/// Whether the FreeType path should be used for hinted text glyphs.
pub(crate) fn enabled() -> bool {
    *ENABLED.get_or_init(|| {
        let on = match std::env::var("DD_FREETYPE_TEXT") {
            Ok(v) => !matches!(v.as_str(), "0" | "false" | "off"),
            Err(_) => true,
        };
        if on && library().is_none() {
            log::warn!("DD_FREETYPE_TEXT enabled but FT_Init_FreeType failed");
            return false;
        }
        on
    })
}

/// Whether LCD subpixel masks should be produced (implies [`enabled`]).
///
/// Opt-in only: `DD_LCD_TEXT=1`. Auto-detection (fontconfig `rgba`, the
/// signal Chrome follows) was considered but is an incomplete path —
/// fontconfig reports a global preference, not the subpixel order of the
/// monitor the window is actually on; we also can't prove the composited
/// texture lands 1:1 (zoom/scale/fractional offsets scramble the subpixel
/// phases) or that the doc dst is opaque (the two-pass blend is wrong over
/// transparency). Until all three are verifiable per-surface, grayscale
/// masks are the only safe default.
pub(crate) fn lcd_enabled() -> bool {
    enabled()
        && *LCD_ENABLED.get_or_init(|| match std::env::var("DD_LCD_TEXT") {
            Ok(v) => matches!(v.as_str(), "1" | "true" | "on"),
            Err(_) => false,
        })
}

/// A rendered FreeType bitmap copied out of the glyph slot, normalized to
/// plain row-major top-to-bottom bytes.
struct FtBitmap {
    /// 8-bit samples; `width` is the byte count per row (subpixels for LCD).
    width: usize,
    rows: usize,
    /// Row-major bytes, `width * rows` — owned so it outlives the `FACES`
    /// lock (a concurrent `FT_Load_Glyph` would invalidate the slot buffer).
    data: Vec<u8>,
    /// `FT_PIXEL_MODE_*` of the rendered bitmap.
    pixel_mode: u8,
    /// Left bearing in whole pixels.
    left: i32,
    /// Top bearing in whole pixels (distance from baseline to top edge).
    top: i32,
}

/// Load and render `glyph_id` in `font` at `ppem` with horizontal subpixel
/// `x_phase`, returning the rendered bitmap view. `load_flags` selects the
/// hinting target (e.g. `FT_LOAD_TARGET_LCD`) and `render_mode` the output
/// format. Returns `None` on any FreeType failure.
fn render_bitmap(
    font: &FontData,
    glyph_id: u32,
    ppem: f32,
    x_phase: f32,
    load_flags: i32,
    render_mode: ft::FT_Render_Mode,
) -> Option<FtBitmap> {
    if !(0.5..=4096.0).contains(&ppem) {
        return None;
    }
    let lib = library()?;
    let mut faces = FACES.lock().ok()?;
    let map = faces.get_or_insert_with(HashMap::new);
    let key = font.data.id();

    if !map.contains_key(&key) {
        let bytes: &[u8] = font.data.as_ref();
        let mut face = core::ptr::null_mut();
        let err = unsafe {
            ft::FT_New_Memory_Face(
                lib,
                bytes.as_ptr(),
                bytes.len() as ft::FT_Long,
                font.index as ft::FT_Long,
                &mut face,
            )
        };
        if err != 0 || face.is_null() {
            log::warn!("FT_New_Memory_Face failed (err={err}) for font {key:#x}");
            return None;
        }
        // Only scalable fonts go through this path — bitmap strikes are
        // already handled by the COLR/bitmap cascade upstream.
        let scalable = unsafe { (*face).face_flags } & ft::FT_FACE_FLAG_SCALABLE != 0;
        if !scalable {
            unsafe { ft::FT_Done_Face(face) };
            return None;
        }
        map.insert(
            key,
            FtFaceEntry {
                face,
                _font: font.clone(),
                size64: 0,
            },
        );
    }

    let entry = map.get_mut(&key)?;
    let face = entry.face;
    // FT_Set_Char_Size takes 26.6 fixed point — unlike FT_Set_Pixel_Sizes it
    // preserves fractional sizes (e.g. a 15px font at 1.25 zoom is 18.75px).
    let size64 = (ppem * 64.0).round().max(64.0) as u32;
    if entry.size64 != size64 {
        if unsafe { ft::FT_Set_Char_Size(face, 0, size64 as ft::FT_F26Dot6, 72, 72) } != 0 {
            return None;
        }
        entry.size64 = size64;
    }

    // Subpixel x placement: shift the outline by the quantized phase before
    // rasterization (this is what Skia does — each phase gets its own mask).
    let mut delta = ft::FT_Vector {
        x: (x_phase * 64.0) as ft::FT_Pos,
        y: 0,
    };
    unsafe { ft::FT_Set_Transform(face, core::ptr::null_mut(), &mut delta) };

    let ok = unsafe { ft::FT_Load_Glyph(face, glyph_id, load_flags) == 0 } && {
        let slot = unsafe { (*face).glyph };
        !slot.is_null() && unsafe { ft::FT_Render_Glyph(slot, render_mode) } == 0
    };
    // Reset the translation so the face can be reused at other phases.
    let mut zero = ft::FT_Vector { x: 0, y: 0 };
    unsafe { ft::FT_Set_Transform(face, core::ptr::null_mut(), &mut zero) };
    if !ok {
        return None;
    }

    let slot = unsafe { (*face).glyph };
    let (width, rows, pitch, buffer, pixel_mode, left, top) = unsafe {
        let b = &(*slot).bitmap;
        (
            b.width as usize,
            b.rows as usize,
            b.pitch,
            b.buffer,
            b.pixel_mode,
            (*slot).bitmap_left,
            (*slot).bitmap_top,
        )
    };

    if width == 0 || rows == 0 {
        return Some(FtBitmap {
            width: 0,
            rows: 0,
            data: Vec::new(),
            pixel_mode: 0,
            left,
            top,
        });
    }
    if width > u16::MAX as usize || rows > u16::MAX as usize || buffer.is_null() {
        return None;
    }

    // Copy out of the glyph slot while the lock is still held — the buffer is
    // invalidated by the next FT_Load_Glyph on this face.
    let mut data = Vec::with_capacity(width * rows);
    for y in 0..rows {
        // FT pitch is signed — `buffer` always points at the top row and
        // advancing by `pitch` (possibly negative) reaches the next row.
        let row = unsafe { buffer.offset(y as isize * pitch as isize) };
        unsafe {
            data.extend_from_slice(core::slice::from_raw_parts(row, width));
        }
    }

    Some(FtBitmap {
        width,
        rows,
        data,
        pixel_mode: pixel_mode as u8,
        left,
        top,
    })
}

/// Rasterize a grayscale coverage mask.
pub(crate) fn rasterize(font: &FontData, glyph_id: u32, ppem: f32, x_phase: f32) -> Option<FtMask> {
    // FT_LOAD_DEFAULT applies the font's bytecode at TARGET_NORMAL (grayscale);
    // NO_BITMAP keeps embedded strikes out so coverage stays hint-driven.
    let bmp = render_bitmap(
        font,
        glyph_id,
        ppem,
        x_phase,
        ft::FT_LOAD_DEFAULT | ft::FT_LOAD_NO_BITMAP,
        ft::FT_RENDER_MODE_NORMAL,
    )?;
    if bmp.width == 0 || bmp.rows == 0 {
        return Some(FtMask::Empty);
    }
    // Only the 8-bit grayscale mode maps onto our coverage-mask convention.
    if bmp.pixel_mode != ft::FT_PIXEL_MODE_GRAY as u8 {
        return None;
    }

    let mut px: Vec<PremulRgba8> = Vec::with_capacity(bmp.width * bmp.rows);
    for &v in &bmp.data {
        px.push(PremulRgba8 {
            r: v,
            g: v,
            b: v,
            a: v,
        });
    }
    let pixmap = Arc::new(Pixmap::from_parts(px, bmp.width as u16, bmp.rows as u16));

    Some(FtMask::Mask {
        pixmap,
        metrics: RasterMetrics {
            width: bmp.width as u16,
            height: bmp.rows as u16,
            bearing_x: bmp.left as i16,
            bearing_y: (-bmp.top) as i16,
        },
    })
}

/// Rasterize an LCD subpixel mask pair (mask + inverse) for two-pass
/// per-channel compositing.
///
/// FreeType renders `width = 3 * cols` gray bytes per row (each byte one
/// subpixel); we repack every triplet into one RGBA pixel so downstream
/// sampling sees one whole pixel per display column. The default LCD filter
/// may add one padding column on each side — `bitmap_left` already accounts
/// for it, so metrics/bearings stay in whole pixels.
pub(crate) fn rasterize_lcd(
    font: &FontData,
    glyph_id: u32,
    ppem: f32,
    x_phase: f32,
) -> Option<FtMask> {
    let bmp = render_bitmap(
        font,
        glyph_id,
        ppem,
        x_phase,
        ft::FT_LOAD_TARGET_LCD | ft::FT_LOAD_NO_BITMAP,
        ft::FT_RENDER_MODE_LCD,
    )?;
    if bmp.width == 0 || bmp.rows == 0 {
        return Some(FtMask::Empty);
    }
    if bmp.pixel_mode != ft::FT_PIXEL_MODE_LCD as u8 || bmp.width % 3 != 0 {
        return None;
    }
    let cols = bmp.width / 3;

    let mut mask_px: Vec<PremulRgba8> = Vec::with_capacity(cols * bmp.rows);
    let mut inv_px: Vec<PremulRgba8> = Vec::with_capacity(cols * bmp.rows);
    for row in bmp.data.chunks_exact(bmp.width) {
        for triple in row.chunks_exact(3) {
            let (r, g, b) = (triple[0], triple[1], triple[2]);
            let a = r.max(g).max(b);
            mask_px.push(PremulRgba8 { r, g, b, a });
            inv_px.push(PremulRgba8 {
                r: 255 - r,
                g: 255 - g,
                b: 255 - b,
                a,
            });
        }
    }
    let mask = Arc::new(Pixmap::from_parts(mask_px, cols as u16, bmp.rows as u16));
    let inv = Arc::new(Pixmap::from_parts(inv_px, cols as u16, bmp.rows as u16));

    Some(FtMask::Lcd {
        mask,
        inv,
        metrics: RasterMetrics {
            width: cols as u16,
            height: bmp.rows as u16,
            bearing_x: bmp.left as i16,
            bearing_y: (-bmp.top) as i16,
        },
    })
}
