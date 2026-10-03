import { SandWorld } from "@downdraft/engine/libraries/sand";
import { generateMap } from "../../games/archery-game/src/simulation/map-gen";

const world = new SandWorld(1024, 512, 0);
generateMap(world, 12345, [944]);

const counts = new Map<number, number>();
for (let y = 300; y < 460; y += 3) {
  let line = "";
  for (let x = 320; x < 640; x += 3) {
    const m = world.grid[y * 1024 + x] & 0xff;
    line += String(m).padStart(4);
    counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  console.log(`y=${y}:`, line);
}
console.log("material counts:", [...counts.entries()].sort((a,b)=>a[0]-b[0]));
