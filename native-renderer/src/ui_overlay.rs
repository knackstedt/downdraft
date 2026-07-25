use ul_next::{
    config::ConfigBuilder,
    platform,
    renderer::Renderer,
    view::{View, ViewConfig},
    Library,
};

pub struct UIOverlay {
    _lib: std::sync::Arc<Library>,
    renderer: Renderer,
    view: View,
    width: u32,
    height: u32,
    last_pixels: Option<(Vec<u8>, u32, u32)>,
}

impl UIOverlay {
    pub fn new(width: u32, height: u32) -> Result<Self, String> {
        // Load Ultralight library with AppCore (needed for fontloader)
        let lib = unsafe {
            Library::load_with_appcore().map_err(|e| format!("Failed to load Ultralight: {:?}", e))?
        };

        // Enable platform filesystem and font loader
        platform::enable_platform_filesystem(lib.clone(), ".")
            .map_err(|e| format!("Failed to enable filesystem: {:?}", e))?;
        platform::enable_platform_fontloader(lib.clone());

        // Create config — CPU renderer, bitmap aligned to 4 bytes
        let config = ConfigBuilder::default()
            .bitmap_alignment(4)
            .build(lib.clone())
            .ok_or("Failed to build Ultralight config")?;

        let renderer = Renderer::create(config)
            .map_err(|e| format!("Failed to create Ultralight renderer: {:?}", e))?;

        let view_config = ViewConfig::start()
            .is_transparent(true)
            .initial_device_scale(1.0)
            .build(lib.clone())
            .ok_or("Failed to build ViewConfig")?;
        let view = renderer
            .create_view(width, height, &view_config, None)
            .ok_or("Failed to create Ultralight view")?;

        // Load the UI HTML
        let html = include_str!("ui.html");
        view.load_html(html)
            .map_err(|e| format!("Failed to load HTML: {:?}", e))?;

        println!("[ui] Ultralight UI overlay initialized ({}x{})", width, height);

        Ok(Self {
            _lib: lib,
            renderer,
            view,
            width,
            height,
            last_pixels: None,
        })
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        if width > 0 && height > 0 && (width != self.width || height != self.height) {
            self.width = width;
            self.height = height;
            self.view.resize(width, height);
        }
    }

    /// Update and render the UI. Returns (pixels, row_bytes, height) if content is available.
    pub fn render(&mut self) -> Option<(Vec<u8>, u32, u32)> {
        self.renderer.update();

        if self.view.needs_paint() {
            self.renderer.render();

            if let Some(mut surface) = self.view.surface() {
                let dirty = surface.dirty_bounds();
                if !dirty.is_empty() {
                    let row_bytes = surface.row_bytes();
                    let surf_height = surface.height();
                    let expected_row_bytes = self.width * 4;

                    let pixels_opt = {
                        if let Some(guard) = surface.lock_pixels() {
                            Some(guard.to_vec())
                        } else {
                            None
                        }
                    };
                    if let Some(raw_pixels) = pixels_opt {
                        surface.clear_dirty_bounds();

                        let pixels = if row_bytes == expected_row_bytes && surf_height == self.height {
                            raw_pixels
                        } else {
                            let mut packed = vec![0u8; (self.width * self.height * 4) as usize];
                            let copy_rows = surf_height.min(self.height);
                            for y in 0..copy_rows {
                                let src_offset = (y * row_bytes) as usize;
                                let dst_offset = (y * expected_row_bytes) as usize;
                                let copy_len = expected_row_bytes as usize;
                                if src_offset + copy_len <= raw_pixels.len() && dst_offset + copy_len <= packed.len() {
                                    packed[dst_offset..dst_offset + copy_len]
                                        .copy_from_slice(&raw_pixels[src_offset..src_offset + copy_len]);
                                }
                            }
                            packed
                        };

                        self.last_pixels = Some((pixels, expected_row_bytes, self.height));
                    }
                }
            }
        }

        self.last_pixels.clone()
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn update_fps(&self, fps: u32) {
        let script = format!(
            "var el = document.getElementById('fps-counter'); if (el) el.textContent = 'FPS: {}';",
            fps
        );
        let _ = self.view.evaluate_script(&script);
    }
}
