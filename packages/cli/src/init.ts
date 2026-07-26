import { createLogger } from "@downdraft/core";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const log = createLogger();

export async function init(targetPath: string): Promise<void> {
  log.info("DownDraft", `Scaffolding new game project at: ${targetPath}`);

  await mkdir(join(targetPath, "scripts"), { recursive: true });
  await mkdir(join(targetPath, "assets", "models"), { recursive: true });
  await mkdir(join(targetPath, "assets", "textures"), { recursive: true });
  await mkdir(join(targetPath, "assets", "shaders"), { recursive: true });
  await mkdir(join(targetPath, "src"), { recursive: true });

  const packageJson = {
    name: "my-game",
    version: "0.1.0",
    type: "module",
    scripts: {
      dev: "draft dev",
      build: "draft build",
      export: "draft export",
    },
    dependencies: {
      "@downdraft/core": "workspace:*",
    },
  };

  await writeFile(join(targetPath, "package.json"), JSON.stringify(packageJson, null, 2));

  const mainScript = `import { World, MeshBuilder, Camera, createLogger } from "@downdraft/core";

const log = createLogger();

export function init(ctx) {
  const world = new World();
  const camera = new Camera();
  camera.setAspect(16, 9);
  ctx.registerResource("camera", camera);
  log.info("game", "initialized");
}

export function tick(ctx, dt) {
  // Game logic here
}

export function dispose(ctx) {
  log.info("game", "disposed");
}
`;

  await writeFile(join(targetPath, "src/main.ts"), mainScript);

  const config = {
    name: "my-game",
    version: "0.1.0",
    engine: "downdraft",
    builder: {
      mode: "dev",
    },
  };

  await writeFile(join(targetPath, "downdraft.config.json"), JSON.stringify(config, null, 2));

  log.info("DownDraft", "Project scaffolded successfully!");
  log.info("DownDraft", `  cd ${targetPath}`);
  log.info("DownDraft", `  draft dev`);
}
