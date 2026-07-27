use ul_next::{
    config::ConfigBuilder,
    event::{MouseButton, MouseEvent, MouseEventType, ScrollEvent, ScrollEventType},
    platform,
    renderer::Renderer,
    view::{View, ViewConfig},
    Library,
};

pub struct UIOverlay {
    lib: std::sync::Arc<Library>,
    renderer: Renderer,
    view: View,
    width: u32,
    height: u32,
    last_pixels: Option<(Vec<u8>, u32, u32)>,
    pixels_dirty: bool,
}

#[derive(Clone, Copy, Debug, Default, serde::Deserialize)]
pub struct DebugToggles {
    pub wireframe: bool,
    pub hitboxes: bool,
    pub shadows: bool,
    pub bloom: bool,
    pub aabbs: bool,
    pub normals: bool,
    pub depth: bool,
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
            lib,
            renderer,
            view,
            width,
            height,
            last_pixels: None,
            pixels_dirty: false,
        })
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        if width > 0 && height > 0 && (width != self.width || height != self.height) {
            self.width = width;
            self.height = height;
            self.view.resize(width, height);
        }
    }

    /// Update and render the UI. Returns (pixels, row_bytes, height) only when content has changed.
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
                        self.pixels_dirty = true;
                    }
                }
            }
        }

        if self.pixels_dirty {
            self.pixels_dirty = false;
            self.last_pixels.clone()
        } else {
            None
        }
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

    /// Update the weather indicator overlay with current weather visual params.
    pub fn update_weather(&self, weather_name: &str, sky_r: f32, sky_g: f32, sky_b: f32, fog_density: f32, light_intensity: f32, is_night: bool) {
        let color_hex = format!(
            "#{:02x}{:02x}{:02x}",
            (sky_r * 255.0).clamp(0.0, 255.0) as u8,
            (sky_g * 255.0).clamp(0.0, 255.0) as u8,
            (sky_b * 255.0).clamp(0.0, 255.0) as u8,
        );
        let time_label = if is_night { "Night" } else { "Day" };
        let script = format!(
            "(function() {{ \
               var name = document.getElementById('weather-name'); \
               if (name) name.textContent = '{}'; \
               var sw = document.getElementById('weather-swatch'); \
               if (sw) sw.style.background = '{}'; \
               var det = document.getElementById('weather-detail'); \
               if (det) det.textContent = '{} | Fog: {:.3} | Light: {:.2}'; \
            }})()",
            weather_name, color_hex, time_label, fog_density, light_intensity
        );
        let _ = self.view.evaluate_script(&script);
    }

    /// Check if a screen-space point is over an interactive UI element (for click-through detection).
    pub fn is_point_over_ui(&self, x: i32, y: i32) -> bool {
        let script = format!(
            "(function() {{ var el = document.elementFromPoint({}, {}); \
             if (!el) return 'none'; \
             if (el === document.body || el === document.documentElement) return 'body'; \
             var s = window.getComputedStyle(el); \
             return s.pointerEvents !== 'none' ? el.id + ':' + el.tagName : 'no-pointer:' + el.tagName; }})()",
            x, y
        );
        match self.view.evaluate_script(&script) {
            Ok(Ok(result)) => {
                let trimmed = result.trim();
                trimmed != "none" && trimmed != "body" && !trimmed.starts_with("no-pointer:")
            }
            Ok(Err(_)) => false,
            Err(_) => false,
        }
    }

    /// Forward a mouse button press/release to the Ultralight view so React onClick handlers fire.
    pub fn fire_mouse_event(&self, x: i32, y: i32, button: MouseButton, is_down: bool) {
        let ty = if is_down {
            MouseEventType::MouseDown
        } else {
            MouseEventType::MouseUp
        };
        if let Ok(evt) = MouseEvent::new(self.lib.clone(), ty, x, y, button) {
            self.view.fire_mouse_event(evt);
        }
    }

    /// Forward a mouse move to the Ultralight view for hover effects.
    pub fn fire_mouse_move(&self, x: i32, y: i32) {
        if let Ok(evt) = MouseEvent::new(self.lib.clone(), MouseEventType::MouseMoved, x, y, MouseButton::None) {
            self.view.fire_mouse_event(evt);
        }
    }

    /// Forward a scroll event to the Ultralight view so UI panels can scroll.
    pub fn fire_scroll_event(&self, delta_y: i32) {
        if let Ok(evt) = ScrollEvent::new(self.lib.clone(), ScrollEventType::ScrollByPixel, 0, delta_y) {
            self.view.fire_scroll_event(evt);
        }
    }

    /// Update the status bar with current biome.
    pub fn update_status(&self, biome: u32) {
        let biome_name = match biome {
            0 => "Tropical",
            1 => "Temperate",
            2 => "Arctic",
            3 => "Desert",
            4 => "Volcanic",
            _ => "Ocean",
        };
        let script = format!(
            "var el = document.getElementById('status'); if (el) el.textContent = 'Biome: {}';",
            biome_name
        );
        let _ = self.view.evaluate_script(&script);
    }

    /// Update the death overlay visibility and cause text.
    pub fn update_game_state(&self, is_dead: bool, cause: &str) {
        let escaped = cause.replace('\'', "\\'").replace('\\', "\\\\");
        let script = format!(
            "(function() {{ \
               var overlay = document.getElementById('death-overlay'); \
               if (!overlay) return; \
               var show = {}; \
               overlay.className = show ? 'visible' : ''; \
               if (show) {{ \
                 var c = document.getElementById('death-cause'); \
                 if (c) c.textContent = 'Cause: {}'; \
               }} \
             }})()",
            if is_dead { "true" } else { "false" },
            escaped,
        );
        let _ = self.view.evaluate_script(&script);
    }

    /// Check if the respawn button was clicked (polls the JS flag, resets it if true).
    pub fn poll_respawn_request(&self) -> bool {
        let script = "(function() { var r = window.__respawnRequested || false; window.__respawnRequested = false; return r ? 'true' : 'false'; })()";
        match self.view.evaluate_script(&script) {
            Ok(Ok(result)) => result.trim() == "true",
            _ => false,
        }
    }

    /// Update the inventory panel with current inventory JSON data.
    pub fn update_inventory(&self, json: &str) {
        let escaped = json.replace('\\', "\\\\").replace('\'', "\\'").replace('\n', "\\n");
        let script = format!(
            "(function() {{ if (window.__updateInventory) window.__updateInventory('{}'); }})()",
            escaped,
        );
        let _ = self.view.evaluate_script(&script);
    }

    /// Check if the inventory panel is currently visible (for cursor release).
    pub fn is_inventory_visible(&self) -> bool {
        let script = "(function() { return window.__inventoryVisible ? 'true' : 'false'; })()";
        match self.view.evaluate_script(&script) {
            Ok(Ok(result)) => result.trim() == "true",
            _ => false,
        }
    }

    /// Poll debug toggle state from the UI overlay's JavaScript.
    pub fn poll_debug_toggles(&self) -> DebugToggles {
        let script = "(function() { \
            var t = window.__debugToggles || {}; \
            return JSON.stringify({ \
                wireframe: !!t.wireframe, \
                hitboxes: !!t.hitboxes, \
                shadows: t.shadows !== false, \
                bloom: t.bloom !== false, \
                aabbs: !!t.aabbs, \
                normals: !!t.normals, \
                depth: !!t.depth \
            }); \
        })()";
        match self.view.evaluate_script(&script) {
            Ok(Ok(result)) => {
                let trimmed = result.trim();
                serde_json::from_str::<DebugToggles>(trimmed).unwrap_or_default()
            }
            _ => DebugToggles::default(),
        }
    }

    /// Poll for a craft request from the UI (recipe ID string), or None.
    pub fn poll_craft_request(&self) -> Option<String> {
        let script = "(function() { var r = window.__craftRequest || ''; window.__craftRequest = ''; return r; })()";
        match self.view.evaluate_script(&script) {
            Ok(Ok(result)) => {
                let trimmed = result.trim();
                if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
            }
            _ => None,
        }
    }
}
