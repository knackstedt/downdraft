import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { build } from "./build.ts";
import { exportGame } from "./export.ts";
import { init } from "./init.ts";

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

describe("CLI init", () => {
  beforeAll(() => {
    ensureCleanDir();
  });

  afterAll(() => {
    cleanup();
  });

  it("should scaffold a new project", async () => {
    await init(TEST_DIR);

    expect(existsSync(join(TEST_DIR, "package.json"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "src/main.ts"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "downdraft.config.json"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "assets/models"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "assets/textures"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "assets/shaders"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "scripts"))).toBe(true);
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
});

describe("CLI build", () => {
  beforeAll(async () => {
    ensureCleanDir();
    await init(TEST_DIR);
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
    await init(TEST_DIR);
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
