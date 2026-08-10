import { createDowndraftViteConfig } from "../../packages/app/src/vite/index";

export default createDowndraftViteConfig({
  root: __dirname,
  game: "falling-sand",
  simPaths: [],
  rendererPaths: [],
  excludePaths: [],
});
