import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { build } from "./build";
import { exportGame } from "./export";
import { newProject } from "./new";
import { listTemplates } from "./scaffold";

const TEST_DIR = join(tmpdir(), "downdraft-cli-test");

function cleanup() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

function ensureCleanDir() {
  cleanup();
  if (!existsSync(TEST_DIR)) {
    mkdirSync(TEST_DIR, { recursive: true });
  }
}

describe("CLI new — minimal template", () => {
  beforeAll(() => {
    ensureCleanDir();
  });

  afterAll(() => {
    cleanup();
  });

  it("should scaffold a minimal project", async () => {
    await newProject([TEST_DIR, "--template=minimal", "--name=my-game"]);

    expect(existsSync(join(TEST_DIR, "package.json"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "src/main.ts"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "downdraft.config.json"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "README.md"))).toBe(true);
    expect(existsSync(join(TEST_DIR, ".gitignore"))).toBe(true);
  });

  it("should write valid package.json", async () => {
    const pkg = JSON.parse(readFileSync(join(TEST_DIR, "package.json"), "utf-8"));
    expect(pkg.name).toBe("my-game");
    expect(pkg.type).toBe("module");
    expect(pkg.dependencies["@downdraft/core"]).toBe("workspace:*");
    expect(pkg.scripts.dev).toBe("draft dev");
    expect(pkg.scripts.build).toBe("draft build");
  });

  it("should write valid downdraft.config.json", async () => {
    const config = JSON.parse(readFileSync(join(TEST_DIR, "downdraft.config.json"), "utf-8"));
    expect(config.engine).toBe("downdraft");
    expect(config.name).toBe("my-game");
    expect(config.builder.mode).toBe("dev");
  });

  it("should write main.ts with init/tick/dispose functions", async () => {
    const main = readFileSync(join(TEST_DIR, "src/main.ts"), "utf-8");
    expect(main).toContain("init");
    expect(main).toContain("tick");
    expect(main).toContain("dispose");
  });

  it("should not scaffold AI companion files by default", async () => {
    expect(existsSync(join(TEST_DIR, ".devin"))).toBe(false);
    expect(existsSync(join(TEST_DIR, "engine-prompt.md"))).toBe(false);
  });
});

describe("CLI new — physics template", () => {
  beforeAll(() => {
    ensureCleanDir();
  });

  afterAll(() => {
    cleanup();
  });

  it("should scaffold a physics project", async () => {
    await newProject([TEST_DIR, "--template=physics", "--name=physics-game"]);

    expect(existsSync(join(TEST_DIR, "package.json"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "src/main.ts"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "downdraft.config.json"))).toBe(true);
  });

  it("should include physics-rapier dependency", async () => {
    const pkg = JSON.parse(readFileSync(join(TEST_DIR, "package.json"), "utf-8"));
    expect(pkg.dependencies["@downdraft/plugin-physics-rapier"]).toBe("workspace:*");
  });

  it("should include physics-rapier plugin in config", async () => {
    const config = JSON.parse(readFileSync(join(TEST_DIR, "downdraft.config.json"), "utf-8"));
    expect(config.plugins).toContain("physics-rapier");
  });

  it("should write main.ts with physics imports", async () => {
    const main = readFileSync(join(TEST_DIR, "src/main.ts"), "utf-8");
    expect(main).toContain("RigidBody");
    expect(main).toContain("Collider");
    expect(main).toContain("PhysicsTransform");
  });
});

describe("CLI new — full template", () => {
  beforeAll(() => {
    ensureCleanDir();
  });

  afterAll(() => {
    cleanup();
  });

  it("should scaffold a full project", async () => {
    await newProject([TEST_DIR, "--template=full", "--name=full-game"]);

    expect(existsSync(join(TEST_DIR, "package.json"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "src/main.ts"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "src/systems"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "src/entities"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "assets/shaders"))).toBe(true);
  });

  it("should include all plugin dependencies", async () => {
    const pkg = JSON.parse(readFileSync(join(TEST_DIR, "package.json"), "utf-8"));
    expect(pkg.dependencies["@downdraft/plugin-water"]).toBe("workspace:*");
    expect(pkg.dependencies["@downdraft/plugin-physics-rapier"]).toBe("workspace:*");
    expect(pkg.dependencies["@downdraft/plugin-marching-cubes"]).toBe("workspace:*");
    expect(pkg.dependencies["@downdraft/plugin-models"]).toBe("workspace:*");
    expect(pkg.dependencies["@downdraft/plugin-devtools"]).toBe("workspace:*");
  });

  it("should include all plugins in config", async () => {
    const config = JSON.parse(readFileSync(join(TEST_DIR, "downdraft.config.json"), "utf-8"));
    expect(config.plugins).toContain("physics-rapier");
    expect(config.plugins).toContain("water");
    expect(config.plugins).toContain("marching-cubes");
    expect(config.plugins).toContain("models");
    expect(config.plugins).toContain("devtools");
  });
});

describe("CLI new — AI companion", () => {
  beforeAll(() => {
    ensureCleanDir();
  });

  afterAll(() => {
    cleanup();
  });

  it("should scaffold AI companion files with --ai-companion", async () => {
    await newProject([TEST_DIR, "--template=minimal", "--name=my-game", "--ai-companion"]);

    expect(existsSync(join(TEST_DIR, ".devin/config.json"))).toBe(true);
    expect(existsSync(join(TEST_DIR, ".devin/rules/logging.md"))).toBe(true);
    expect(existsSync(join(TEST_DIR, ".devin/rules/loops.md"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "engine-prompt.md"))).toBe(true);
  });

  it("should write valid MCP config", async () => {
    const config = JSON.parse(readFileSync(join(TEST_DIR, ".devin/config.json"), "utf-8"));
    expect(config.mcpServers.downdraft).toBeDefined();
    expect(config.mcpServers.downdraft.command).toBe("bun");
  });

  it("should write engine prompt with API reference", async () => {
    const prompt = readFileSync(join(TEST_DIR, "engine-prompt.md"), "utf-8");
    expect(prompt).toContain("DownDraft Engine");
    expect(prompt).toContain("ECS");
    expect(prompt).toContain("Plugin System");
  });
});

describe("CLI new — template listing", () => {
  it("should list available templates", () => {
    const templates = listTemplates();
    expect(templates).toContain("minimal");
    expect(templates).toContain("physics");
    expect(templates).toContain("full");
  });
});

describe("CLI build", () => {
  beforeAll(async () => {
    ensureCleanDir();
    await newProject([TEST_DIR, "--template=minimal", "--name=my-game"]);
  });

  afterAll(() => {
    cleanup();
  });

  it("should build the project", async () => {
    await build([TEST_DIR, "--out=dist"]);

    const distDir = join(TEST_DIR, "dist");
    expect(existsSync(distDir)).toBe(true);
    expect(existsSync(join(distDir, "manifest.json"))).toBe(true);
    expect(existsSync(join(distDir, "package.json"))).toBe(true);
    expect(existsSync(join(distDir, "src"))).toBe(true);
  });

  it("should write valid manifest.json", async () => {
    const manifest = JSON.parse(readFileSync(join(TEST_DIR, "dist/manifest.json"), "utf-8"));
    expect(manifest.name).toBe("my-game");
    expect(manifest.mode).toBe("prod");
    expect(manifest.files).toBeDefined();
    expect(manifest.builtAt).toBeDefined();
  });

  it("should copy source files", async () => {
    expect(existsSync(join(TEST_DIR, "dist/src/main.ts"))).toBe(true);
  });
});

describe("CLI export", () => {
  beforeAll(async () => {
    ensureCleanDir();
    await newProject([TEST_DIR, "--template=minimal", "--name=my-game"]);
    await build([TEST_DIR, "--out=dist"]);
  });

  afterAll(() => {
    cleanup();
  });

  it("should export for all platforms", async () => {
    await exportGame([TEST_DIR, "--target=all", "--out=export"]);

    const exportDir = join(TEST_DIR, "export");
    expect(existsSync(join(exportDir, "windows"))).toBe(true);
    expect(existsSync(join(exportDir, "macos"))).toBe(true);
    expect(existsSync(join(exportDir, "linux"))).toBe(true);
    expect(existsSync(join(exportDir, "export-summary.json"))).toBe(true);
  });

  it("should write platform-specific launchers", async () => {
    expect(existsSync(join(TEST_DIR, "export/windows/my-game.bat"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "export/linux/my-game"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "export/macos/my-game"))).toBe(true);
  });

  it("should write platform.json for each platform", async () => {
    const winPlatform = JSON.parse(readFileSync(join(TEST_DIR, "export/windows/platform.json"), "utf-8"));
    expect(winPlatform.platform).toBe("windows");
    expect(winPlatform.runtime).toBe("bun");
  });

  it("should write export-summary.json", async () => {
    const summary = JSON.parse(readFileSync(join(TEST_DIR, "export/export-summary.json"), "utf-8"));
    expect(summary.platforms).toEqual(["windows", "macos", "linux"]);
    expect(summary.exportedAt).toBeDefined();
  });
});
