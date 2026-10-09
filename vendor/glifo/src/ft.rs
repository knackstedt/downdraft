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
//! Enabled at runtime by default when the `freetype` cargo feature is on;
//! set `DD_FREETYPE_TEXT=0` to disable.

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
}

impl core::fmt::Debug for FtMask {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Empty => f.write_str("FtMask::Empty"),
            Self::Mask { metrics, .. } => f
                .debug_struct("FtMask::Mask")
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
    /// Pixel size the face is currently configured for.
    ppem: u32,
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

fn library() -> Option<ft::FT_Library> {
    FT_LIB
        .get_or_init(|| unsafe {
            let mut lib = core::ptr::null_mut();
            (ft::FT_Init_FreeType(&mut lib) == 0).then_some(FtLib(lib))
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

/// Rasterize `glyph_id` from `font` at `ppem` pixels-per-em with a horizontal
/// subpixel phase of `x_phase` (0..1, same quantization the atlas uses).
///
/// Returns `None` when FreeType cannot produce a grayscale mask for this
/// glyph — the caller falls back to the normal outline path.
pub(crate) fn rasterize(
    font: &FontData,
    glyph_id: u32,
    ppem: f32,
    x_phase: f32,
) -> Option<FtMask> {
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
                ppem: 0,
            },
        );
    }

    let entry = map.get_mut(&key)?;
    let face = entry.face;
    let ppem_i = ppem.round().max(1.0) as u32;
    if entry.ppem != ppem_i {
        if unsafe { ft::FT_Set_Pixel_Sizes(face, 0, ppem_i) } != 0 {
            return None;
        }
        entry.ppem = ppem_i;
    }

    // Subpixel x placement: shift the outline by the quantized phase before
    // rasterization (this is what Skia does — each phase gets its own mask).
    let mut delta = ft::FT_Vector {
        x: (x_phase * 64.0) as ft::FT_Pos,
        y: 0,
    };
    unsafe { ft::FT_Set_Transform(face, core::ptr::null_mut(), &mut delta) };

    // FT_LOAD_DEFAULT applies the font's bytecode at TARGET_NORMAL (grayscale).
    let ok = unsafe { ft::FT_Load_Glyph(face, glyph_id, ft::FT_LOAD_DEFAULT) == 0 } && {
        let slot = unsafe { (*face).glyph };
        !slot.is_null()
            && unsafe { ft::FT_Render_Glyph(slot, ft::FT_RENDER_MODE_NORMAL) } == 0
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
        return Some(FtMask::Empty);
    }
    if width > u16::MAX as usize || rows > u16::MAX as usize {
        return None;
    }
    // Only the 8-bit grayscale mode maps onto our coverage-mask convention.
    if pixel_mode != ft::FT_PIXEL_MODE_GRAY as i8 || buffer.is_null() {
        return None;
    }

    let mut px: Vec<PremulRgba8> = Vec::with_capacity(width * rows);
    for y in 0..rows {
        // FT pitch is signed — `buffer` always points at the top row and
        // advancing by `pitch` (possibly negative) reaches the next row.
        let row = unsafe { buffer.offset(y as isize * pitch as isize) };
        for x in 0..width {
            let v = unsafe { *row.add(x) };
            px.push(PremulRgba8 {
                r: v,
                g: v,
                b: v,
                a: v,
            });
        }
    }
    let pixmap = Arc::new(Pixmap::from_parts(px, width as u16, rows as u16));

    Some(FtMask::Mask {
        pixmap,
        metrics: RasterMetrics {
            width: width as u16,
            height: rows as u16,
            bearing_x: left as i16,
            bearing_y: (-top) as i16,
        },
    })
}
