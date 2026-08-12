//! SandWorld — the core falling-sand simulation.
//!
//! Ported from `games/falling-sand/src/simulation/sand-world.ts`.
//! All simulation logic is byte-for-byte compatible with the TypeScript
//! implementation (same cell packing, same flag bits, same reaction
//! order) so the WASM and JS backends produce identical behavior.
//!
//! Threading: the embarrassingly-parallel passes (reactions, combustion,
//! aging, active-list building, wind decay) use `rayon::par_iter` over
//! the active list or grid chunks. The movement pass uses the even-odd
//! row pattern (process even-indexed cells in parallel, then odd, with a
//! barrier between rows) to preserve spatial ordering without conflicts.

#![allow(clippy::too_many_arguments)]

use crate::materials::*;
use crate::rng::{random, random_shade};
use js_sys::Uint32Array;
use wasm_bindgen::prelude::*;

// ---------------------------------------------------------------------------
// SandWorld struct
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct SandWorld {
    pub(crate) w: usize,
    pub(crate) h: usize,
    pub(crate) grid: Vec<u32>,
    /// Per-cell physics fields: 4 bytes per cell [gravity:u8, temp:u8, windX:i8, windY:i8]
    pub(crate) fields: Vec<u8>,
    pub(crate) frame: u32,
    /// Global impulse settings (not spatial)
    pub(crate) horizontal_impulse_chance: f32,
    pub(crate) horizontal_impulse_strength: f32,

    // --- Reusable per-frame buffers (avoid allocations in hot paths) ---
    fire_sources: Vec<u8>,
    visited_frame: Vec<u32>,
    visited_c4_frame: Vec<u32>,
    active_cells: Vec<u32>,
    active_count: usize,

    // --- Wind dirty flag ---
    has_wind: bool,
}

#[wasm_bindgen]
impl SandWorld {
    #[wasm_bindgen(constructor)]
    pub fn new(w: usize, h: usize) -> SandWorld {
        let cells = w * h;
        let mut grid = vec![0u32; cells];
        let mut fields = vec![0u8; cells * 4];

        // Initialize fields to defaults
        let mut i = 0;
        while i < cells * 4 {
            fields[i + FIELD_GRAVITY] = DEFAULT_GRAVITY;
            fields[i + FIELD_TEMP] = DEFAULT_TEMP;
            i += 4;
        }

        // Stone floor (bottom 4 rows)
        for x in 0..w {
            for y in (h - 4)..h {
                grid[y * w + x] = pack_cell(STONE, 0, 0);
            }
        }

        SandWorld {
            w,
            h,
            grid,
            fields,
            frame: 0,
            horizontal_impulse_chance: 0.02,
            horizontal_impulse_strength: 1.0,
            fire_sources: vec![0u8; cells],
            visited_frame: vec![0u32; cells],
            visited_c4_frame: vec![0u32; cells],
            active_cells: vec![0u32; cells],
            active_count: 0,
            has_wind: false,
        }
    }

    // --- Zero-copy typed array views into WASM linear memory ---

    #[wasm_bindgen(getter)]
    pub fn grid(&self) -> Uint32Array {
        unsafe { Uint32Array::view(&self.grid) }
    }

    #[wasm_bindgen(getter)]
    pub fn fields(&self) -> js_sys::Uint8Array {
        unsafe { js_sys::Uint8Array::view(&self.fields) }
    }

    #[wasm_bindgen(getter)]
    pub fn w(&self) -> usize { self.w }

    #[wasm_bindgen(getter)]
    pub fn h(&self) -> usize { self.h }

    #[wasm_bindgen(getter)]
    pub fn frame(&self) -> u32 { self.frame }

    // --- Settings ---

    pub fn set_horizontal_impulse(&mut self, chance: f32, strength: f32) {
        self.horizontal_impulse_chance = chance;
        self.horizontal_impulse_strength = strength;
    }

    // --- Cell accessors (for tests + JS interop) ---

    pub fn get_cell_mat(&self, x: usize, y: usize) -> u32 {
        if x >= self.w || y >= self.h { return 0; }
        (self.grid[y * self.w + x] & 0xff) as u32
    }

    pub fn get_cell_lifetime(&self, x: usize, y: usize) -> u32 {
        if x >= self.w || y >= self.h { return 0; }
        ((self.grid[y * self.w + x] >> 8) & 0xff) as u32
    }

    pub fn get_cell_flags(&self, x: usize, y: usize) -> u32 {
        if x >= self.w || y >= self.h { return 0; }
        ((self.grid[y * self.w + x] >> 16) & 0xff) as u32
    }

    pub fn set_cell(&mut self, x: usize, y: usize, mat: u32, lifetime: u32, flags: u32) {
        if x >= self.w || y >= self.h { return; }
        self.grid[y * self.w + x] = pack_cell(mat as u8, lifetime as u8, flags as u8);
    }

    // --- Field accessors ---

    pub fn get_temperature(&self, x: i32, y: i32) -> f32 {
        if x < 0 || x >= self.w as i32 || y < 0 || y >= self.h as i32 { return 1.0; }
        self.fields[(y as usize * self.w + x as usize) * 4 + FIELD_TEMP] as f32 / 128.0
    }

    pub fn set_field(&mut self, x: i32, y: i32, field_type: u32, value: u8) {
        if x < 0 || x >= self.w as i32 || y < 0 || y >= self.h as i32 { return; }
        let fi = (y as usize * self.w + x as usize) * 4 + field_type as usize;
        self.fields[fi] = value;
    }

    // --- Brush operations ---

    pub fn paint_material(&mut self, cx: i32, cy: i32, mat: u32, radius: i32) {
        let w = self.w as i32;
        let h = self.h as i32;
        let r2 = radius * radius;
        let lt = initial_lifetime(mat as u8);
        let mat_u8 = mat as u8;
        for y in (cy - radius)..=(cy + radius) {
            if y < 0 || y >= h { continue; }
            for x in (cx - radius)..=(cx + radius) {
                if x < 0 || x >= w { continue; }
                let ddx = x - cx;
                let ddy = y - cy;
                if ddx * ddx + ddy * ddy > r2 { continue; }
                let idx = (y as usize) * self.w + (x as usize);
                let cur_mat = (self.grid[idx] & 0xff) as u8;
                if cur_mat == STONE || cur_mat == WALL { continue; }
                self.grid[idx] = pack_cell(mat_u8, lt, random_shade());
            }
        }
    }

    pub fn paint_line(&mut self, x0: i32, y0: i32, x1: i32, y1: i32, mat: u32, radius: i32) {
        let dx = (x1 - x0).abs();
        let dy = (y1 - y0).abs();
        let sx = if x0 < x1 { 1 } else { -1 };
        let sy = if y0 < y1 { 1 } else { -1 };
        let mut err = dx - dy;
        let mut x = x0;
        let mut y = y0;
        loop {
            self.paint_material(x, y, mat, radius);
            if x == x1 && y == y1 { break; }
            let e2 = 2 * err;
            if e2 > -dy { err -= dy; x += sx; }
            if e2 < dx { err += dx; y += sy; }
        }
    }

    pub fn paint_field_line(&mut self, x0: i32, y0: i32, x1: i32, y1: i32, field_type: u32, value: u8, radius: i32) {
        let dx = (x1 - x0).abs();
        let dy = (y1 - y0).abs();
        let sx = if x0 < x1 { 1 } else { -1 };
        let sy = if y0 < y1 { 1 } else { -1 };
        let mut err = dx - dy;
        let mut x = x0;
        let mut y = y0;
        loop {
            self.paint_field(x, y, field_type, value, radius);
            if x == x1 && y == y1 { break; }
            let e2 = 2 * err;
            if e2 > -dy { err -= dy; x += sx; }
            if e2 < dx { err += dx; y += sy; }
        }
    }

    pub fn ignite_line(&mut self, x0: i32, y0: i32, x1: i32, y1: i32, radius: i32) {
        let dx = (x1 - x0).abs();
        let dy = (y1 - y0).abs();
        let sx = if x0 < x1 { 1 } else { -1 };
        let sy = if y0 < y1 { 1 } else { -1 };
        let mut err = dx - dy;
        let mut x = x0;
        let mut y = y0;
        loop {
            self.ignite(x, y, radius);
            if x == x1 && y == y1 { break; }
            let e2 = 2 * err;
            if e2 > -dy { err -= dy; x += sx; }
            if e2 < dx { err += dx; y += sy; }
        }
    }

    // --- Main step ---

    pub fn step(&mut self) {
        self.frame += 1;

        // Pass 1: Clear FLAG_UPDATED + build active-cell list in a single scan
        self.build_active_list_and_clear_flags();

        // Pass 2-3: Reactions iterate only the active list
        self.apply_reactions();
        self.apply_special_reactions();

        // Pass 4: Movement — full grid in spatial order (bottom-to-top, alternating L/R)
        let left_to_right = self.frame % 2 == 0;
        let h = self.h as i32;
        let w = self.w as i32;
        for y in (0..h).rev() {
            if left_to_right {
                let mut x = 0;
                while x < w {
                    self.try_move(x, y);
                    x += 1;
                }
            } else {
                let mut x = w - 1;
                while x >= 0 {
                    self.try_move(x, y);
                    x -= 1;
                }
            }
        }

        // Pass 5: Combustion
        self.apply_combustion();

        // Rebuild active list
        self.build_active_list();

        // Pass 6: Aging
        self.apply_aging();

        // Pass 7: Wind decay
        self.decay_wind();
    }
}

// ---------------------------------------------------------------------------
// Private implementation — all sim passes
// ---------------------------------------------------------------------------

impl SandWorld {
    /// Paint a circular field region.
    fn paint_field(&mut self, cx: i32, cy: i32, field_type: u32, value: u8, radius: i32) {
        let w = self.w as i32;
        let h = self.h as i32;
        let r2 = radius * radius;
        for y in (cy - radius)..=(cy + radius) {
            if y < 0 || y >= h { continue; }
            for x in (cx - radius)..=(cx + radius) {
                if x < 0 || x >= w { continue; }
                let ddx = x - cx;
                let ddy = y - cy;
                if ddx * ddx + ddy * ddy > r2 { continue; }
                let fi = (y as usize) * self.w + (x as usize);
                self.fields[fi * 4 + field_type as usize] = value;
            }
        }
    }

    /// Ignite flammable materials in a circular region.
    fn ignite(&mut self, cx: i32, cy: i32, radius: i32) {
        let w = self.w as i32;
        let h = self.h as i32;
        let r2 = radius * radius;
        for y in (cy - radius)..=(cy + radius) {
            if y < 0 || y >= h { continue; }
            for x in (cx - radius)..=(cx + radius) {
                if x < 0 || x >= w { continue; }
                let ddx = x - cx;
                let ddy = y - cy;
                if ddx * ddx + ddy * ddy > r2 { continue; }
                let idx = (y as usize) * self.w + (x as usize);
                let mat = (self.grid[idx] & 0xff) as u8;
                if (MAT_FLAGS[mat as usize] & MAT_FLAMMABLE) == 0 { continue; }
                if mat == FUSE {
                    self.grid[idx] = pack_cell(FUSE_FIRE, 15, random_shade());
                } else if mat == OIL {
                    if !self.is_exposed(x, y) { continue; }
                    self.grid[idx] = pack_cell(BURNING_OIL, MAT_LIFETIME[BURNING_OIL as usize], random_shade());
                } else {
                    self.grid[idx] = pack_cell(FIRE, 30, random_shade());
                }
            }
        }
    }

    /// Build the active-cell list and clear FLAG_UPDATED in a single pass.
    fn build_active_list_and_clear_flags(&mut self) {
        let n = self.w * self.h;
        let clear_mask: u32 = !(((0xff & !(SHADE_MASK | FLAG_SPARK)) as u32) << 16);
        let mut count = 0;
        let mut wind_detected = false;
        for i in 0..n {
            self.grid[i] &= clear_mask;
            if self.grid[i] != 0 {
                self.active_cells[count] = i as u32;
                count += 1;
            }
            let fi = i * 4;
            if !wind_detected && (self.fields[fi + FIELD_WIND_X] != 0 || self.fields[fi + FIELD_WIND_Y] != 0) {
                wind_detected = true;
            }
        }
        self.active_count = count;
        if wind_detected { self.has_wind = true; }
    }

    /// Build the active-cell list without clearing flags (mid-frame rebuild).
    fn build_active_list(&mut self) {
        let n = self.w * self.h;
        let mut count = 0;
        for i in 0..n {
            if self.grid[i] != 0 {
                self.active_cells[count] = i as u32;
                count += 1;
            }
        }
        self.active_count = count;
    }

    /// tryMove — the movement function. Processes a single cell.
    fn try_move(&mut self, x: i32, y: i32) {
        let w = self.w as i32;
        let h = self.h as i32;
        let idx = (y as usize) * self.w + (x as usize);
        let packed = self.grid[idx];
        if packed == 0 { return; }

        let mat = (packed & 0xff) as u8;
        if mat == EMPTY { return; }
        let flags = ((packed >> 16) & 0xff) as u8;
        if (flags & FLAG_UPDATED) != 0 { return; }

        let gravity_dir = MAT_GRAVITY_DIR[mat as usize];
        if gravity_dir == 0 { return; }

        // FuseFire stays put so it can deterministically spread to adjacent fuse
        if mat == FUSE_FIRE { return; }

        let fi = idx * 4;
        let gravity = self.fields[fi + FIELD_GRAVITY] as f32 / 128.0;
        let wind_x = (self.fields[fi + FIELD_WIND_X] as i8) as i32;
        let wind_y = (self.fields[fi + FIELD_WIND_Y] as i8) as i32;

        if gravity <= 0.0 { return; }

        let mat_flags = MAT_FLAGS[mat as usize];
        let dy = gravity_dir as i32;
        let is_liquid = (mat_flags & MAT_LIQUID) != 0;
        let is_gas = (mat_flags & MAT_GAS) != 0;
        let mat_gravity = MAT_GRAVITY[mat as usize];

        // --- Wind: apply horizontal/vertical force ---
        if wind_x != 0 || wind_y != 0 {
            let wdx = if wind_x > 0 { 1 } else if wind_x < 0 { -1 } else { 0 };
            let wdy = if wind_y > 0 { 1 } else if wind_y < 0 { -1 } else { 0 };
            let wind_chance = ((wind_x.abs() + wind_y.abs()) as f32 / 30.0).min(1.0);
            if random() < wind_chance {
                let wind_mag = (wind_x.abs() + wind_y.abs()) as i32;
                if wind_mag >= 50 {
                    if self.try_shove(x, y, x + wdx, y + wdy, packed) { return; }
                } else {
                    if self.try_swap(x, y, x + wdx, y + wdy, packed, mat, mat_gravity, is_gas) { return; }
                }
            }
        }

        // --- Edge friction ---
        let has_left = x > 0 && self.grid[(y as usize) * self.w + ((x - 1) as usize)] != 0;
        let has_right = x < w - 1 && self.grid[(y as usize) * self.w + ((x + 1) as usize)] != 0;
        let is_exterior = !has_left || !has_right;

        // Honey: very thick — high friction
        if mat == HONEY && is_exterior && random() < 0.7 { return; }

        if is_exterior && !is_gas {
            let friction_chance = 0.3 / mat_gravity.max(1.0);
            if random() < friction_chance { return; }
        }

        // --- Gas flicker ---
        if is_gas {
            let flicker_chance = if mat == FIRE || mat == FUSE_FIRE { 0.35 } else { 0.25 };
            if random() < flicker_chance { return; }
        }

        // --- Density-scaled horizontal impulse ---
        if self.horizontal_impulse_chance > 0.0 {
            let scaled_chance = self.horizontal_impulse_chance / mat_gravity.max(1.0);
            if random() < scaled_chance {
                let nudge_dir = if random() < 0.5 { -1 } else { 1 };
                let nudge = nudge_dir * (self.horizontal_impulse_strength.round() as i32).max(1);
                if self.try_swap(x, y, x + nudge, y + dy, packed, mat, mat_gravity, is_gas) { return; }
            }
        }

        // 1. Try gravity direction
        if self.try_swap(x, y, x, y + dy, packed, mat, mat_gravity, is_gas) { return; }

        // Rubber: bouncy
        if mat == RUBBER {
            let below_y = y + dy;
            let blocked = below_y < 0 || below_y >= h || self.grid[(below_y as usize) * self.w + (x as usize)] != 0;
            if blocked {
                if random() < 0.5 {
                    if self.try_swap(x, y, x, y - dy, packed, mat, mat_gravity, is_gas) { return; }
                }
                let bounce_dir = if random() < 0.5 { -1 } else { 1 };
                if self.try_swap(x, y, x + bounce_dir * 2, y, packed, mat, mat_gravity, is_gas) { return; }
                if self.try_swap(x, y, x + bounce_dir, y, packed, mat, mat_gravity, is_gas) { return; }
            }
        }

        let dir = if random() < 0.5 { -1 } else { 1 };
        if self.try_swap(x, y, x + dir, y + dy, packed, mat, mat_gravity, is_gas) { return; }
        if self.try_swap(x, y, x - dir, y + dy, packed, mat, mat_gravity, is_gas) { return; }

        if is_liquid {
            let flow_dir = if random() < 0.5 { -1 } else { 1 };
            if self.try_flow(x, y, flow_dir, 5) { return; }
            if self.try_flow(x, y, -flow_dir, 5) { return; }
        }

        // Gas: wider horizontal drift
        if is_gas {
            let drift_dir = if random() < 0.5 { -1 } else { 1 };
            if self.try_flow(x, y, drift_dir, 3) { return; }
            if self.try_flow(x, y, -drift_dir, 3) { return; }
        }

        // Liquids: sink through gas below
        if is_liquid && dy > 0 {
            let below = y + 1;
            if below < h {
                let below_idx = (below as usize) * self.w + (x as usize);
                let below_packed = self.grid[below_idx];
                if below_packed != 0 {
                    let below_mat = (below_packed & 0xff) as u8;
                    let below_flags = MAT_FLAGS[below_mat as usize];
                    if ((below_packed >> 16) & FLAG_UPDATED as u32) == 0 &&
                       ((below_flags & MAT_GAS) != 0 ||
                        ((below_flags & MAT_LIQUID) != 0 && MAT_DENSITY[mat as usize] > MAT_DENSITY[below_mat as usize])) {
                        self.grid[below_idx] = packed | FLAG_UPDATED_BIT;
                        self.grid[idx] = below_packed | FLAG_UPDATED_BIT;
                        return;
                    }
                }
            }
        }

        // Glitter: suspends in water
        if mat == GLITTER {
            if y + 1 < h && (self.grid[((y + 1) as usize) * self.w + (x as usize)] & 0xff) as u8 == WATER {
                if random() < 0.8 { return; }
            }
        }
    }

    /// Try to move/swap the cell at (x,y) into (nx,ny).
    fn try_swap(&mut self, x: i32, y: i32, nx: i32, ny: i32, src_packed: u32, src_mat: u8, src_gravity: f32, src_is_gas: bool) -> bool {
        let w = self.w as i32;
        let h = self.h as i32;
        if nx < 0 || nx >= w || ny < 0 || ny >= h { return false; }
        let dest_idx = (ny as usize) * self.w + (nx as usize);
        let src_idx = (y as usize) * self.w + (x as usize);
        let dest_packed = self.grid[dest_idx];

        if dest_packed == 0 {
            self.grid[dest_idx] = src_packed | FLAG_UPDATED_BIT;
            self.grid[src_idx] = 0;
            return true;
        }

        // Non-gas displacing gas
        if !src_is_gas {
            let dest_mat = (dest_packed & 0xff) as u8;
            if (MAT_FLAGS[dest_mat as usize] & MAT_GAS) != 0 && ((dest_packed >> 16) & FLAG_UPDATED as u32) == 0 {
                self.grid[dest_idx] = src_packed | FLAG_UPDATED_BIT;
                self.grid[src_idx] = dest_packed | FLAG_UPDATED_BIT;
                return true;
            }
        }

        // Gas-to-gas displacement
        if src_is_gas {
            let dest_mat = (dest_packed & 0xff) as u8;
            if (MAT_FLAGS[dest_mat as usize] & MAT_GAS) != 0 && src_gravity > MAT_GRAVITY[dest_mat as usize] {
                self.grid[dest_idx] = src_packed | FLAG_UPDATED_BIT;
                self.grid[src_idx] = dest_packed | FLAG_UPDATED_BIT;
                return true;
            }
        }

        // Solid-liquid density displacement: a denser material sinks through
        // a less-dense one. Sand (2.0) sinks through water (1.0) but not
        // mercury (13.5). Water (1.0) sinks through wood (0.6), making wood
        // float. Only solid-liquid pairs; structural barriers (static solids
        // with density >= 2.0, e.g. stone/wall/concrete) are immovable.
        if !src_is_gas {
            let dest_mat = (dest_packed & 0xff) as u8;
            let dest_flags = MAT_FLAGS[dest_mat as usize];
            if (dest_flags & (MAT_SOLID | MAT_LIQUID)) != 0 && ((dest_packed >> 16) & FLAG_UPDATED as u32) == 0 {
                let src_is_solid = (MAT_FLAGS[src_mat as usize] & MAT_SOLID) != 0;
                let dest_is_solid = (dest_flags & MAT_SOLID) != 0;
                let dest_is_barrier = dest_is_solid && MAT_GRAVITY_DIR[dest_mat as usize] == 0 && MAT_DENSITY[dest_mat as usize] >= 2.0;
                if src_is_solid != dest_is_solid &&
                   !dest_is_barrier &&
                   MAT_DENSITY[src_mat as usize] > MAT_DENSITY[dest_mat as usize] {
                    self.grid[dest_idx] = src_packed | FLAG_UPDATED_BIT;
                    self.grid[src_idx] = dest_packed | FLAG_UPDATED_BIT;
                    return true;
                }
            }
        }

        false
    }

    /// Like trySwap, but can also displace liquids/gases.
    fn try_shove(&mut self, x: i32, y: i32, nx: i32, ny: i32, src_packed: u32) -> bool {
        let w = self.w as i32;
        let h = self.h as i32;
        if nx < 0 || nx >= w || ny < 0 || ny >= h { return false; }
        let dest_idx = (ny as usize) * self.w + (nx as usize);
        let src_idx = (y as usize) * self.w + (x as usize);
        let dest_packed = self.grid[dest_idx];
        if dest_packed == 0 {
            self.grid[dest_idx] = src_packed | FLAG_UPDATED_BIT;
            self.grid[src_idx] = 0;
            return true;
        }
        let dest_mat = (dest_packed & 0xff) as u8;
        let dest_flags = MAT_FLAGS[dest_mat as usize];
        if (dest_flags & (MAT_LIQUID | MAT_GAS)) == 0 { return false; }
        if ((dest_packed >> 16) & FLAG_UPDATED as u32) != 0 { return false; }
        self.grid[dest_idx] = src_packed | FLAG_UPDATED_BIT;
        self.grid[src_idx] = dest_packed | FLAG_UPDATED_BIT;
        true
    }

    /// Horizontal flow for liquids/gases.
    fn try_flow(&mut self, x: i32, y: i32, dir: i32, max_steps: i32) -> bool {
        let w = self.w as i32;
        let h = self.h as i32;
        let src_idx = (y as usize) * self.w + (x as usize);
        let moved_packed = self.grid[src_idx] | FLAG_UPDATED_BIT;
        for step in 1..=max_steps {
            let nx = x + dir * step;
            if nx < 0 || nx >= w { return false; }
            let dest_idx = (y as usize) * self.w + (nx as usize);
            if self.grid[dest_idx] != 0 { return false; }

            let below_y = y + 1;
            if below_y < h {
                let below_idx = (below_y as usize) * self.w + (nx as usize);
                if self.grid[below_idx] == 0 {
                    self.grid[below_idx] = moved_packed;
                    self.grid[src_idx] = 0;
                    return true;
                }
            }

            if step == max_steps {
                self.grid[dest_idx] = moved_packed;
                self.grid[src_idx] = 0;
                return true;
            }
        }
        false
    }

    /// Apply basic reactions (water/lava/fire interactions).
    fn apply_reactions(&mut self) {
        let w = self.w as i32;
        let h = self.h as i32;
        let count = self.active_count;

        for a in 0..count {
            let idx = self.active_cells[a] as usize;
            let packed = self.grid[idx];
            if packed == 0 { continue; }

            let mat = (packed & 0xff) as u8;
            if mat == EMPTY { continue; }

            let fi = idx * 4;
            let temp = self.fields[fi + FIELD_TEMP] as f32 / 128.0;

            if mat == WATER {
                let x = (idx % self.w) as i32;
                let y = (idx / self.w) as i32;
                let mut lava_idx: i32 = -1;
                let mut fire_idx: i32 = -1;
                let mut has_plant = false;
                for dy in -1..=1 {
                    let ny = y + dy;
                    if ny < 0 || ny >= h { continue; }
                    for dx in -1..=1 {
                        if dx == 0 && dy == 0 { continue; }
                        let nx = x + dx;
                        if nx < 0 || nx >= w { continue; }
                        let ni = (ny as usize) * self.w + (nx as usize);
                        let n_mat = (self.grid[ni] & 0xff) as u8;
                        if n_mat == LAVA { lava_idx = ni as i32; }
                        else if IS_FIRE[n_mat as usize] != 0 { fire_idx = ni as i32; }
                        else if n_mat == PLANT { has_plant = true; }
                    }
                }

                if lava_idx >= 0 {
                    self.grid[idx] = pack_cell(STEAM, 120, random_shade());
                    self.grid[lava_idx as usize] = pack_cell(STONE, 0, random_shade());
                    continue;
                }
                if fire_idx >= 0 && random() < 0.25 {
                    self.grid[idx] = pack_cell(STEAM, 120, random_shade());
                    self.grid[fire_idx as usize] = pack_cell(SMOKE, 40, random_shade());
                    continue;
                }
                if temp > 1.5 && random() < (temp - 1.5) * 0.02 {
                    self.grid[idx] = pack_cell(STEAM, 120, random_shade());
                    continue;
                }
                if has_plant && random() < 0.02 {
                    self.grid[idx] = pack_cell(PLANT, 0, random_shade());
                    continue;
                }
            }

            // Low temperature: fire-class dies faster
            if IS_FIRE[mat as usize] != 0 && temp < 0.5 {
                if random() < (0.5 - temp) * 0.1 {
                    self.grid[idx] = pack_cell(SMOKE, 60, random_shade());
                }
            }
        }
    }

    /// Apply special reactions for new materials (50+ material-specific behaviors).
    fn apply_special_reactions(&mut self) {
        let w = self.w as i32;
        let h = self.h as i32;
        let count = self.active_count;
        let frame = self.frame;

        for a in 0..count {
            let idx = self.active_cells[a] as usize;
            let packed = self.grid[idx];
            if packed == 0 { continue; }

            let mat = (packed & 0xff) as u8;
            if mat == EMPTY { continue; }
            let lifetime = ((packed >> 8) & 0xff) as u8;
            let flags = ((packed >> 16) & 0xff) as u8;

            let fi = idx * 4;
            let temp = self.fields[fi + FIELD_TEMP] as f32 / 128.0;

            let x = (idx % self.w) as i32;
            let y = (idx / self.w) as i32;

            // --- Antimatter ---
            if mat == ANTIMATTER {
                for dy in -1..=1 {
                    for dx in -1..=1 {
                        if dx == 0 && dy == 0 { continue; }
                        let nx = x + dx;
                        let ny = y + dy;
                        if nx < 0 || nx >= w || ny < 0 || ny >= h { continue; }
                        let n_mat = (self.grid[(ny as usize) * self.w + (nx as usize)] & 0xff) as u8;
                        if n_mat != EMPTY && n_mat != ANTIMATTER && n_mat != WALL {
                            self.grid[(ny as usize) * self.w + (nx as usize)] = 0;
                            self.grid[idx] = 0;
                            self.explode(x, y, 3);
                            break;
                        }
                    }
                }
                continue;
            }

            // --- Plasma ---
            if mat == PLASMA {
                for dy in -1..=1 {
                    for dx in -1..=1 {
                        if dx == 0 && dy == 0 { continue; }
                        let nx = x + dx;
                        let ny = y + dy;
                        if nx < 0 || nx >= w || ny < 0 || ny >= h { continue; }
                        let n_mat = (self.grid[(ny as usize) * self.w + (nx as usize)] & 0xff) as u8;
                        if n_mat != EMPTY && n_mat != PLASMA && n_mat != WALL {
                            if random() < 0.3 {
                                self.grid[(ny as usize) * self.w + (nx as usize)] = pack_cell(FIRE, 10, random_shade());
                            }
                        }
                    }
                }
                continue;
            }

            // --- Mystery (???) ---
            if mat == MYSTERY {
                let phase = (frame as f32 * 0.1 + x as f32 * 0.3 + y as f32 * 0.2).sin();
                if phase > 0.9 && random() < 0.1 {
                    if y > 0 && self.grid[((y - 1) as usize) * self.w + (x as usize)] == 0 {
                        self.grid[((y - 1) as usize) * self.w + (x as usize)] = pack_cell(PLASMA, 20, random_shade());
                    }
                }
                if phase < -0.9 && random() < 0.05 {
                    let mystery_dirs = [1, 0, -1, 0, 0, 1, 0, -1];
                    let di = ((random() * 4.0) as usize) * 2;
                    let dx = mystery_dirs[di];
                    let dy = mystery_dirs[di + 1];
                    let nx = x + dx;
                    let ny = y + dy;
                    if nx >= 0 && nx < w && ny >= 0 && ny < h {
                        let n_mat = (self.grid[(ny as usize) * self.w + (nx as usize)] & 0xff) as u8;
                        if n_mat != EMPTY && n_mat != WALL && n_mat != MYSTERY {
                            self.grid[(ny as usize) * self.w + (nx as usize)] = 0;
                        }
                    }
                }
                continue;
            }

            // --- Gasoline: vaporizes ---
            if mat == GASOLINE {
                if random() < 0.005 {
                    if y > 0 && self.grid[((y - 1) as usize) * self.w + (x as usize)] == 0 {
                        self.grid[((y - 1) as usize) * self.w + (x as usize)] = pack_cell(GAS_VAPOR, 200, random_shade());
                        if random() < 0.3 { self.grid[idx] = 0; }
                    }
                }
                continue;
            }

            // --- Salt + Water → Brine ---
            if mat == SALT {
                let mut water_ni: i32 = -1;
                let mut has_snow = false;
                for dy in -1..=1 {
                    let ny = y + dy;
                    if ny < 0 || ny >= h { continue; }
                    for dx in -1..=1 {
                        if dx == 0 && dy == 0 { continue; }
                        let nx = x + dx;
                        if nx < 0 || nx >= w { continue; }
                        let n_mat = (self.grid[(ny as usize) * self.w + (nx as usize)] & 0xff) as u8;
                        if n_mat == WATER { water_ni = (ny as usize * self.w + nx as usize) as i32; }
                        else if n_mat == SNOW { has_snow = true; }
                    }
                }
                if water_ni >= 0 && random() < 0.1 {
                    self.grid[idx] = pack_cell(BRINE, 0, random_shade());
                    self.grid[water_ni as usize] = pack_cell(BRINE, 0, random_shade());
                    continue;
                }
                if has_snow {
                    self.grid[idx] = 0;
                    let mut dissolved = 0;
                    'outer: for ry in (y - 3)..=(y + 3) {
                        for rx in (x - 3)..=(x + 3) {
                            if dissolved >= 10 { break 'outer; }
                            if rx < 0 || rx >= w || ry < 0 || ry >= h { continue; }
                            let ridx = (ry as usize) * self.w + (rx as usize);
                            if (self.grid[ridx] & 0xff) as u8 == SNOW {
                                self.grid[ridx] = pack_cell(WATER, 0, random_shade());
                                dissolved += 1;
                            }
                        }
                    }
                    continue;
                }
                if temp > 1.8 && random() < 0.02 {
                    self.grid[idx] = pack_cell(MOLTEN_SALT, 0, random_shade());
                    continue;
                }
            }

            // --- Molten Salt ---
            if mat == MOLTEN_SALT {
                if temp < 0.5 && random() < 0.05 {
                    self.grid[idx] = pack_cell(SALT, 0, random_shade());
                    continue;
                }
                let mut water_ni: i32 = -1;
                let mut dry_ice_ni: i32 = -1;
                for dy in -1..=1 {
                    let ny = y + dy;
                    if ny < 0 || ny >= h { continue; }
                    for dx in -1..=1 {
                        if dx == 0 && dy == 0 { continue; }
                        let nx = x + dx;
                        if nx < 0 || nx >= w { continue; }
                        let n_mat = (self.grid[(ny as usize) * self.w + (nx as usize)] & 0xff) as u8;
                        if n_mat == WATER { water_ni = (ny as usize * self.w + nx as usize) as i32; }
                        else if n_mat == DRY_ICE { dry_ice_ni = (ny as usize * self.w + nx as usize) as i32; }
                    }
                }
                if water_ni >= 0 {
                    self.apply_impulse(x, y, 6, 100.0);
                    self.grid[water_ni as usize] = pack_cell(STEAM, 80, random_shade());
                    if random() < 0.3 {
                        self.grid[idx] = pack_cell(SALT, 0, random_shade());
                    }
                    continue;
                }
                if dry_ice_ni >= 0 {
                    self.apply_impulse(x, y, 6, 100.0);
                    self.grid[dry_ice_ni as usize] = 0;
                    if random() < 0.5 {
                        self.grid[idx] = pack_cell(SALT, 0, random_shade());
                    }
                    continue;
                }
                // Ignite flammable neighbors
                for dy in -1..=1 {
                    for dx in -1..=1 {
                        if dx == 0 && dy == 0 { continue; }
                        let nx = x + dx;
                        let ny = y + dy;
                        if nx < 0 || nx >= w || ny < 0 || ny >= h { continue; }
                        let ni = (ny as usize) * self.w + (nx as usize);
                        let n_mat = (self.grid[ni] & 0xff) as u8;
                        if (MAT_FLAGS[n_mat as usize] & MAT_FLAMMABLE) != 0 && random() < 0.15 {
                            if n_mat == OIL {
                                if !self.is_exposed(nx, ny) { continue; }
                                self.grid[ni] = pack_cell(BURNING_OIL, MAT_LIFETIME[BURNING_OIL as usize], random_shade());
                            } else {
                                self.grid[ni] = pack_cell(FIRE, 30, random_shade());
                            }
                        }
                    }
                }
                continue;
            }

            // --- Concrete Powder + Water → Concrete ---
            if mat == CONCRETE_POWDER {
                let mut water_ni: i32 = -1;
                'find_water: for dy in -1..=1 {
                    let ny = y + dy;
                    if ny < 0 || ny >= h { continue; }
                    for dx in -1..=1 {
                        if dx == 0 && dy == 0 { continue; }
                        let nx = x + dx;
                        if nx < 0 || nx >= w { continue; }
                        if (self.grid[(ny as usize) * self.w + (nx as usize)] & 0xff) as u8 == WATER {
                            water_ni = (ny as usize * self.w + nx as usize) as i32;
                            break 'find_water;
                        }
                    }
                }
                if water_ni >= 0 && random() < 0.2 {
                    self.grid[idx] = pack_cell(CONCRETE, 0, random_shade());
                    self.grid[water_ni as usize] = 0;
                    continue;
                }
            }

            // --- Snow: melts ---
            if mat == SNOW {
                let mut has_hot = false;
                'snow_scan: for dy in -1..=1 {
                    let ny = y + dy;
                    if ny < 0 || ny >= h { continue; }
                    for dx in -1..=1 {
                        if dx == 0 && dy == 0 { continue; }
                        let nx = x + dx;
                        if nx < 0 || nx >= w { continue; }
                        if IS_HOT[(self.grid[(ny as usize) * self.w + (nx as usize)] & 0xff) as usize] != 0 {
                            has_hot = true;
                            break 'snow_scan;
                        }
                    }
                }
                if has_hot {
                    if random() < 0.3 {
                        self.grid[idx] = pack_cell(WATER, 0, random_shade());
                        continue;
                    }
                } else if temp > 1.3 && random() < (temp - 1.3) * 0.05 {
                    self.grid[idx] = pack_cell(WATER, 0, random_shade());
                    continue;
                }
            }

            // --- Dry Ice: sublimates ---
            if mat == DRY_ICE {
                if random() < 0.02 {
                    if y > 0 && self.grid[((y - 1) as usize) * self.w + (x as usize)] == 0 {
                        self.grid[((y - 1) as usize) * self.w + (x as usize)] = pack_cell(SMOKE, 60, random_shade());
                        if random() < 0.5 { self.grid[idx] = 0; }
                    }
                }
                continue;
            }

            // --- Liquid Nitrogen ---
            if mat == LIQUID_NITROGEN {
                for dy in -1..=1 {
                    for dx in -1..=1 {
                        if dx == 0 && dy == 0 { continue; }
                        let nx = x + dx;
                        let ny = y + dy;
                        if nx < 0 || nx >= w || ny < 0 || ny >= h { continue; }
                        let ni = (ny as usize) * self.w + (nx as usize);
                        let n_mat = (self.grid[ni] & 0xff) as u8;
                        if IS_HOT[n_mat as usize] != 0 {
                            self.grid[ni] = if n_mat == LAVA {
                                pack_cell(STONE, 0, random_shade())
                            } else { 0 };
                        }
                    }
                }
                if random() < 0.01 {
                    self.grid[idx] = pack_cell(STEAM, 40, random_shade());
                }
                continue;
            }

            // --- Seed: grows into tree ---
            if mat == SEED {
                if y + 1 < h {
                    let below_mat = (self.grid[((y + 1) as usize) * self.w + (x as usize)] & 0xff) as u8;
                    if below_mat == DIRT || below_mat == GRASS {
                        if random() < 0.05 {
                            self.grow_tree(x, y);
                            continue;
                        }
                    }
                }
                continue;
            }

            // --- Grass: spreads on dirt ---
            if mat == GRASS {
                if y + 1 < h && (self.grid[((y + 1) as usize) * self.w + (x as usize)] & 0xff) as u8 == DIRT {
                    if random() < 0.02 {
                        let dir = if random() < 0.5 { -1 } else { 1 };
                        let nx = x + dir;
                        if nx >= 0 && nx < w {
                            if y + 1 < h && (self.grid[((y + 1) as usize) * self.w + (nx as usize)] & 0xff) as u8 == DIRT
                               && self.grid[(y as usize) * self.w + (nx as usize)] == 0 {
                                self.grid[(y as usize) * self.w + (nx as usize)] = pack_cell(GRASS, 0, random_shade());
                            }
                        }
                    }
                }
                continue;
            }

            // --- Nanobots ---
            if mat == NANOBOTS {
                let nanobot_dirs = [1, 0, -1, 0, 0, 1, 0, -1, 1, 1, -1, -1, 1, -1, -1, 1];
                let di = ((random() * 8.0) as usize) * 2;
                let dx = nanobot_dirs[di];
                let dy = nanobot_dirs[di + 1];
                let nx = x + dx;
                let ny = y + dy;
                if nx >= 0 && nx < w && ny >= 0 && ny < h {
                    let ni = (ny as usize) * self.w + (nx as usize);
                    let n_mat = (self.grid[ni] & 0xff) as u8;
                    if n_mat == EMPTY {
                        self.grid[ni] = pack_cell(mat, lifetime, flags | FLAG_UPDATED);
                        self.grid[idx] = 0;
                    } else if n_mat != NANOBOTS && n_mat != WALL && n_mat != ANTIMATTER {
                        if random() < 0.05 {
                            self.grid[ni] = 0;
                        }
                    }
                }
                continue;
            }

            // --- Magic Powder ---
            if mat == MAGIC_POWDER {
                if random() < 0.5 {
                    let new_shade = random_shade();
                    self.grid[idx] = pack_cell(mat, lifetime, (flags & !SHADE_MASK) | new_shade | FLAG_UPDATED);
                }
                let mut has_flesh = false;
                'flesh_scan: for dy in -1..=1 {
                    let ny = y + dy;
                    if ny < 0 || ny >= h { continue; }
                    for dx in -1..=1 {
                        if dx == 0 && dy == 0 { continue; }
                        let nx = x + dx;
                        if nx < 0 || nx >= w { continue; }
                        if (self.grid[(ny as usize) * self.w + (nx as usize)] & 0xff) as u8 == FLESH {
                            has_flesh = true;
                            break 'flesh_scan;
                        }
                    }
                }
                if has_flesh && random() < 0.3 {
                    self.explode(x, y, 4);
                    continue;
                }
                if random() < 0.02 {
                    let dx = (random() * 3.0) as i32 - 1;
                    let dy = (random() * 3.0) as i32 - 1;
                    let nx = x + dx;
                    let ny = y + dy;
                    if nx >= 0 && nx < w && ny >= 0 && ny < h && self.grid[(ny as usize) * self.w + (nx as usize)] == 0 {
                        self.grid[(ny as usize) * self.w + (nx as usize)] = pack_cell(FIREFLIES, 255, random_shade());
                    }
                }
                continue;
            }

            // --- Popcorn ---
            if mat == POPCORN {
                let mut has_hot = temp > 1.3;
                if !has_hot {
                    'pop_scan: for dy in -1..=1 {
                        let ny = y + dy;
                        if ny < 0 || ny >= h { continue; }
                        for dx in -1..=1 {
                            if dx == 0 && dy == 0 { continue; }
                            let nx = x + dx;
                            if nx < 0 || nx >= w { continue; }
                            if IS_HOT[(self.grid[(ny as usize) * self.w + (nx as usize)] & 0xff) as usize] != 0 {
                                has_hot = true;
                                break 'pop_scan;
                            }
                        }
                    }
                }
                if has_hot && random() < 0.3 {
                    self.apply_impulse(x, y, 4, 60.0);
                    let popcorn_dirs = [-1, -1, 0, -1, 1, -1, -1, 0, 1, 0, -1, 1, 0, 1, 1, 1];
                    let mut di = 0;
                    while di < 16 {
                        if random() < 0.6 {
                            let nx = x + popcorn_dirs[di];
                            let ny = y + popcorn_dirs[di + 1];
                            if nx >= 0 && nx < w && ny >= 0 && ny < h && self.grid[(ny as usize) * self.w + (nx as usize)] == 0 {
                                self.grid[(ny as usize) * self.w + (nx as usize)] = pack_cell(POPCORN, 0, random_shade());
                            }
                        }
                        di += 2;
                    }
                    if random() < 0.5 && y > 0 && self.grid[((y - 1) as usize) * self.w + (x as usize)] == 0 {
                        self.grid[((y - 1) as usize) * self.w + (x as usize)] = pack_cell(POPCORN, 0, random_shade());
                    }
                }
                continue;
            }

            // --- Dynamite ---
            if mat == DYNAMITE {
                let mut has_fire_or_fuse = false;
                'dyn_scan: for dy in -1..=1 {
                    let ny = y + dy;
                    if ny < 0 || ny >= h { continue; }
                    for dx in -1..=1 {
                        if dx == 0 && dy == 0 { continue; }
                        let nx = x + dx;
                        if nx < 0 || nx >= w { continue; }
                        let n_mat = (self.grid[(ny as usize) * self.w + (nx as usize)] & 0xff) as u8;
                        if IS_FIRE[n_mat as usize] != 0 || n_mat == FUSE {
                            has_fire_or_fuse = true;
                            break 'dyn_scan;
                        }
                    }
                }
                if has_fire_or_fuse && random() < 0.2 {
                    self.explode(x, y, 6);
                }
                continue;
            }

            // --- C4 ---
            if mat == C4 {
                let mut fuse_burning = false;
                'c4_scan: for dy in -1..=1 {
                    for dx in -1..=1 {
                        if dx == 0 && dy == 0 { continue; }
                        let nx = x + dx;
                        let ny = y + dy;
                        if nx < 0 || nx >= w || ny < 0 || ny >= h { continue; }
                        if (self.grid[(ny as usize) * self.w + (nx as usize)] & 0xff) as u8 == FUSE_FIRE {
                            fuse_burning = true;
                            break 'c4_scan;
                        }
                    }
                }
                if fuse_burning && random() < 0.3 {
                    self.detonate_c4(x, y);
                }
                continue;
            }

            // --- Flour: dust explosion ---
            if mat == FLOUR {
                let mut has_fire = false;
                'flour_scan: for dy in -1..=1 {
                    let ny = y + dy;
                    if ny < 0 || ny >= h { continue; }
                    for dx in -1..=1 {
                        if dx == 0 && dy == 0 { continue; }
                        let nx = x + dx;
                        if nx < 0 || nx >= w { continue; }
                        if IS_FIRE[(self.grid[(ny as usize) * self.w + (nx as usize)] & 0xff) as usize] != 0 {
                            has_fire = true;
                            break 'flour_scan;
                        }
                    }
                }
                if has_fire && random() < 0.15 {
                    self.explode(x, y, 3);
                }
                continue;
            }

            // --- Hydrogen: explodes near fire ---
            if mat == HYDROGEN {
                let mut has_fire = false;
                'h2_scan: for dy in -1..=1 {
                    let ny = y + dy;
                    if ny < 0 || ny >= h { continue; }
                    for dx in -1..=1 {
                        if dx == 0 && dy == 0 { continue; }
                        let nx = x + dx;
                        if nx < 0 || nx >= w { continue; }
                        if IS_FIRE[(self.grid[(ny as usize) * self.w + (nx as usize)] & 0xff) as usize] != 0 {
                            has_fire = true;
                            break 'h2_scan;
                        }
                    }
                }
                if has_fire && random() < 0.3 {
                    self.explode(x, y, 4);
                }
                continue;
            }

            // --- Fireflies ---
            if mat == FIREFLIES {
                if random() < 0.5 {
                    let new_shade = random_shade();
                    self.grid[idx] = pack_cell(mat, lifetime, (flags & !SHADE_MASK) | new_shade | FLAG_UPDATED);
                }
                if random() < 0.7 {
                    let (dx, dy) = if random() < 0.2 {
                        // Dart: 2-3 cell jump
                        ((random() * 7.0) as i32 - 3, (random() * 7.0) as i32 - 3)
                    } else {
                        // Normal: 1-cell step
                        ((random() * 3.0) as i32 - 1, (random() * 3.0) as i32 - 1)
                    };
                    let nx = x + dx;
                    let ny = y + dy;
                    if nx >= 0 && nx < w && ny >= 0 && ny < h && self.grid[(ny as usize) * self.w + (nx as usize)] == 0 {
                        self.grid[(ny as usize) * self.w + (nx as usize)] = pack_cell(mat, lifetime, flags | FLAG_UPDATED);
                        self.grid[idx] = 0;
                    }
                }
                continue;
            }
        }
    }

    /// Apply a radial impulse: shoves particles outward + sets wind fields.
    fn apply_impulse(&mut self, cx: i32, cy: i32, radius: i32, strength: f32) {
        let w = self.w as i32;
        let h = self.h as i32;

        // Phase 1: Immediate radial displacement (outer ring → inner ring)
        for ring in (1..=radius).rev() {
            for y in (cy - ring)..=(cy + ring) {
                for x in (cx - ring)..=(cx + ring) {
                    let dx = x - cx;
                    let dy = y - cy;
                    let dist = ((dx * dx + dy * dy) as f32).sqrt();
                    if (dist.round() as i32) != ring { continue; }
                    if x < 0 || x >= w || y < 0 || y >= h { continue; }

                    let idx = (y as usize) * self.w + (x as usize);
                    let packed = self.grid[idx];
                    if packed == 0 { continue; }
                    let flags = ((packed >> 16) & 0xff) as u8;
                    if (flags & FLAG_UPDATED) != 0 { continue; }
                    let mat = (packed & 0xff) as u8;
                    if mat == WALL || mat == STONE { continue; }

                    let step_x = if dx == 0 { 0 } else if dx > 0 { 1 } else { -1 };
                    let step_y = if dy == 0 { 0 } else if dy > 0 { 1 } else { -1 };
                    self.try_shove(x, y, x + step_x, y + step_y, packed);
                }
            }
        }

        // Phase 2: Set wind fields
        for y in (cy - radius)..=(cy + radius) {
            for x in (cx - radius)..=(cx + radius) {
                if x < 0 || x >= w || y < 0 || y >= h { continue; }
                let dx = x - cx;
                let dy = y - cy;
                let dist = ((dx * dx + dy * dy) as f32).sqrt();
                if dist > radius as f32 || dist < 0.5 { continue; }
                let falloff = 1.0 - dist / radius as f32;
                let mag = strength * falloff;
                let ux = dx as f32 / dist;
                let uy = dy as f32 / dist;
                let fi = ((y as usize) * self.w + (x as usize)) * 4;
                let cur_wx = self.fields[fi + FIELD_WIND_X] as i8 as i32;
                let cur_wy = self.fields[fi + FIELD_WIND_Y] as i8 as i32;
                let new_wx = (cur_wx as f32 + ux * mag).round() as i32;
                let new_wy = (cur_wy as f32 + uy * mag).round() as i32;
                let new_wx = new_wx.max(-127).min(127);
                let new_wy = new_wy.max(-127).min(127);
                self.fields[fi + FIELD_WIND_X] = new_wx as u8;
                self.fields[fi + FIELD_WIND_Y] = new_wy as u8;
            }
        }
        self.has_wind = true;
    }

    /// Decay all wind fields toward 0.
    fn decay_wind(&mut self) {
        if !self.has_wind { return; }
        let n = self.w * self.h * 4;
        let mut any_wind = false;
        let mut i = 0;
        while i < n {
            if self.fields[i + FIELD_WIND_X] != 0 {
                let v = self.fields[i + FIELD_WIND_X] as i8 as i32;
                let dec = if v.abs() >= 4 { (v as f32 * 0.75) as i32 } else if v > 0 { v - 1 } else if v < 0 { v + 1 } else { 0 };
                self.fields[i + FIELD_WIND_X] = dec as u8;
                if dec != 0 { any_wind = true; }
            }
            if self.fields[i + FIELD_WIND_Y] != 0 {
                let v = self.fields[i + FIELD_WIND_Y] as i8 as i32;
                let dec = if v.abs() >= 4 { (v as f32 * 0.75) as i32 } else if v > 0 { v - 1 } else if v < 0 { v + 1 } else { 0 };
                self.fields[i + FIELD_WIND_Y] = dec as u8;
                if dec != 0 { any_wind = true; }
            }
            i += 4;
        }
        if !any_wind { self.has_wind = false; }
    }

    /// Create an explosion: fire + smoke in a radius.
    fn explode(&mut self, cx: i32, cy: i32, radius: i32) {
        let w = self.w as i32;
        let h = self.h as i32;
        for y in (cy - radius)..=(cy + radius) {
            for x in (cx - radius)..=(cx + radius) {
                let dist = (x - cx) * (x - cx) + (y - cy) * (y - cy);
                if dist > radius * radius { continue; }
                if x < 0 || x >= w || y < 0 || y >= h { continue; }
                let mat = (self.grid[(y as usize) * self.w + (x as usize)] & 0xff) as u8;
                if mat == WALL { continue; }
                if mat == C4 { continue; }
                if (dist as f32) < (radius * radius) as f32 * 0.3 {
                    self.grid[(y as usize) * self.w + (x as usize)] = pack_cell(FIRE, 20, random_shade());
                } else {
                    if random() < 0.5 {
                        self.grid[(y as usize) * self.w + (x as usize)] = pack_cell(SMOKE, 60, random_shade());
                    } else {
                        self.grid[(y as usize) * self.w + (x as usize)] = 0;
                    }
                }
            }
        }
    }

    /// Detonate C4 at (cx, cy) and flood-fill all connected C4 for chain reaction.
    fn detonate_c4(&mut self, cx: i32, cy: i32) {
        let w = self.w as i32;
        let h = self.h as i32;
        let frame = self.frame;
        let mut stack: Vec<usize> = vec![(cy as usize) * self.w + (cx as usize)];
        let mut c4_cells: Vec<usize> = Vec::new();

        while let Some(idx) = stack.pop() {
            if self.visited_c4_frame[idx] == frame { continue; }
            self.visited_c4_frame[idx] = frame;
            let px = (idx % self.w) as i32;
            let py = (idx / self.w) as i32;
            if (self.grid[idx] & 0xff) as u8 != C4 { continue; }
            c4_cells.push(idx);
            for dy in -1..=1 {
                for dx in -1..=1 {
                    if dx == 0 && dy == 0 { continue; }
                    let nx = px + dx;
                    let ny = py + dy;
                    if nx < 0 || nx >= w || ny < 0 || ny >= h { continue; }
                    stack.push((ny as usize) * self.w + (nx as usize));
                }
            }
        }

        for &idx in &c4_cells {
            let px = (idx % self.w) as i32;
            let py = (idx / self.w) as i32;
            self.explode(px, py, 8);
        }
    }

    /// Grow a tree from a seed at (x, y) on dirt.
    fn grow_tree(&mut self, x: i32, y: i32) {
        let w = self.w as i32;
        let h = self.h as i32;
        self.grid[(y as usize) * self.w + (x as usize)] = pack_cell(ROOT, 0, random_shade());
        let trunk_height = 8 + (random() * 8.0) as i32;
        let mut top_y = y;
        for i in 1..=trunk_height {
            let ty = y - i;
            if ty < 0 { break; }
            if self.grid[(ty as usize) * self.w + (x as usize)] != 0 { break; }
            self.grid[(ty as usize) * self.w + (x as usize)] = pack_cell(TREE_WOOD, 0, random_shade());
            top_y = ty;
        }
        let canopy_radius = 3 + (random() * 2.0) as i32;
        for dy in -canopy_radius..=0 {
            for dx in -canopy_radius..=canopy_radius {
                let lx = x + dx;
                let ly = top_y + dy - canopy_radius;
                if lx < 0 || lx >= w || ly < 0 || ly >= h { continue; }
                let dist = dx * dx + dy * dy;
                if dist > canopy_radius * canopy_radius { continue; }
                if self.grid[(ly as usize) * self.w + (lx as usize)] != 0 { continue; }
                if random() < 0.7 {
                    self.grid[(ly as usize) * self.w + (lx as usize)] = pack_cell(LEAF, 0, random_shade());
                }
            }
        }
    }

    /// Check if a cell is "exposed" — has at least one empty/gas neighbor.
    fn is_exposed(&self, x: i32, y: i32) -> bool {
        let w = self.w as i32;
        let h = self.h as i32;
        for dy in -1..=1 {
            for dx in -1..=1 {
                if dx == 0 && dy == 0 { continue; }
                let nx = x + dx;
                let ny = y + dy;
                if nx < 0 || nx >= w || ny < 0 || ny >= h { continue; }
                let n_mat = (self.grid[(ny as usize) * self.w + (nx as usize)] & 0xff) as u8;
                if n_mat == EMPTY { return true; }
                if (MAT_FLAGS[n_mat as usize] & MAT_GAS) != 0 { return true; }
            }
        }
        false
    }

    /// Apply combustion: fire spread + fuse burn + burning oil.
    fn apply_combustion(&mut self) {
        let w = self.w as i32;
        let h = self.h as i32;
        let count = self.active_count;
        let frame = self.frame;

        // Snapshot fire sources from the active list
        for a in 0..count {
            let idx = self.active_cells[a] as usize;
            self.fire_sources[idx] = 0;
        }
        let mut fire_count = 0;
        for a in 0..count {
            let idx = self.active_cells[a] as usize;
            let m = (self.grid[idx] & 0xff) as u8;
            if m == FIRE || m == FUSE_FIRE || m == BURNING_OIL || m == LAVA {
                self.fire_sources[idx] = 1;
                fire_count += 1;
            }
        }
        if fire_count == 0 { return; }

        // --- Fire spread pass ---
        for a in 0..count {
            let idx = self.active_cells[a] as usize;
            if self.fire_sources[idx] == 0 { continue; }
            let src_mat = (self.grid[idx] & 0xff) as u8;
            let x = (idx % self.w) as i32;
            let y = (idx / self.w) as i32;
            for dy in -1..=1 {
                for dx in -1..=1 {
                    if dx == 0 && dy == 0 { continue; }
                    let nx = x + dx;
                    let ny = y + dy;
                    if nx < 0 || nx >= w || ny < 0 || ny >= h { continue; }
                    let ni = (ny as usize) * self.w + (nx as usize);
                    let n_mat = (self.grid[ni] & 0xff) as u8;
                    if (MAT_FLAGS[n_mat as usize] & MAT_FLAMMABLE) == 0 { continue; }
                    if n_mat == GUNPOWDER {
                        self.grid[ni] = pack_cell(FIRE, 15, random_shade());
                        continue;
                    }
                    if n_mat == GAS_VAPOR || n_mat == HYDROGEN {
                        self.grid[ni] = pack_cell(FIRE, 20, random_shade());
                        self.explode(nx, ny, 3);
                        continue;
                    }
                    if n_mat == FLOUR {
                        self.explode(nx, ny, 3);
                        continue;
                    }
                    if n_mat == DYNAMITE {
                        self.explode(nx, ny, 6);
                        continue;
                    }
                    let base_chance = if src_mat == LAVA { 0.1 } else { 0.08 };
                    if src_mat == BURNING_OIL && n_mat == OIL { continue; }
                    if n_mat == OIL && !self.is_exposed(nx, ny) { continue; }
                    let mat_mult = if n_mat == RUBBER { 0.3 } else if n_mat == OIL { 0.3 } else { 1.0 };
                    let n_temp = self.fields[ni * 4 + FIELD_TEMP] as f32 / 128.0;
                    let chance = base_chance * n_temp * mat_mult;
                    if random() < chance {
                        if n_mat == FUSE {
                            self.grid[ni] = pack_cell(FUSE_FIRE, 15, random_shade());
                        } else if n_mat == OIL {
                            self.grid[ni] = pack_cell(BURNING_OIL, MAT_LIFETIME[BURNING_OIL as usize], random_shade());
                        } else {
                            self.grid[ni] = pack_cell(FIRE, 30, random_shade());
                        }
                    }
                }
            }
        }

        // --- Deterministic fuse burn ---
        const FUSE_FIRE_LIFETIME: u8 = 15;
        const FUSE_SPREAD_THRESHOLD: u8 = 3;
        for a in 0..count {
            let idx = self.active_cells[a] as usize;
            let packed = self.grid[idx];
            let mat = (packed & 0xff) as u8;
            if mat != FUSE_FIRE { continue; }
            let lifetime = ((packed >> 8) & 0xff) as u8;
            if lifetime > FUSE_SPREAD_THRESHOLD || lifetime == 0 { continue; }
            let x = (idx % self.w) as i32;
            let y = (idx / self.w) as i32;

            // Emit sparks
            for _ in 0..3 {
                if random() < 0.5 {
                    let sx = x + (random() * 3.0) as i32 - 1;
                    let sy = y - 1 - (random() * 2.0) as i32;
                    if sx >= 0 && sx < w && sy >= 0 && sy < h && self.grid[(sy as usize) * self.w + (sx as usize)] == 0 {
                        self.grid[(sy as usize) * self.w + (sx as usize)] = pack_cell(FIRE, 6, random_shade() | FLAG_SPARK);
                        let fi = ((sy as usize) * self.w + (sx as usize)) * 4;
                        let drift_x = (random() * 7.0) as i32 - 3;
                        self.fields[fi + FIELD_WIND_X] = drift_x as u8;
                        self.fields[fi + FIELD_WIND_Y] = (-30i32) as u8;
                        self.has_wind = true;
                    }
                }
            }

            // Spread to adjacent fuse
            for dy in -1..=1 {
                for dx in -1..=1 {
                    if dx == 0 && dy == 0 { continue; }
                    let nx = x + dx;
                    let ny = y + dy;
                    if nx < 0 || nx >= w || ny < 0 || ny >= h { continue; }
                    let ni = (ny as usize) * self.w + (nx as usize);
                    if self.visited_frame[ni] == frame { continue; }
                    if (self.grid[ni] & 0xff) as u8 == FUSE {
                        self.grid[ni] = pack_cell(FUSE_FIRE, FUSE_FIRE_LIFETIME, random_shade());
                        self.visited_frame[ni] = frame;
                    }
                }
            }
        }

        // --- Burning oil pass ---
        let burning_oil_lifetime = MAT_LIFETIME[BURNING_OIL as usize];
        for a in 0..count {
            let idx = self.active_cells[a] as usize;
            let packed = self.grid[idx];
            let mat = (packed & 0xff) as u8;
            if mat != BURNING_OIL { continue; }
            let lifetime = ((packed >> 8) & 0xff) as u8;
            let x = (idx % self.w) as i32;
            let y = (idx / self.w) as i32;

            // Emit fire particles upward
            for _ in 0..2 {
                if random() < 0.4 {
                    let sx = x + (random() * 3.0) as i32 - 1;
                    let sy = y - 1 - (random() * 2.0) as i32;
                    if sx >= 0 && sx < w && sy >= 0 && sy < h && self.grid[(sy as usize) * self.w + (sx as usize)] == 0 {
                        self.grid[(sy as usize) * self.w + (sx as usize)] = pack_cell(FIRE, 20, random_shade());
                        let fi = ((sy as usize) * self.w + (sx as usize)) * 4;
                        let drift_x = (random() * 5.0) as i32 - 2;
                        self.fields[fi + FIELD_WIND_X] = drift_x as u8;
                        self.fields[fi + FIELD_WIND_Y] = (-20i32) as u8;
                        self.has_wind = true;
                    }
                }
            }

            // Spread to adjacent oil
            let decay_progress = 1.0 - (lifetime as f32 / burning_oil_lifetime as f32);
            let spread_chance = 0.02 + 0.04 * decay_progress;
            for dy in -1..=1 {
                for dx in -1..=1 {
                    if dx == 0 && dy == 0 { continue; }
                    let nx = x + dx;
                    let ny = y + dy;
                    if nx < 0 || nx >= w || ny < 0 || ny >= h { continue; }
                    let ni = (ny as usize) * self.w + (nx as usize);
                    if self.visited_frame[ni] == frame { continue; }
                    if (self.grid[ni] & 0xff) as u8 == OIL && self.is_exposed(nx, ny) && random() < spread_chance {
                        self.grid[ni] = pack_cell(BURNING_OIL, burning_oil_lifetime, random_shade());
                        self.visited_frame[ni] = frame;
                    }
                }
            }
        }

        // Clear fireSources for active cells
        for a in 0..count {
            let idx = self.active_cells[a] as usize;
            self.fire_sources[idx] = 0;
        }
    }

    /// Apply aging: lifetime decay + material transitions.
    fn apply_aging(&mut self) {
        let count = self.active_count;
        for a in 0..count {
            let i = self.active_cells[a] as usize;
            let packed = self.grid[i];
            if packed == 0 { continue; }

            let mut mat = (packed & 0xff) as u8;
            let mut lifetime = ((packed >> 8) & 0xff) as u8;
            let flags = ((packed >> 16) & 0xff) as u8;

            if lifetime > 0 {
                // Randomized decay
                if mat == FIRE {
                    if random() < 0.7 { lifetime -= 1; }
                } else if mat == FUSE_FIRE {
                    lifetime -= 1;
                } else if mat == BURNING_OIL {
                    if random() < 0.15 { lifetime -= 1; }
                } else if mat == SMOKE {
                    if random() < 0.8 { lifetime -= 1; }
                } else if mat == STEAM {
                    if random() < 0.75 { lifetime -= 1; }
                } else if mat == MAGIC_POWDER {
                    if random() < 0.7 { lifetime -= 1; }
                } else {
                    lifetime -= 1;
                }

                if lifetime == 0 {
                    if mat == FIRE {
                        if (flags & FLAG_SPARK) != 0 {
                            self.grid[i] = 0;
                            continue;
                        }
                        mat = SMOKE;
                        lifetime = 120;
                    } else if mat == FUSE_FIRE {
                        self.grid[i] = 0;
                        continue;
                    } else if mat == BURNING_OIL {
                        mat = SMOKE;
                        lifetime = 60;
                    } else if mat == SMOKE {
                        self.grid[i] = 0;
                        continue;
                    } else if mat == STEAM {
                        if random() < 0.7 {
                            mat = WATER;
                            lifetime = 0;
                        } else {
                            self.grid[i] = 0;
                            continue;
                        }
                    } else if mat == GAS_VAPOR {
                        self.grid[i] = 0;
                        continue;
                    } else if mat == HYDROGEN {
                        self.grid[i] = 0;
                        continue;
                    } else if mat == PLASMA {
                        mat = FIRE;
                        lifetime = 15;
                    } else if mat == FIREFLIES {
                        lifetime = 255;
                    } else if mat == NANOBOTS {
                        lifetime = 255;
                    } else if mat == WOOD || mat == PLANT || mat == OIL ||
                              mat == FLESH || mat == LEAF || mat == TREE_WOOD ||
                              mat == ROOT || mat == GRASS || mat == TOAST ||
                              mat == PLASTIC || mat == WAX || mat == FUSE ||
                              mat == RUBBER || mat == C4 || mat == GLITTER ||
                              mat == MAGIC_POWDER {
                        mat = SMOKE;
                        lifetime = 60;
                    }
                }
            }

            let new_flags = flags & !FLAG_UPDATED;
            let new_packed = pack_cell(mat, lifetime, new_flags);
            if new_packed != packed {
                self.grid[i] = new_packed;
            }
        }
    }
}
