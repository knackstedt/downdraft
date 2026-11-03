//! Vello GPU rasterization on the shared device — the html-ui OSR worker
//! encodes a `vello::Scene` inside its own cdylib (which statically links
//! no wgpu of its own and therefore can't hold a Device minted here — each
//! cdylib's wgpu keeps a private handle registry) and hands the resulting
//! `vello_encoding::Encoding` over as a raw pointer. We append it into a
//! fresh Scene — `Encoding::append` fixes up every internal index and
//! clones Arc'd font/image resources, which is exactly what makes the
//! encoding a viable cross-ABI transport — and shade it into a host-owned
//! texture with a per-device cached `vello::Renderer`.
//!
//! ABI: `enc` is an `*const vello_encoding::Encoding` produced by
//! `dd_osr_frame_vello` in libdowndraft_blitz_osr. `abi` carries
//! `size_of<<8 | align_of` computed on that side and is checked against
//! ours before the pointer is dereferenced — a mismatch means the two
//! cdylibs resolved different vello_encoding versions/features and the
//! caller must fall back to the CPU raster path. Both sides pin 0.11.

use super::*;
use std::num::NonZeroUsize;
use std::sync::Arc;
use ::vello::peniko::Color;
use ::vello::{AaConfig, AaSupport, RenderParams, Renderer, RendererOptions};

/// One `vello::Renderer` per live ShimDevice handle. Renderers compile ~40
/// pipelines at construction, so they are built lazily on first use and
/// cached for the device's lifetime (dropped by wgpu_shim_release_device).
/// Arc<Mutex> lets the render call run outside the map lock.
static VELLO_RENDERERS: LazyLock<Mutex<HashMap<usize, Arc<Mutex<Renderer>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(crate) fn release_renderer_for(device: usize) {
    VELLO_RENDERERS.lock().unwrap().remove(&device);
}

/// Render an encoded vello scene into `texture`.
///
/// `device`  — ShimDevice handle (shared-device ptr; both queue and device
///             come out of it).
/// `texture` — a texture handle with STORAGE_BINDING usage (vello's fine
///             raster stage writes the target via a storage binding).
/// `enc`     — *const vello_encoding::Encoding from dd_osr_frame_vello.
/// `abi`     — the producer's dd_osr_vello_enc_abi() value.
/// `base_rgba` — packed RGBA8 clear color (little-endian byte order).
///
/// Returns 0 on success, -2 on ABI/argument mismatch (permanent — the JS
/// side should disable GPU raster for the session), -3 when renderer init
/// failed, -4 when the render itself failed.
#[no_mangle]
pub extern "C" fn wgpu_shim_vello_render(
    device: Handle,
    texture: Handle,
    enc: Handle,
    abi: u64,
    width: u32,
    height: u32,
    base_rgba: u32,
) -> i32 {
    ffi!(-1, unsafe {
        // ABI handshake: the pointer is an Encoding only if both cdylibs
        // agree on its layout.
        let mine = (std::mem::size_of::<vello_encoding::Encoding>() as u64) << 8
            | (std::mem::align_of::<vello_encoding::Encoding>() as u64);
        if enc.is_null() || abi != mine {
            return -2;
        }
        if !device_is_live(device) || texture.is_null() || width == 0 || height == 0 {
            return -1;
        }
        let sd = obj::<ShimDevice>(device);
        let dev_key = device as usize;
        let renderer = {
            let mut reg = VELLO_RENDERERS.lock().unwrap();
            match reg.get(&dev_key) {
                Some(r) => Arc::clone(r),
                None => {
                    let r = match Renderer::new(
                        &sd.device,
                        RendererOptions {
                            use_cpu: false,
                            // Area AA only — the panel quads get no benefit
                            // from the MSAA pipeline permutations, and
                            // skipping them halves vello's shader-compile cost.
                            antialiasing_support: AaSupport::area_only(),
                            // One init thread: docs raster on their worker
                            // thread already, and wgpu device submissions on
                            // this device serialize anyway.
                            num_init_threads: NonZeroUsize::new(1),
                            // Reuse the host's persistent pipeline cache when
                            // attached — vello's shader set then survives
                            // restarts like every other pipeline.
                            pipeline_cache: sd.pipeline_cache.lock().unwrap().clone(),
                        },
                    ) {
                        Ok(r) => Arc::new(Mutex::new(r)),
                        Err(e) => {
                            eprintln!("[wgpu_shim] vello renderer init failed: {e:?}");
                            return -3;
                        }
                    };
                    reg.insert(dev_key, Arc::clone(&r));
                    r
                }
            }
        };
        let mut scene = ::vello::Scene::new();
        // SAFETY: abi checked above — the caller's Encoding layout is ours.
        // The pointer must stay valid for this synchronous call (the OSR
        // side retains it until the doc's next dd_osr_frame_vello).
        scene
            .encoding_mut()
            .append(&*(enc as *const vello_encoding::Encoding), &None);
        let view = obj::<Texture>(texture).create_view(&TextureViewDescriptor::default());
        let [r, g, b, a] = base_rgba.to_le_bytes();
        let mut guard = renderer.lock().unwrap();
        match guard.render_to_texture(
            &sd.device,
            &sd.queue,
            &scene,
            &view,
            &RenderParams {
                base_color: Color::from_rgba8(r, g, b, a),
                width,
                height,
                antialiasing_method: AaConfig::Area,
            },
        ) {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("[wgpu_shim] vello render failed: {e:?}");
                -4
            }
        }
    })
}
