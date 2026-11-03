//! GPU raster path — encode the document into a `vello::Scene` and hand the
//! `Encoding` to the platform library for shading on the shared wgpu device.
//!
//! The OSR cdylib statically links no wgpu of its own: it can't hold a
//! `wgpu::Device` minted inside `libdowndraft_platform` (separate handle
//! registries per cdylib). What CAN cross the boundary is the vello scene
//! encoding — plain data plus Arc'd resources (fonts/images), which the
//! platform side imports via `Encoding::append` and renders with its own
//! `vello::Renderer` on the real device. Both sides pin `vello_encoding
//! 0.11`, so the `Encoding` type resolves identically on each end of the raw
//! pointer; `dd_osr_vello_enc_abi` exports its size/alignment so the platform
//! side can refuse (and the JS side falls back to CPU raster) on any drift.
//!
//! The painter is the anyrender_vello 0.14 `VelloScenePainter` retargeted at
//! `vello 0.11` (identical Scene API), minus the custom-texture resource
//! plumbing the OSR pipeline never uses.

use std::sync::Arc;

use anyrender::{Filter, NormalizedCoord, Paint, PaintRef, PaintScene, RenderContext};
// Named via vello's re-exports so the impl signatures land on the exact
// peniko/kurbo versions vello 0.11 consumes (anyrender's are the same
// crates.io versions — cargo unifies them).
use vello::kurbo::{Affine, Rect, Shape, Stroke};
use vello::peniko::{BlendMode, BrushRef, Color, Fill, FontData, StyleRef};

/// anyrender 0.13 `PaintScene` impl that encodes into a `vello::Scene`.
/// Custom/registered paint resources degrade to transparent — the OSR doc
/// never enables custom widgets, matching the CPU backend.
pub(crate) struct VelloScenePainter<'s> {
    pub inner: &'s mut vello::Scene,
}

impl RenderContext for VelloScenePainter<'_> {}

impl PaintScene for VelloScenePainter<'_> {
    fn reset(&mut self) {
        self.inner.reset();
    }

    fn push_layer(
        &mut self,
        blend: impl Into<BlendMode>,
        alpha: f32,
        transform: Affine,
        clip: &impl Shape,
        _filter: Option<Arc<Filter>>,
        _backdrop_filter: Option<Arc<Filter>>,
    ) {
        self.inner
            .push_layer(Fill::NonZero, blend, alpha, transform, clip);
    }

    fn push_clip_layer(&mut self, transform: Affine, clip: &impl Shape) {
        self.inner.push_clip_layer(Fill::NonZero, transform, clip);
    }

    fn pop_layer(&mut self) {
        self.inner.pop_layer();
    }

    fn stroke<'a>(
        &mut self,
        style: &Stroke,
        transform: Affine,
        paint_ref: impl Into<PaintRef<'a>>,
        brush_transform: Option<Affine>,
        shape: &impl Shape,
    ) {
        let paint_ref: PaintRef<'_> = paint_ref.into();
        let brush_ref: BrushRef<'_> = paint_ref.into();
        self.inner
            .stroke(style, transform, brush_ref, brush_transform, shape);
    }

    fn fill<'a>(
        &mut self,
        style: Fill,
        transform: Affine,
        paint: impl Into<PaintRef<'a>>,
        brush_transform: Option<Affine>,
        shape: &impl Shape,
    ) {
        let paint: PaintRef<'_> = paint.into();
        let brush_ref: BrushRef<'_> = match paint {
            Paint::Solid(color) => BrushRef::Solid(color),
            Paint::Gradient(gradient) => BrushRef::Gradient(gradient),
            Paint::Image(image) => BrushRef::Image(image),
            Paint::Resource(_) | Paint::Custom(_) => BrushRef::Solid(Color::TRANSPARENT),
        };
        self.inner
            .fill(style, transform, brush_ref, brush_transform, shape);
    }

    fn draw_glyphs<'a, 's: 'a>(
        &'a mut self,
        font: &'a FontData,
        font_size: f32,
        hint: bool,
        normalized_coords: &'a [NormalizedCoord],
        embolden: vello::kurbo::Vec2,
        style: impl Into<StyleRef<'a>>,
        paint: impl Into<PaintRef<'a>>,
        brush_alpha: f32,
        transform: Affine,
        glyph_transform: Option<Affine>,
        glyphs: impl Iterator<Item = anyrender::Glyph> + Clone,
    ) {
        self.inner
            .draw_glyphs(font)
            .font_size(font_size)
            .hint(hint)
            .normalized_coords(normalized_coords)
            .font_embolden(vello::FontEmbolden::new(
                vello::kurbo::Diagonal2::new(embolden.x, embolden.y),
            ))
            .brush(paint.into())
            .brush_alpha(brush_alpha)
            .transform(transform)
            .glyph_transform(glyph_transform)
            .draw(
                style,
                glyphs.map(|g: anyrender::Glyph| vello::Glyph {
                    id: g.id,
                    x: g.x,
                    y: g.y,
                }),
            );
    }

    fn draw_box_shadow(
        &mut self,
        transform: Affine,
        rect: Rect,
        brush: Color,
        radius: f64,
        std_dev: f64,
    ) {
        self.inner
            .draw_blurred_rounded_rect(transform, rect, brush, radius, std_dev);
    }
}

/// `size_of<Encoding>() << 8 | align_of<Encoding>()` — the platform side
/// compares this against its own `vello_encoding::Encoding` layout before
/// dereferencing the pointer `dd_osr_frame_vello` hands out.
pub(crate) fn enc_abi() -> u64 {
    (std::mem::size_of::<vello_encoding::Encoding>() as u64) << 8
        | (std::mem::align_of::<vello_encoding::Encoding>() as u64)
}
