import { SandWorld, buildPalette, buildMaterialProps } from "@downdraft/engine/libraries/sand";
import { generateMap } from "../../games/archery-game/src/simulation/map-gen";
import { writeFileSync } from "fs";

const world = new SandWorld(1024, 512, 0);
generateMap(world, 12345, [944]);
const pal = buildPalette();
const props = buildMaterialProps();
const img = new Uint8Array(1024 * 512 * 3);
const horizon = 512 * 0.4;
for (let y = 0; y < 512; y++) {
  for (let x = 0; x < 1024; x++) {
    const packed = world.grid[y * 1024 + x];
    const mat = packed & 0xff, shade = (packed >> 16) & 3;
    const o = (y * 1024 + x) * 3;
    if (mat === 0) { img[o] = 80; img[o + 1] = 120; img[o + 2] = 200; continue; }
    const pi = (mat * 4 + shade) * 4;
    const depthT = Math.max(0, Math.min(1, (y - horizon) / (512 * 0.5)));
    const ds = 1.0 - 0.45 * (depthT * 0.6);
    const br = props[mat * 4 + 2] / 255;
    img[o] = pal[pi] * br * ds;
    img[o + 1] = pal[pi + 1] * br * ds;
    img[o + 2] = pal[pi + 2] * br * ds;
  }
}
// Write PPM
const hdr = Buffer.from(`P6\n1024 512\n255\n`);
writeFileSync("/var/tmp/grid-render.ppm", Buffer.concat([hdr, Buffer.from(img)]));
console.log("wrote /var/tmp/grid-render.ppm");
