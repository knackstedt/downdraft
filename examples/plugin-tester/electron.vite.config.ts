import { createDowndraftViteConfig } from "@downdraft/engine/app/vite";

export default createDowndraftViteConfig({
  root: __dirname,
  game: "plugin-tester",
});
