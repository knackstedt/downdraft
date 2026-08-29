import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Jimp } from "jimp";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyOverrides, ensureMobileEntry, generateMobileEntryStub, patchShell } from "./mobile";
import { generateIcons } from "./mobile-icons";

// ---------------------------------------------------------------------------
// Helpers: create a mock shell directory structure for testing
// ---------------------------------------------------------------------------

function createMockShell(shellDir: string): void {
  // Android
  mkdirSync(join(shellDir, "android/app/src/main/java/com/downdraft/shell"), { recursive: true });
  mkdirSync(join(shellDir, "android/app/src/main/java/com/downdraft/embeddedserver"), { recursive: true });
  mkdirSync(join(shellDir, "android/app/src/main/res/values"), { recursive: true });

  writeFileSync(
    join(shellDir, "android/app/build.gradle"),
    `apply plugin: 'com.android.application'\nandroid {\n    namespace = "com.downdraft.shell"\n    defaultConfig {\n        applicationId "__APP_ID__"\n    }\n}\ndependencies {\n    implementation project(':capacitor-android')\n}\n`,
  );
  writeFileSync(
    join(shellDir, "android/app/src/main/res/values/strings.xml"),
    `<?xml version='1.0' encoding='utf-8'?>\n<resources>\n    <string name="app_name">__APP_NAME__</string>\n    <string name="title_activity_main">__APP_NAME__</string>\n    <string name="package_name">__APP_ID__</string>\n    <string name="custom_url_scheme">__APP_ID__</string>\n</resources>\n`,
  );
  writeFileSync(
    join(shellDir, "android/app/src/main/java/com/downdraft/shell/MainActivity.java"),
    `package com.downdraft.shell;\npublic class MainActivity extends BridgeActivity {\n    private static final int SERVER_PORT = __SERVER_PORT__;\n}\n`,
  );
  writeFileSync(
    join(shellDir, "android/app/src/main/AndroidManifest.xml"),
    `<?xml version="1.0" encoding="utf-8"?>\n<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n    <application android:label="@string/app_name">\n        <activity android:name=".MainActivity" />\n    </application>\n    <uses-permission android:name="android.permission.INTERNET" />\n</manifest>\n`,
  );

  // iOS
  mkdirSync(join(shellDir, "ios/App/App"), { recursive: true });
  mkdirSync(join(shellDir, "ios/App/App.xcodeproj"), { recursive: true });

  writeFileSync(
    join(shellDir, "ios/App/App/AppDelegate.swift"),
    `class AppDelegate {\n    private let serverPort: Int = __SERVER_PORT__\n}\n`,
  );
  writeFileSync(
    join(shellDir, "ios/App/App/SceneDelegate.swift"),
    `class SceneDelegate {\n    private let serverPort: Int = __SERVER_PORT__\n}\n`,
  );
  writeFileSync(
    join(shellDir, "ios/App/App/Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n    <key>CFBundleDisplayName</key>\n    <string>__APP_NAME__</string>\n    <key>CFBundleIdentifier</key>\n    <string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>\n</dict>\n</plist>\n`,
  );
  writeFileSync(
    join(shellDir, "ios/App/App.xcodeproj/project.pbxproj"),
    `// pbxproj\nPRODUCT_BUNDLE_IDENTIFIER = com.downdraft.shell;\nPRODUCT_BUNDLE_IDENTIFIER = com.downdraft.shell;\n`,
  );
}

function copyShellToGame(shellDir: string, gameDir: string, target: string): void {
  const { cpSync } = require("node:fs");
  cpSync(join(shellDir, target), join(gameDir, target), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("patchShell", () => {
  let tempDir: string;
  let shellDir: string;
  let gameDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mobile-spec-"));
    shellDir = join(tempDir, "shell");
    gameDir = join(tempDir, "game");
    mkdirSync(gameDir, { recursive: true });
    createMockShell(shellDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("patches Android placeholders correctly", () => {
    copyShellToGame(shellDir, gameDir, "android");

    patchShell(gameDir, "com.downdraft.testgame", "TestGame", 9999, "android");

    const buildGradle = readFileSync(join(gameDir, "android/app/build.gradle"), "utf-8");
    expect(buildGradle).toContain('applicationId "com.downdraft.testgame"');
    expect(buildGradle).not.toContain("__APP_ID__");

    const strings = readFileSync(join(gameDir, "android/app/src/main/res/values/strings.xml"), "utf-8");
    expect(strings).toContain(">TestGame<");
    expect(strings).toContain("com.downdraft.testgame");
    expect(strings).not.toContain("__APP_NAME__");
    expect(strings).not.toContain("__APP_ID__");

    const mainActivity = readFileSync(join(gameDir, "android/app/src/main/java/com/downdraft/shell/MainActivity.java"), "utf-8");
    expect(mainActivity).toContain("SERVER_PORT = 9999");
    expect(mainActivity).not.toContain("__SERVER_PORT__");
  });

  it("patches iOS placeholders correctly", () => {
    copyShellToGame(shellDir, gameDir, "ios");

    patchShell(gameDir, "com.downdraft.testgame", "TestGame", 9999, "ios");

    const appDelegate = readFileSync(join(gameDir, "ios/App/App/AppDelegate.swift"), "utf-8");
    expect(appDelegate).toContain("serverPort: Int = 9999");
    expect(appDelegate).not.toContain("__SERVER_PORT__");

    const sceneDelegate = readFileSync(join(gameDir, "ios/App/App/SceneDelegate.swift"), "utf-8");
    expect(sceneDelegate).toContain("serverPort: Int = 9999");

    const infoPlist = readFileSync(join(gameDir, "ios/App/App/Info.plist"), "utf-8");
    expect(infoPlist).toContain(">TestGame<");
    expect(infoPlist).not.toContain("__APP_NAME__");

    const pbxproj = readFileSync(join(gameDir, "ios/App/App.xcodeproj/project.pbxproj"), "utf-8");
    expect(pbxproj).toContain("com.downdraft.testgame");
    expect(pbxproj).not.toContain("com.downdraft.shell");
  });

  it("patches both platforms when target is 'all'", () => {
    copyShellToGame(shellDir, gameDir, "android");
    copyShellToGame(shellDir, gameDir, "ios");

    patchShell(gameDir, "com.downdraft.testgame", "TestGame", 8765, "all");

    const strings = readFileSync(join(gameDir, "android/app/src/main/res/values/strings.xml"), "utf-8");
    expect(strings).toContain("TestGame");

    const infoPlist = readFileSync(join(gameDir, "ios/App/App/Info.plist"), "utf-8");
    expect(infoPlist).toContain("TestGame");
  });
});

describe("applyOverrides", () => {
  let tempDir: string;
  let gameDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mobile-overrides-spec-"));
    gameDir = join(tempDir, "game");
    mkdirSync(gameDir, { recursive: true });
    createMockShell(gameDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("merges Android permissions from override manifest", () => {
    mkdirSync(join(gameDir, "mobile-overrides/android"), { recursive: true });
    writeFileSync(
      join(gameDir, "mobile-overrides/android/AndroidManifest.xml"),
      `<?xml version="1.0" encoding="utf-8"?>\n<manifest>\n    <uses-permission android:name="android.permission.CAMERA" />\n    <uses-permission android:name="android.permission.VIBRATE" />\n</manifest>\n`,
    );

    applyOverrides(gameDir, "android");

    const manifest = readFileSync(join(gameDir, "android/app/src/main/AndroidManifest.xml"), "utf-8");
    expect(manifest).toContain("android.permission.CAMERA");
    expect(manifest).toContain("android.permission.VIBRATE");
    expect(manifest).toContain("android.permission.INTERNET");
  });

  it("merges Android gradle dependencies from override", () => {
    mkdirSync(join(gameDir, "mobile-overrides/android/app"), { recursive: true });
    writeFileSync(
      join(gameDir, "mobile-overrides/android/app/build.gradle"),
      `dependencies {\n    implementation "com.some.sdk:sdk:1.0.0"\n    implementation "com.other:lib:2.0"\n}\n`,
    );

    applyOverrides(gameDir, "android");

    const gradle = readFileSync(join(gameDir, "android/app/build.gradle"), "utf-8");
    expect(gradle).toContain("com.some.sdk:sdk:1.0.0");
    expect(gradle).toContain("com.other:lib:2.0");
    expect(gradle).toContain("capacitor-android");
  });

  it("merges iOS Info.plist keys from override", () => {
    mkdirSync(join(gameDir, "mobile-overrides/ios"), { recursive: true });
    writeFileSync(
      join(gameDir, "mobile-overrides/ios/Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n    <key>NSCameraUsageDescription</key>\n    <string>Camera access for AR</string>\n    <key>NSMicrophoneUsageDescription</key>\n    <string>Microphone for voice chat</string>\n</dict>\n</plist>\n`,
    );

    applyOverrides(gameDir, "ios");

    const plist = readFileSync(join(gameDir, "ios/App/App/Info.plist"), "utf-8");
    expect(plist).toContain("NSCameraUsageDescription");
    expect(plist).toContain("Camera access for AR");
    expect(plist).toContain("NSMicrophoneUsageDescription");
    expect(plist).toContain("CFBundleDisplayName");
  });

  it("does not duplicate existing plist keys", () => {
    mkdirSync(join(gameDir, "mobile-overrides/ios"), { recursive: true });
    writeFileSync(
      join(gameDir, "mobile-overrides/ios/Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n    <key>CFBundleDisplayName</key>\n    <string>Should Not Override</string>\n    <key>NSCameraUsageDescription</key>\n    <string>Camera access</string>\n</dict>\n</plist>\n`,
    );

    applyOverrides(gameDir, "ios");

    const plist = readFileSync(join(gameDir, "ios/App/App/Info.plist"), "utf-8");
    expect(plist).toContain("NSCameraUsageDescription");
    const displayNameMatches = plist.match(/CFBundleDisplayName<\/key>\s*<string>([^<]*)<\/string>/g);
    expect(displayNameMatches?.length).toBe(1);
  });

  it("handles missing overrides directory gracefully", () => {
    expect(() => applyOverrides(gameDir, "all")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Icon + splash generation tests
// ---------------------------------------------------------------------------

describe("generateIcons", () => {
  let tempDir: string;
  let gameDir: string;
  let androidDir: string;
  let iosAppDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mobile-icons-spec-"));
    gameDir = join(tempDir, "game");
    androidDir = join(gameDir, "android");
    iosAppDir = join(gameDir, "ios/App/App");
    mkdirSync(androidDir, { recursive: true });
    mkdirSync(join(androidDir, "app/src/main/res"), { recursive: true });
    mkdirSync(join(iosAppDir, "Assets.xcassets/AppIcon.appiconset"), { recursive: true });
    mkdirSync(join(iosAppDir, "Assets.xcassets/Splash.imageset"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns false and generates placeholders when no icon.png is found", async () => {
    const result = await generateIcons(gameDir, androidDir, iosAppDir);
    expect(result).toBe(false);

    // Placeholders should still be generated
    expect(existsSync(join(androidDir, "app/src/main/res/mipmap-mdpi/ic_launcher.png"))).toBe(true);
    expect(existsSync(join(iosAppDir, "Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"))).toBe(true);
  });

  it("returns true and generates icons from icon.png", async () => {
    const icon = new Jimp({ width: 1024, height: 1024, color: 0xff0000ff });
    await icon.write(join(gameDir, "icon.png"));

    const result = await generateIcons(gameDir, androidDir, iosAppDir);
    expect(result).toBe(true);
  });

  // --- Android launcher icons ---

  it("generates Android launcher icons at all 5 densities", async () => {
    const icon = new Jimp({ width: 1024, height: 1024, color: 0xff0000ff });
    await icon.write(join(gameDir, "icon.png"));

    await generateIcons(gameDir, androidDir, iosAppDir);

    const sizes: Record<string, number> = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
    for (const [density, size] of Object.entries(sizes)) {
      const iconPath = join(androidDir, `app/src/main/res/mipmap-${density}/ic_launcher.png`);
      expect(existsSync(iconPath)).toBe(true);
      const generated = await Jimp.read(iconPath);
      expect(generated.width).toBe(size);
      expect(generated.height).toBe(size);
    }
  });

  it("generates Android round launcher icons at all densities", async () => {
    const icon = new Jimp({ width: 1024, height: 1024, color: 0xff0000ff });
    await icon.write(join(gameDir, "icon.png"));

    await generateIcons(gameDir, androidDir, iosAppDir);

    for (const density of ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"]) {
      const roundPath = join(androidDir, `app/src/main/res/mipmap-${density}/ic_launcher_round.png`);
      expect(existsSync(roundPath)).toBe(true);
    }
  });

  it("generates Android adaptive icon foregrounds with padding", async () => {
    const icon = new Jimp({ width: 1024, height: 1024, color: 0x0000ffff });
    await icon.write(join(gameDir, "icon.png"));

    await generateIcons(gameDir, androidDir, iosAppDir);

    const fgSizes: Record<string, number> = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
    for (const [density, size] of Object.entries(fgSizes)) {
      const fgPath = join(androidDir, `app/src/main/res/mipmap-${density}/ic_launcher_foreground.png`);
      expect(existsSync(fgPath)).toBe(true);
      const generated = await Jimp.read(fgPath);
      expect(generated.width).toBe(size);
      expect(generated.height).toBe(size);
    }
  });

  // --- Android splash screens ---

  it("generates Android default splash screen", async () => {
    const icon = new Jimp({ width: 1024, height: 1024, color: 0x00ff00ff });
    await icon.write(join(gameDir, "icon.png"));

    await generateIcons(gameDir, androidDir, iosAppDir);

    const splashPath = join(androidDir, "app/src/main/res/drawable/splash.png");
    expect(existsSync(splashPath)).toBe(true);
    const splash = await Jimp.read(splashPath);
    expect(splash.width).toBe(480);
    expect(splash.height).toBe(480);
  });

  it("generates Android portrait splash screens at all densities", async () => {
    const icon = new Jimp({ width: 1024, height: 1024, color: 0x00ff00ff });
    await icon.write(join(gameDir, "icon.png"));

    await generateIcons(gameDir, androidDir, iosAppDir);

    const specs: Array<[string, number, number]> = [
      ["drawable-port-mdpi", 480, 800],
      ["drawable-port-hdpi", 720, 1280],
      ["drawable-port-xhdpi", 960, 1600],
      ["drawable-port-xxhdpi", 1440, 2560],
      ["drawable-port-xxxhdpi", 1920, 3200],
    ];
    for (const [dir, w, h] of specs) {
      const splashPath = join(androidDir, `app/src/main/res/${dir}/splash.png`);
      expect(existsSync(splashPath)).toBe(true);
      const splash = await Jimp.read(splashPath);
      expect(splash.width).toBe(w);
      expect(splash.height).toBe(h);
    }
  });

  it("generates Android landscape splash screens at all densities", async () => {
    const icon = new Jimp({ width: 1024, height: 1024, color: 0x00ff00ff });
    await icon.write(join(gameDir, "icon.png"));

    await generateIcons(gameDir, androidDir, iosAppDir);

    const specs: Array<[string, number, number]> = [
      ["drawable-land-mdpi", 800, 480],
      ["drawable-land-hdpi", 1280, 720],
      ["drawable-land-xhdpi", 1600, 960],
      ["drawable-land-xxhdpi", 2560, 1440],
      ["drawable-land-xxxhdpi", 3200, 1920],
    ];
    for (const [dir, w, h] of specs) {
      const splashPath = join(androidDir, `app/src/main/res/${dir}/splash.png`);
      expect(existsSync(splashPath)).toBe(true);
      const splash = await Jimp.read(splashPath);
      expect(splash.width).toBe(w);
      expect(splash.height).toBe(h);
    }
  });

  // --- iOS icons ---

  it("generates iOS 1024×1024 app icon", async () => {
    const icon = new Jimp({ width: 1024, height: 1024, color: 0x00ff00ff });
    await icon.write(join(gameDir, "icon.png"));

    await generateIcons(gameDir, androidDir, iosAppDir);

    const iosIconPath = join(iosAppDir, "Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png");
    expect(existsSync(iosIconPath)).toBe(true);
    const generated = await Jimp.read(iosIconPath);
    expect(generated.width).toBe(1024);
    expect(generated.height).toBe(1024);
  });

  it("cover-fits non-square iOS icon to 1024×1024", async () => {
    // 2048×1024 rectangular icon — should be cover-fit to 1024×1024
    const icon = new Jimp({ width: 2048, height: 1024, color: 0x0000ffff });
    await icon.write(join(gameDir, "icon.png"));

    await generateIcons(gameDir, androidDir, iosAppDir);

    const iosIconPath = join(iosAppDir, "Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png");
    const generated = await Jimp.read(iosIconPath);
    expect(generated.width).toBe(1024);
    expect(generated.height).toBe(1024);
  });

  // --- iOS splash screens ---

  it("generates iOS splash screen set (3 universal images)", async () => {
    const icon = new Jimp({ width: 1024, height: 1024, color: 0x00ff00ff });
    await icon.write(join(gameDir, "icon.png"));

    await generateIcons(gameDir, androidDir, iosAppDir);

    const splashDir = join(iosAppDir, "Assets.xcassets/Splash.imageset");
    for (const filename of ["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"]) {
      const splashPath = join(splashDir, filename);
      expect(existsSync(splashPath)).toBe(true);
      const splash = await Jimp.read(splashPath);
      expect(splash.width).toBe(2732);
      expect(splash.height).toBe(2732);
    }
  });

  // --- Placeholder generation ---

  it("generates valid placeholder icons when no icon.png provided", async () => {
    await generateIcons(gameDir, androidDir, iosAppDir);

    // Android placeholders should be valid PNGs at correct sizes
    const mdpiIcon = join(androidDir, "app/src/main/res/mipmap-mdpi/ic_launcher.png");
    expect(existsSync(mdpiIcon)).toBe(true);
    const generated = await Jimp.read(mdpiIcon);
    expect(generated.width).toBe(48);
    expect(generated.height).toBe(48);

    // iOS placeholder should be 1024×1024
    const iosIcon = join(iosAppDir, "Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png");
    expect(existsSync(iosIcon)).toBe(true);
    const iosGenerated = await Jimp.read(iosIcon);
    expect(iosGenerated.width).toBe(1024);
    expect(iosGenerated.height).toBe(1024);
  });

  it("generates valid placeholder splash screens when no icon.png provided", async () => {
    await generateIcons(gameDir, androidDir, iosAppDir);

    // Android default splash
    const defaultSplash = join(androidDir, "app/src/main/res/drawable/splash.png");
    expect(existsSync(defaultSplash)).toBe(true);

    // Android portrait splash
    const portraitSplash = join(androidDir, "app/src/main/res/drawable-port-mdpi/splash.png");
    expect(existsSync(portraitSplash)).toBe(true);

    // iOS splash
    const iosSplash = join(iosAppDir, "Assets.xcassets/Splash.imageset/splash-2732x2732.png");
    expect(existsSync(iosSplash)).toBe(true);
    const splash = await Jimp.read(iosSplash);
    expect(splash.width).toBe(2732);
    expect(splash.height).toBe(2732);
  });
});

// ---------------------------------------------------------------------------
// Mobile entry auto-generation tests
// ---------------------------------------------------------------------------

describe("ensureMobileEntry", () => {
  let tempDir: string;
  let gameDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mobile-entry-spec-"));
    gameDir = join(tempDir, "my-game");
    mkdirSync(join(gameDir, "src"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns true without writing when mobile.tsx already exists", () => {
    const entryPath = join(gameDir, "src/mobile.tsx");
    writeFileSync(entryPath, "// existing entry\n");

    const result = ensureMobileEntry(gameDir, "my-game", "com.downdraft.mygame");
    expect(result).toBe(true);

    // Should not have overwritten the existing file
    const content = readFileSync(entryPath, "utf-8");
    expect(content).toBe("// existing entry\n");
  });

  it("returns true without writing when mobile.ts already exists", () => {
    const entryPath = join(gameDir, "src/mobile.ts");
    writeFileSync(entryPath, "// existing entry\n");

    const result = ensureMobileEntry(gameDir, "my-game", "com.downdraft.mygame");
    expect(result).toBe(true);
  });

  it("auto-generates src/mobile.tsx when no entry exists", () => {
    const entryPath = join(gameDir, "src/mobile.tsx");
    expect(existsSync(entryPath)).toBe(false);

    const result = ensureMobileEntry(gameDir, "my-game", "com.downdraft.mygame");
    expect(result).toBe(true);
    expect(existsSync(entryPath)).toBe(true);

    const content = readFileSync(entryPath, "utf-8");
    expect(content).toContain("createDowndraftMobileApp");
    expect(content).toContain("com.downdraft.mygame");
    expect(content).toContain("my-game");
  });

  it("does not regenerate on second call (file already exists)", () => {
    const entryPath = join(gameDir, "src/mobile.tsx");

    // First call generates
    ensureMobileEntry(gameDir, "my-game", "com.downdraft.mygame");
    const firstContent = readFileSync(entryPath, "utf-8");

    // Modify the file (simulate developer customization)
    writeFileSync(entryPath, firstContent + "\n// customized\n");

    // Second call should NOT overwrite
    ensureMobileEntry(gameDir, "my-game", "com.downdraft.mygame");
    const secondContent = readFileSync(entryPath, "utf-8");
    expect(secondContent).toContain("// customized");
  });
});

describe("generateMobileEntryStub", () => {
  it("includes the game name and appId", () => {
    const stub = generateMobileEntryStub("falling-sand", "com.downdraft.fallingsand");
    expect(stub).toContain("falling-sand");
    expect(stub).toContain("com.downdraft.fallingsand");
  });

  it("imports createDowndraftMobileApp", () => {
    const stub = generateMobileEntryStub("test-game", "com.downdraft.testgame");
    expect(stub).toContain('from "@downdraft/app/mobile"');
    expect(stub).toContain("createDowndraftMobileApp");
  });

  it("includes touch input config with all scheme options documented", () => {
    const stub = generateMobileEntryStub("test-game", "com.downdraft.testgame");
    expect(stub).toContain("touchInput");
    expect(stub).toContain("dual-stick");
    expect(stub).toContain("tap-to-move");
    expect(stub).toContain('"tap"');
  });

  it("includes TODO markers for developer customization", () => {
    const stub = generateMobileEntryStub("test-game", "com.downdraft.testgame");
    expect(stub).toContain("TODO");
    expect(stub).toContain("STUB");
    expect(stub).toContain("main.tsx");
  });

  it("includes a placeholder GameModule with correct structure", () => {
    const stub = generateMobileEntryStub("test-game", "com.downdraft.testgame");
    expect(stub).toContain("GameModule");
    expect(stub).toContain("renderer:");
    expect(stub).toContain("sim:");
    expect(stub).toContain("mountUI:");
    expect(stub).toContain("onReady:");
  });
});
