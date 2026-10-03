import { SandWorld } from "@downdraft/engine/libraries/sand";
import { generateMap } from "../../games/archery-game/src/simulation/map-gen";

const world = new SandWorld(1024, 512, 0);
generateMap(world, 12345, [944]);
// Deep region only: x 60..700 stride 4, y 330..510 stride 3. Print ONLY dirt.
for (let y = 330; y < 510; y += 3) {
  let line = "";
  for (let x = 60; x < 700; x += 4) {
    const m = world.grid[y * 1024 + x] & 0xff;
    line += m === 14 ? "#" : " ";
  }
  console.log(line);
}
