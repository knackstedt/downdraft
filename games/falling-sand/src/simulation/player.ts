import { Material, MATERIALS } from "./materials";

export interface PlayerInput {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  jump: boolean;
}

export interface PlayerState {
  x: number; y: number; vx: number; vy: number;
  onGround: boolean; facing: number; animFrame: number; health: number;
}

const PW = 3, PH = 7;
const GRAVITY = 0.08, MOVE_ACCEL = 0.12, MAX_SPEED = 0.6;
const FRICTION = 0.85, JUMP_FORCE = 0.55, MAX_FALL = 0.8;

export function createPlayer(gridW: number, gridH: number): PlayerState {
  return { x: gridW / 2, y: gridH / 2 - PH, vx: 0, vy: 0, onGround: false, facing: 1, animFrame: 0, health: 100 };
}

function isSolid(grid: Uint32Array, W: number, H: number, x: number, y: number): boolean {
  if (x < 0 || x >= W || y < 0 || y >= H) return true;
  const packed = grid[y * W + x];
  if (packed === 0) return false;
  const def = MATERIALS[packed & 0xff];
  return !!def?.solid;
}

function boxHitsSolid(grid: Uint32Array, W: number, H: number, px: number, py: number): boolean {
  const x0 = Math.floor(px - PW / 2), x1 = Math.floor(px + PW / 2);
  const y0 = Math.floor(py), y1 = Math.floor(py + PH - 1);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++)
      if (isSolid(grid, W, H, x, y)) return true;
  return false;
}

function countLiquid(grid: Uint32Array, W: number, H: number, px: number, py: number): number {
  let n = 0;
  const x0 = Math.floor(px - PW / 2), x1 = Math.floor(px + PW / 2);
  const y0 = Math.floor(py), y1 = Math.floor(py + PH - 1);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      if (x < 0 || x >= W || y < 0 || y >= H) continue;
      const packed = grid[y * W + x];
      if (packed === 0) continue;
      if (MATERIALS[packed & 0xff]?.liquid) n++;
    }
  return n;
}

export function updatePlayer(p: PlayerState, input: PlayerInput, grid: Uint32Array, W: number, H: number): void {
  const liquidCount = countLiquid(grid, W, H, p.x, p.y);
  const inLiquid = liquidCount >= 2;
  const buoyancy = inLiquid ? Math.min(0.06, liquidCount * 0.008) : 0;

  // Horizontal movement
  if (input.left) { p.vx -= MOVE_ACCEL; p.facing = -1; }
  if (input.right) { p.vx += MOVE_ACCEL; p.facing = 1; }
  if (!input.left && !input.right) p.vx *= FRICTION;
  p.vx = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, p.vx));

  // Jump
  if (input.jump && p.onGround) {
    p.vy = -JUMP_FORCE;
    p.onGround = false;
  }
  // Swim up
  if (input.up && inLiquid) p.vy -= 0.05;
  if (input.down && inLiquid) p.vy += 0.05;

  // Gravity
  p.vy += GRAVITY - buoyancy;
  if (inLiquid) p.vy *= 0.92;
  p.vy = Math.min(MAX_FALL, p.vy);

  // Move X with collision
  const newX = p.x + p.vx;
  if (!boxHitsSolid(grid, W, H, newX, p.y)) {
    p.x = newX;
  } else {
    // Try stepping up 1 cell
    if (p.onGround && !boxHitsSolid(grid, W, H, newX, p.y - 1)) {
      p.x = newX;
      p.y -= 1;
    } else {
      p.vx = 0;
    }
  }

  // Clamp X to grid
  if (p.x < PW / 2) { p.x = PW / 2; p.vx = 0; }
  if (p.x > W - PW / 2 - 1) { p.x = W - PW / 2 - 1; p.vx = 0; }

  // Move Y with collision
  const newY = p.y + p.vy;
  if (!boxHitsSolid(grid, W, H, p.x, newY)) {
    p.y = newY;
    p.onGround = false;
  } else {
    if (p.vy > 0) p.onGround = true;
    p.vy = 0;
  }

  // Clamp Y
  if (p.y < 0) { p.y = 0; p.vy = 0; }
  if (p.y > H - PH) { p.y = H - PH; p.vy = 0; p.onGround = true; }

  // Animation
  if (Math.abs(p.vx) > 0.01 || !p.onGround) p.animFrame++;
  else p.animFrame = 0;

  // Damage from fire/lava contact
  const cx = Math.floor(p.x), cy = Math.floor(p.y + PH / 2);
  for (let dy = 0; dy < PH; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const gx = cx + dx, gy = Math.floor(p.y) + dy;
      if (gx < 0 || gx >= W || gy < 0 || gy >= H) continue;
      const m = grid[gy * W + gx] & 0xff;
      if (m === Material.Fire || m === Material.Lava || m === Material.Plasma || m === Material.FuseFire || m === Material.BurningOil) {
        p.health = Math.max(0, p.health - 1);
      }
    }
  }
}

export { PH, PW };

