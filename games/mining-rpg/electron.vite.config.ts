import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createDowndraftViteConfig } from "../../packages/app/src/vite/index";
import buildOptions from "./vite-options";

// electron-vite transpiles this config to a temp .mjs in the workspace root,
// so ESM `import "vite-plugin-solid"` would resolve from root node_modules
// (where it doesn't exist). We use createRequire relative to this file's
// directory to resolve it from the game's node_modules instead.
const req = createRequire(resolve(__dirname, "package.json"));
const solid = req("vite-plugin-solid");

export default createDowndraftViteConfig({
  root: __dirname,
  game: "mining-rpg",
  ...buildOptions(solid),
});
