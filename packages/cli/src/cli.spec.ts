import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { legacyFileCopyBuild } from "./build";
import { packageLauncher } from "./export";
import { newProject } from "./new";
import { listTemplates } from "./scaffold";

const TEST_DIR = join(tmpdir(), "downdraft-cli-test");
const origCwd = process.cwd();

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
  // chdir to tmpdir so confinePath(process.cwd(), TEST_DIR) accepts the
  // absolute tmp path instead of rejecting it as outside the engine repo.
  process.chdir(tmpdir());
}

afterAll(() => {
  process.chdir(origCwd);
});

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
    expect(existsSync(join(TEST_DIR, "tsconfig.json"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "electron.vite.config.ts"))).toBe(true);
  });

  it("should write valid package.json", async () => {
    const pkg = JSON.parse(readFileSync(join(TEST_DIR, "package.json"), "utf-8"));
    expect(pkg.name).toBe("my-game");
    expect(pkg.type).toBe("module");
    expect(pkg.dependencies["@downdraft/core"]).toBe("^0.1.0");
    expect(pkg.scripts.dev).toBe("draft dev");
    expect(pkg.scripts.build).toBe("draft release --stage=build");
    expect(pkg.scripts.export).toBe("draft release --stage=package --format=launcher");
    expect(pkg.scripts.dist).toBe("draft release");
    expect(pkg.scripts.release).toBe("draft release");
    expect(pkg.scripts.mobile).toBe("draft release --target=android,ios");
    expect(pkg.scripts.typecheck).toBe("tsc --noEmit");
    expect(pkg.scripts.lint).toBe("oxlint");
    expect(pkg.scripts.test).toBe("npm test");
    expect(pkg.scripts.postinstall).toBe("node node_modules/electron/install.js");
  });

  it("should preconfigure electron-builder in package.json", async () => {
    const pkg = JSON.parse(readFileSync(join(TEST_DIR, "package.json"), "utf-8"));
    expect(pkg.build).toBeDefined();
    expect(pkg.build.appId).toBe("com.my-game.game");
    expect(pkg.build.productName).toBe("My Game");
    expect(pkg.build.directories.output).toBe("release");
    expect(pkg.build.files).toContain("dist/**/*");
    expect(pkg.build.win.target).toContain("portable");
    expect(pkg.build.linux.target).toContain("AppImage");
    expect(pkg.build.linux.target).toContain("deb");
    expect(pkg.build.linux.target).toContain("rpm");
    expect(pkg.build.linux.target).toContain("flatpak");
    expect(pkg.build.deb.depends).toContain("libgtk-3-0");
    expect(pkg.build.flatpak.base).toBe("org.electronjs.Electron2.BaseApp");
  });

  it("should include copyright + author object when --author is provided", async () => {
    // Re-scaffold with --author and --description into a fresh dir.
    const authorDir = join(tmpdir(), "downdraft-cli-test-author");
    try { rmSync(authorDir, { recursive: true, force: true }); } catch {}
    mkdirSync(authorDir, { recursive: true });
    process.chdir(tmpdir());
    await newProject([
      authorDir,
      "--template=minimal",
      "--name=my-game",
      "--author=Jane Developer",
      "--description=A test game",
    ]);

    const pkg = JSON.parse(readFileSync(join(authorDir, "package.json"), "utf-8"));
    // author is written as an object so electron-builder's AppInfo.companyName
    // (which reads metadata.author.name) resolves correctly.
    expect(pkg.author).toEqual({ name: "Jane Developer" });
    expect(pkg.description).toBe("A test game");
    // copyright is derived from author + current year in the build config.
    expect(pkg.build.copyright).toBeDefined();
    expect(pkg.build.copyright).toContain("Jane Developer");
    expect(pkg.build.copyright).toContain("Copyright");

    try { rmSync(authorDir, { recursive: true, force: true }); } catch {}
  });

  it("should include builder devDependencies", async () => {
    const pkg = JSON.parse(readFileSync(join(TEST_DIR, "package.json"), "utf-8"));
    expect(pkg.devDependencies).toBeDefined();
    expect(pkg.devDependencies["electron"]).toBeDefined();
    expect(pkg.devDependencies["electron-builder"]).toBeDefined();
    expect(pkg.devDependencies["electron-vite"]).toBeDefined();
    expect(pkg.devDependencies["vite"]).toBeDefined();
    expect(pkg.devDependencies["typescript"]).toBeDefined();
    expect(pkg.devDependencies["oxlint"]).toBeDefined();
    expect(pkg.devDependencies["@downdraft/app"]).toBe("^0.1.0");
    expect(pkg.devDependencies["@downdraft/cli"]).toBe("^0.1.0");
  });

  it("should scaffold .vscode config files", async () => {
    expect(existsSync(join(TEST_DIR, ".vscode", "extensions.json"))).toBe(true);
    expect(existsSync(join(TEST_DIR, ".vscode", "settings.json"))).toBe(true);
    expect(existsSync(join(TEST_DIR, ".vscode", "tasks.json"))).toBe(true);
  });

  it("should write valid extensions.json with recommendations", async () => {
    const ext = JSON.parse(readFileSync(join(TEST_DIR, ".vscode", "extensions.json"), "utf-8"));
    expect(Array.isArray(ext.recommendations)).toBe(true);
    expect(ext.recommendations).toContain("oxc.oxc-vscode");
    expect(ext.recommendations).toContain("wgsl-analyzer.wgsl-analyzer");
    expect(ext.recommendations).toContain("antaalt.shader-validator");
  });

  it("should write valid settings.json", async () => {
    const settings = JSON.parse(readFileSync(join(TEST_DIR, ".vscode", "settings.json"), "utf-8"));
    expect(settings["explorer.fileNesting.enabled"]).toBe(true);
    expect(settings["files.associations"]["*.wgsl"]).toBe("wgsl");
  });

  it("should write valid tasks.json with draft CLI and QA tasks", async () => {
    const tasks = JSON.parse(readFileSync(join(TEST_DIR, ".vscode", "tasks.json"), "utf-8"));
    expect(tasks.version).toBe("2.0.0");
    const labels = tasks.tasks.map((t: any) => t.label);
    expect(labels).toContain("Dev");
    expect(labels).toContain("Release");
    expect(labels).toContain("Build Only");
    expect(labels).toContain("Typecheck");
    expect(labels).toContain("Lint");
    expect(labels).toContain("Test");
    const devTask = tasks.tasks.find((t: any) => t.label === "Dev");
    expect(devTask.command).toBe("draft dev");
    expect(devTask.group.isDefault).toBe(true);
    const inputs = tasks.inputs.map((i: any) => i.id);
    expect(inputs).toContain("releaseTarget");
    expect(inputs).toContain("buildMode");
  });

  it("should write valid tsconfig.json", async () => {
    const tsconfig = JSON.parse(readFileSync(join(TEST_DIR, "tsconfig.json"), "utf-8"));
    expect(tsconfig.compilerOptions.target).toBe("ESNext");
    expect(tsconfig.compilerOptions.noEmit).toBe(true);
    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.include).toContain("src");
  });

  it("should write valid downdraft.config.json", async () => {
    const config = JSON.parse(readFileSync(join(TEST_DIR, "downdraft.config.json"), "utf-8"));
    expect(config.engine).toBe("downdraft");
    expect(config.name).toBe("my-game");
    expect(config.builder.mode).toBe("dev");
  });

  it("should write main.ts with a startGame() entry", async () => {
    const main = readFileSync(join(TEST_DIR, "src/main.ts"), "utf-8");
    expect(main).toContain("startGame");
    expect(main).toContain("onReady");
    expect(main).toContain("onDispose");
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
    expect(existsSync(join(TEST_DIR, ".vscode", "tasks.json"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "tsconfig.json"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "electron.vite.config.ts"))).toBe(true);
  });

  it("should include physics-rapier dependency", async () => {
    const pkg = JSON.parse(readFileSync(join(TEST_DIR, "package.json"), "utf-8"));
    expect(pkg.dependencies["@downdraft/library-physics-rapier"]).toBe("^0.1.0");
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
    expect(existsSync(join(TEST_DIR, ".vscode", "extensions.json"))).toBe(true);
    expect(existsSync(join(TEST_DIR, ".vscode", "tasks.json"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "tsconfig.json"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "electron.vite.config.ts"))).toBe(true);
    // full template includes a build.config.ts for branded packaging via `draft dist`.
    expect(existsSync(join(TEST_DIR, "build.config.ts"))).toBe(true);
  });

  it("should use draft release in the full template dist script", async () => {
    const pkg = JSON.parse(readFileSync(join(TEST_DIR, "package.json"), "utf-8"));
    expect(pkg.scripts.dist).toBe("draft release");
  });

  it("should reference createDowndraftBuilderConfig in build.config.ts", async () => {
    const cfg = readFileSync(join(TEST_DIR, "build.config.ts"), "utf-8");
    expect(cfg).toContain("createDowndraftBuilderConfig");
    expect(cfg).toContain("@downdraft/app/build");
    expect(cfg).toContain("full-game");
  });

  it("should include all plugin dependencies", async () => {
    const pkg = JSON.parse(readFileSync(join(TEST_DIR, "package.json"), "utf-8"));
    expect(pkg.dependencies["@downdraft/library-water"]).toBe("^0.1.0");
    expect(pkg.dependencies["@downdraft/library-physics-rapier"]).toBe("^0.1.0");
    expect(pkg.dependencies["@downdraft/library-marching-cubes"]).toBe("^0.1.0");
    expect(pkg.dependencies["@downdraft/library-models"]).toBe("^0.1.0");
    expect(pkg.dependencies["@downdraft/module-devtools"]).toBe("^0.1.0");
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
    expect(prompt).toContain("Module System");
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
    await legacyFileCopyBuild([TEST_DIR, "--out=dist"]);

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
    await legacyFileCopyBuild([TEST_DIR, "--out=dist"]);
  });

  afterAll(() => {
    cleanup();
  });

  it("should export for all platforms", async () => {
    await packageLauncher(TEST_DIR, "all", "export", false, false);

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

describe("CLI --help and --version", () => {
  it("export --target rejects old 'windows' value", async () => {
    // The normalized vocabulary is win/linux/mac/all.
    // 'windows' should be rejected by enum validation.
    const { ArgError, parseArgs } = await import("./args");
    expect(() =>
      parseArgs(["--target=windows"], {
        flags: [{ name: "target", type: "string", enum: ["win", "linux", "mac", "all"] }],
      }),
    ).toThrow(ArgError);
  });

  it("export --target accepts 'win' value", async () => {
    const { parseArgs } = await import("./args");
    const r = parseArgs(["--target=win"], {
      flags: [{ name: "target", type: "string", enum: ["win", "linux", "mac", "all"] }],
    });
    expect(r.flags.target).toBe("win");
  });

  it("test --renderer rejects invalid value", async () => {
    const { ArgError, parseArgs } = await import("./args");
    expect(() =>
      parseArgs(["--renderer=foo"], {
        flags: [{ name: "renderer", type: "string", enum: ["gpu", "cpu"] }],
      }),
    ).toThrow(ArgError);
  });

  it("test --renderer accepts 'cpu' and 'gpu'", async () => {
    const { parseArgs } = await import("./args");
    expect(
      parseArgs(["--renderer=cpu"], {
        flags: [{ name: "renderer", type: "string", enum: ["gpu", "cpu"] }],
      }).flags.renderer,
    ).toBe("cpu");
    expect(
      parseArgs(["--renderer=gpu"], {
        flags: [{ name: "renderer", type: "string", enum: ["gpu", "cpu"] }],
      }).flags.renderer,
    ).toBe("gpu");
  });

  it("parseArgs returns help=true for --help", async () => {
    const { parseArgs } = await import("./args");
    expect(
      parseArgs(["--help"], {
        flags: [{ name: "game", type: "string" }],
      }).help,
    ).toBe(true);
  });

  it("parseArgs returns help=true for -h", async () => {
    const { parseArgs } = await import("./args");
    expect(
      parseArgs(["-h"], {
        flags: [{ name: "game", type: "string" }],
      }).help,
    ).toBe(true);
  });

  it("renderTopLevelHelp lists all commands", async () => {
    const { renderTopLevelHelp } = await import("./usage");
    const help = renderTopLevelHelp("0.1.0");
    expect(help).toContain("Usage: draft <command>");
    expect(help).toContain("new");
    expect(help).toContain("dev");
    expect(help).toContain("release");
    expect(help).toContain("test");
    expect(help).toContain("assets");
    expect(help).toContain("mobile");
    expect(help).toContain("--version");
  });

  it("getCommand returns undefined for unknown command", async () => {
    const { getCommand } = await import("./usage");
    expect(getCommand("nonexistent")).toBeUndefined();
    expect(getCommand("test")?.name).toBe("test");
  });
});
