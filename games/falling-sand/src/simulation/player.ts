import { Material, MATERIALS } from "@downdraft/library-sand";
import { createGridCharacterController, type GridCharacterWorld } from "@downdraft/module-movement-2d";

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

// Materials that burn the player on contact (1 dmg/tick per overlapping cell).
const HOT = new Set<number>([
  Material.Fire, Material.Lava, Material.Plasma, Material.FuseFire, Material.BurningOil,
]);

const controller = createGridCharacterController({
  width: PW,
  height: PH,
  gravity: 0.08,
  moveAccel: 0.12,
  maxSpeed: 0.6,
  friction: 0.85,
  jumpForce: 0.55,
  maxFall: 0.8,
  stepUp: 1,
  swim: {},
});

export function createPlayer(gridW: number, gridH: number): PlayerState {
  return { x: gridW / 2, y: gridH / 2 - PH, vx: 0, vy: 0, onGround: false, facing: 1, animFrame: 0, health: 100 };
}

/** Grid world adapter over the packed-material grid. */
export function gridWorld(grid: Uint32Array, W: number, H: number): GridCharacterWorld {
  return {
    w: W,
    h: H,
    isSolid(x, y) {
      if (x < 0 || x >= W || y < 0 || y >= H) return true;
      const packed = grid[y * W + x];
      if (packed === 0) return false;
      return !!MATERIALS[packed & 0xff]?.solid;
    },
    isLiquid(x, y) {
      if (x < 0 || x >= W || y < 0 || y >= H) return false;
      const packed = grid[y * W + x];
      if (packed === 0) return false;
      return !!MATERIALS[packed & 0xff]?.liquid;
    },
    damageAt(x, y) {
      if (x < 0 || x >= W || y < 0 || y >= H) return 0;
      const packed = grid[y * W + x];
      if (packed === 0) return 0;
      return HOT.has(packed & 0xff) ? 1 : 0;
    },
  };
}

export function updatePlayer(p: PlayerState, input: PlayerInput, grid: Uint32Array, W: number, H: number): void {
  controller.update(p, input, gridWorld(grid, W, H));
}

export { PH, PW };
