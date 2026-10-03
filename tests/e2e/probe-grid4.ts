import { SandWorld } from "@downdraft/engine/libraries/sand";
import { generateMap } from "../../games/archery-game/src/simulation/map-gen";

const world = new SandWorld(1024, 512, 0);
generateMap(world, 12345, [944]);
// Step the sim 300 ticks then diff materials vs before
const before = world.grid.slice();
for (let i = 0; i < 300; i++) world.step(1);
const counts = new Map<number, number>();
for (let i = 0; i < world.grid.length; i++) {
  const a = before[i] & 0xff, b = world.grid[i] & 0xff;
  if (a !== b) counts.set(b, (counts.get(b) ?? 0) + 1);
}
console.log("changed-to materials:", [...counts.entries()]);
// Where did LooseStone appear? Dump region x 200..600 y 300..500
for (let y = 300; y < 500; y += 3) {
  let line = "";
  for (let x = 200; x < 600; x += 4) {
    const m = world.grid[y * 1024 + x] & 0xff;
    line += m === 14 ? "d" : m === 3 ? " " : m === 0 ? "." : "?";
  }
  if (line.includes("?")) console.log(y, line);
}
console.log("done");
