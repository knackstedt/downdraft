//! Player physics — ported from `games/falling-sand/src/simulation/player.ts`.
//!
//! The player is a 3×7 box that moves through the grid with simple
//! platformer physics: gravity, horizontal acceleration, jumping,
//! swimming in liquids, and damage from hot materials.

use crate::materials::*;
use js_sys::Uint32Array;
use wasm_bindgen::prelude::*;

const PW: f32 = 3.0;
const PH: f32 = 7.0;
const GRAVITY: f32 = 0.08;
const MOVE_ACCEL: f32 = 0.12;
const MAX_SPEED: f32 = 0.6;
const FRICTION: f32 = 0.85;
const JUMP_FORCE: f32 = 0.55;
const MAX_FALL: f32 = 0.8;

#[wasm_bindgen]
pub struct PlayerState {
    pub(crate) x: f32,
    pub(crate) y: f32,
    pub(crate) vx: f32,
    pub(crate) vy: f32,
    pub(crate) on_ground: bool,
    pub(crate) facing: i32,
    pub(crate) anim_frame: i32,
    pub(crate) health: i32,
}

#[wasm_bindgen]
impl PlayerState {
    #[wasm_bindgen(constructor)]
    pub fn new(grid_w: usize, grid_h: usize) -> PlayerState {
        PlayerState {
            x: grid_w as f32 / 2.0,
            y: grid_h as f32 / 2.0 - PH,
            vx: 0.0,
            vy: 0.0,
            on_ground: false,
            facing: 1,
            anim_frame: 0,
            health: 100,
        }
    }

    pub fn update(
        &mut self,
        left: bool,
        right: bool,
        up: bool,
        down: bool,
        jump: bool,
        grid: &Uint32Array,
        w: usize,
        h: usize,
    ) {
        let grid_vec = grid.to_vec();
        self.update_inner(left, right, up, down, jump, &grid_vec, w, h);
    }

    // --- Getters ---

    #[wasm_bindgen(getter)]
    pub fn x(&self) -> f32 { self.x }
    #[wasm_bindgen(getter)]
    pub fn y(&self) -> f32 { self.y }
    #[wasm_bindgen(getter)]
    pub fn vx(&self) -> f32 { self.vx }
    #[wasm_bindgen(getter)]
    pub fn vy(&self) -> f32 { self.vy }
    #[wasm_bindgen(getter)]
    pub fn on_ground(&self) -> bool { self.on_ground }
    #[wasm_bindgen(getter)]
    pub fn facing(&self) -> i32 { self.facing }
    #[wasm_bindgen(getter)]
    pub fn anim_frame(&self) -> i32 { self.anim_frame }
    #[wasm_bindgen(getter)]
    pub fn health(&self) -> i32 { self.health }
}

impl PlayerState {
    fn update_inner(
        &mut self,
        left: bool,
        right: bool,
        up: bool,
        down: bool,
        jump: bool,
        grid: &[u32],
        w: usize,
        h: usize,
    ) {
        let liquid_count = count_liquid(grid, w, h, self.x, self.y);
        let in_liquid = liquid_count >= 2;
        let buoyancy = if in_liquid { 0.06f32.min(liquid_count as f32 * 0.008) } else { 0.0 };

        // Horizontal movement
        if left { self.vx -= MOVE_ACCEL; self.facing = -1; }
        if right { self.vx += MOVE_ACCEL; self.facing = 1; }
        if !left && !right { self.vx *= FRICTION; }
        self.vx = self.vx.max(-MAX_SPEED).min(MAX_SPEED);

        // Jump
        if jump && self.on_ground {
            self.vy = -JUMP_FORCE;
            self.on_ground = false;
        }
        // Swim
        if up && in_liquid { self.vy -= 0.05; }
        if down && in_liquid { self.vy += 0.05; }

        // Gravity
        self.vy += GRAVITY - buoyancy;
        if in_liquid { self.vy *= 0.92; }
        self.vy = self.vy.min(MAX_FALL);

        // Move X with collision
        let new_x = self.x + self.vx;
        if !box_hits_solid(grid, w, h, new_x, self.y) {
            self.x = new_x;
        } else {
            // Try stepping up 1 cell
            if self.on_ground && !box_hits_solid(grid, w, h, new_x, self.y - 1.0) {
                self.x = new_x;
                self.y -= 1.0;
            } else {
                self.vx = 0.0;
            }
        }

        // Clamp X
        if self.x < PW / 2.0 { self.x = PW / 2.0; self.vx = 0.0; }
        if self.x > w as f32 - PW / 2.0 - 1.0 { self.x = w as f32 - PW / 2.0 - 1.0; self.vx = 0.0; }

        // Move Y with collision
        let new_y = self.y + self.vy;
        if !box_hits_solid(grid, w, h, self.x, new_y) {
            self.y = new_y;
            self.on_ground = false;
        } else {
            if self.vy > 0.0 { self.on_ground = true; }
            self.vy = 0.0;
        }

        // Clamp Y
        if self.y < 0.0 { self.y = 0.0; self.vy = 0.0; }
        if self.y > h as f32 - PH { self.y = h as f32 - PH; self.vy = 0.0; self.on_ground = true; }

        // Animation
        if self.vx.abs() > 0.01 || !self.on_ground {
            self.anim_frame += 1;
        } else {
            self.anim_frame = 0;
        }

        // Damage from fire/lava contact
        let cx = self.x.floor() as i32;
        let _cy = (self.y + PH / 2.0).floor() as i32;
        let y0 = self.y.floor() as i32;
        for dy in 0..(PH as i32) {
            for dx in -1..=1 {
                let gx = cx + dx;
                let gy = y0 + dy;
                if gx < 0 || gx >= w as i32 || gy < 0 || gy >= h as i32 { continue; }
                let m = (grid[gy as usize * w + gx as usize] & 0xff) as u8;
                if m == FIRE || m == LAVA || m == PLASMA || m == FUSE_FIRE || m == BURNING_OIL {
                    self.health = (self.health - 1).max(0);
                }
            }
        }
    }
}

fn is_solid(grid: &[u32], w: usize, h: usize, x: i32, y: i32) -> bool {
    if x < 0 || x >= w as i32 || y < 0 || y >= h as i32 { return true; }
    let packed = grid[y as usize * w + x as usize];
    if packed == 0 { return false; }
    let mat = (packed & 0xff) as u8;
    (MAT_FLAGS[mat as usize] & MAT_SOLID) != 0
}

fn box_hits_solid(grid: &[u32], w: usize, h: usize, px: f32, py: f32) -> bool {
    let x0 = (px - PW / 2.0).floor() as i32;
    let x1 = (px + PW / 2.0).floor() as i32;
    let y0 = py.floor() as i32;
    let y1 = (py + PH - 1.0).floor() as i32;
    for y in y0..=y1 {
        for x in x0..=x1 {
            if is_solid(grid, w, h, x, y) { return true; }
        }
    }
    false
}

fn count_liquid(grid: &[u32], w: usize, h: usize, px: f32, py: f32) -> usize {
    let mut n = 0;
    let x0 = (px - PW / 2.0).floor() as i32;
    let x1 = (px + PW / 2.0).floor() as i32;
    let y0 = py.floor() as i32;
    let y1 = (py + PH - 1.0).floor() as i32;
    for y in y0..=y1 {
        for x in x0..=x1 {
            if x < 0 || x >= w as i32 || y < 0 || y >= h as i32 { continue; }
            let packed = grid[y as usize * w + x as usize];
            if packed == 0 { continue; }
            let mat = (packed & 0xff) as u8;
            if (MAT_FLAGS[mat as usize] & MAT_LIQUID) != 0 { n += 1; }
        }
    }
    n
}
