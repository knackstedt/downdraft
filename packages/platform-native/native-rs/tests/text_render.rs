//! text_render.rs — ft_shim_render_text regression tests.
//!
//! Regression: ft_shim_init previously used FontSystem::new_with_fonts, which
//! ALSO loads every system font — and then picked db().faces().next() as the
//! shaping family. With e.g. MathJax installed, that resolves to a symbol font
//! whose capitals are double-struck/outlined glyphs, so uppercase text
//! rendered hollow while lowercase fell back to a normal face.
//! The shim must load ONLY the requested font file.

use downdraft_platform::text::{ft_shim_done, ft_shim_init, ft_shim_render_text};
use std::ffi::CString;
use std::os::raw::c_int;

const FONT_PATHS: &[&str] = &[
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "C:\\Windows\\Fonts\\arial.ttf",
];

fn render(handle: i64, text: &str, size: i32) -> Option<(Vec<u8>, i32, i32)> {
    let mut buf = vec![0u8; 2048 * 128 * 4];
    let mut w: c_int = 0;
    let mut h: c_int = 0;
    let ctext = CString::new(text).unwrap();
    let n = unsafe {
        ft_shim_render_text(
            handle,
            ctext.as_ptr(),
            size,
            buf.as_mut_ptr(),
            buf.len() as c_int,
            2048,
            128,
            &mut w,
            &mut h,
        )
    };
    if n <= 0 || w <= 0 || h <= 0 {
        return None;
    }
    buf.truncate((w * h * 4) as usize);
    Some((buf, w, h))
}

#[test]
fn capitals_render_filled_not_outlined() {
    let Some(path) = FONT_PATHS.iter().find(|p| std::path::Path::new(p).exists()) else {
        eprintln!("skip: no system TTF available");
        return;
    };
    let cpath = CString::new(*path).unwrap();
    let handle = unsafe { ft_shim_init(cpath.as_ptr()) };
    assert!(handle != 0, "ft_shim_init failed for {path}");

    // A solid capital in a normal sans face fills ~40%+ of its tight ink box;
    // the hollow double-struck glyphs this regression produced fill under 25%.
    // (Measure within the ink box — the buffer is a full line height tall, so
    // raw coverage is diluted by leading space.)
    let (data, w, h) = render(handle, "F", 32).expect("render F");
    let alpha_at = |x: i32, y: i32| data[(y * w + x) as usize * 4 + 3];
    let mut ink = 0usize;
    let mut min_x = w;
    let mut max_x = 0;
    let mut min_y = h;
    let mut max_y = 0;
    for y in 0..h {
        for x in 0..w {
            if alpha_at(x, y) > 160 {
                ink += 1;
                min_x = min_x.min(x);
                max_x = max_x.max(x);
                min_y = min_y.min(y);
                max_y = max_y.max(y);
            }
        }
    }
    let box_area = ((max_x - min_x + 1) * (max_y - min_y + 1)) as f32;
    let fill = ink as f32 / box_area;
    unsafe { ft_shim_done(handle) };
    assert!(
        fill > 0.30,
        "capital F rendered mostly hollow (fill={fill:.2}) — wrong face selected?"
    );
}
