import { SandWorld } from "@downdraft/engine/libraries/sand";
import { generateMap } from "../../games/archery-game/src/simulation/map-gen";

const world = new SandWorld(1024, 512, 0);
generateMap(world, 12345, [944]);
// ASCII map: . air, g grass, d dirt, s stone, # castle
for (let y = 150; y < 470; y += 4) {
  let line = "";
  for (let x = 0; x < 1024; x += 8) {
    const m = world.grid[y * 1024 + x] & 0xff;
    line += m === 0 ? " " : m === 14 ? "d" : m === 3 ? "s" : m === 6 ? "g" : m >= 200 ? "#" : "?";
  }
  console.log(line);
}
