//! Font setup. WASM has no system font collection, so we embed DejaVu Sans
//! via blitz-dom's `build_single_font_ctx` (decodes WOFF2 and registers it as
//! the fallback for every generic family), plus blitz-dom's bullet font.
//! Games can override via `ShellConfig::font`.

use std::sync::Arc;

use blitz_dom::FontContext;
use linebender_resource_handle::Blob;

const FONT_BYTES: &[u8] = include_bytes!("../assets/DejaVuSans.woff2");

pub fn font_ctx(custom: Option<&'static [u8]>) -> FontContext {
    let mut ctx = blitz_dom::build_single_font_ctx(custom.unwrap_or(FONT_BYTES));
    // blitz-dom's default font_ctx also registers the bullet font used for
    // list markers; keep parity since we replace the default ctx entirely.
    ctx.collection
        .register_fonts(Blob::new(Arc::new(blitz_dom::BULLET_FONT) as _), None);
    ctx
}
