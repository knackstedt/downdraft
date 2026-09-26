// ============================================================================
// mobile-icons.ts — Generate Android + iOS app icons and splash screens
// ============================================================================
//
// Games optionally commit a 1024×1024 `icon.png` in their game directory.
// `draft mobile` uses this module to generate ALL required image assets for
// both platforms via jimp (pure-JS, no native dependencies):
//
//   Android:
//     - ic_launcher.png + ic_launcher_round.png (5 mipmap densities)
//     - ic_launcher_foreground.png (5 densities, with safe-zone padding)
//     - splash.png (portrait + landscape, 5 densities each)
//
//   iOS:
//     - AppIcon-512@2x.png (1024×1024, Xcode 14+ single-size format)
//     - splash-2732x2732.png + @2x + @3x (universal splash set)
//
// If no `icon.png` is found, a solid-color placeholder (Downdraft brand
// dark teal) is generated for all assets. Games can override individual
// images via `mobile-overrides/` — those files are copied AFTER generation,
// replacing the generated ones.
//
// The shell ships NO binary images — everything is generated at build time.

import { createLogger } from "@downdraft/engine";
import { Jimp, type JimpInstance } from "jimp";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// jimp's write() types its path as `${string}.${string}` — resolve() returns
// plain string, so assert once here rather than at every call site.
function writeImage(img: JimpInstance, path: string): Promise<void> {
  return img.write(path as `${string}.${string}`);
}

const log = createLogger();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Downdraft brand placeholder color (dark teal) used when no icon.png is provided.
const PLACEHOLDER_COLOR = 0x0d3b3bff; // RGBA: #0D3B3B

// Android launcher icon sizes (in pixels)
interface AndroidIconSpec {
  dir: string;
  size: number;
}

const ANDROID_LAUNCHER_ICONS: AndroidIconSpec[] = [
  { dir: "mipmap-mdpi", size: 48 },
  { dir: "mipmap-hdpi", size: 72 },
  { dir: "mipmap-xhdpi", size: 96 },
  { dir: "mipmap-xxhdpi", size: 144 },
  { dir: "mipmap-xxxhdpi", size: 192 },
];

// Adaptive icon foreground: 108dp per density, icon content in inner ~66% (safe zone)
const ANDROID_FOREGROUND_ICONS: AndroidIconSpec[] = [
  { dir: "mipmap-mdpi", size: 108 },
  { dir: "mipmap-hdpi", size: 162 },
  { dir: "mipmap-xhdpi", size: 216 },
  { dir: "mipmap-xxhdpi", size: 324 },
  { dir: "mipmap-xxxhdpi", size: 432 },
];

// Android splash screen sizes (portrait + landscape per density)
interface AndroidSplashSpec {
  dir: string;
  width: number;
  height: number;
}

const ANDROID_SPLASH_PORTRAIT: AndroidSplashSpec[] = [
  { dir: "drawable-port-mdpi", width: 480, height: 800 },
  { dir: "drawable-port-hdpi", width: 720, height: 1280 },
  { dir: "drawable-port-xhdpi", width: 960, height: 1600 },
  { dir: "drawable-port-xxhdpi", width: 1440, height: 2560 },
  { dir: "drawable-port-xxxhdpi", width: 1920, height: 3200 },
];

const ANDROID_SPLASH_LANDSCAPE: AndroidSplashSpec[] = [
  { dir: "drawable-land-mdpi", width: 800, height: 480 },
  { dir: "drawable-land-hdpi", width: 1280, height: 720 },
  { dir: "drawable-land-xhdpi", width: 1600, height: 960 },
  { dir: "drawable-land-xxhdpi", width: 2560, height: 1440 },
  { dir: "drawable-land-xxxhdpi", width: 3200, height: 1920 },
];

// Also a default (non-oriented) splash in drawable/
const ANDROID_SPLASH_DEFAULT_SIZE = 480;

// iOS icon: single 1024×1024 (Xcode 14+ format)
const IOS_ICON_SIZE = 1024;
const IOS_ICON_FILENAME = "AppIcon-512@2x.png";

// iOS splash: 2732×2732 (iPad Pro 12.9" — largest, used for universal)
const IOS_SPLASH_SIZE = 2732;
const IOS_SPLASH_FILES = [
  "splash-2732x2732.png",     // @3x
  "splash-2732x2732-1.png",   // @2x
  "splash-2732x2732-2.png",   // @1x
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate Android + iOS app icons and splash screens from a game's `icon.png`.
 *
 * If no `icon.png` is found, generates solid-color placeholder images using
 * the Downdraft brand color.
 *
 * @param gameDir The game directory (where `icon.png` lives).
 * @param androidDir Path to the generated `android/` directory.
 * @param iosAppDir Path to the generated `ios/App/App/` directory.
 * @returns true if icons were generated from icon.png, false if placeholders were used.
 */
export async function generateIcons(
  gameDir: string,
  androidDir: string,
  iosAppDir: string,
): Promise<boolean> {
  const sourceIconPath = resolve(gameDir, "icon.png");
  let source: JimpInstance;
  let fromIcon = false;

  if (existsSync(sourceIconPath)) {
    log.info("mobile", `Generating app icons + splash screens from ${sourceIconPath}...`);
    source = (await Jimp.read(sourceIconPath)) as JimpInstance;
    fromIcon = true;

    if (source.width < 512 || source.height < 512) {
      log.warn(
        "mobile",
        `icon.png is ${source.width}×${source.height} — recommended size is 1024×1024. Images may look blurry.`,
      );
    }
  } else {
    log.warn("mobile", "No icon.png found — generating solid-color placeholder images.");
    log.info("mobile", "  To use custom icons, add a 1024×1024 icon.png to the game directory.");
    source = new Jimp({ width: 1024, height: 1024, color: PLACEHOLDER_COLOR });
  }

  // Generate Android assets
  await generateAndroidIcons(source, androidDir);
  await generateAndroidSplash(source, androidDir);

  // Generate iOS assets
  await generateIosIcon(source, iosAppDir);
  await generateIosSplash(source, iosAppDir);

  if (fromIcon) {
    log.info("mobile", "Icon + splash generation complete.");
  } else {
    log.info("mobile", "Placeholder icon + splash generation complete.");
  }
  return fromIcon;
}

// ---------------------------------------------------------------------------
// Android icon generation
// ---------------------------------------------------------------------------

async function generateAndroidIcons(source: JimpInstance, androidDir: string): Promise<void> {
  const resDir = resolve(androidDir, "app/src/main/res");

  // Generate legacy launcher icons (ic_launcher.png + ic_launcher_round.png)
  for (let _i = 0, _it = ANDROID_LAUNCHER_ICONS, _n = _it.length; _i < _n; _i++) { const spec = _it[_i];
    const dir = resolve(resDir, spec.dir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const icon = source.clone();
    icon.resize({ w: spec.size, h: spec.size });
    await writeImage(icon, resolve(dir, "ic_launcher.png"));

    const iconRound = source.clone();
    iconRound.resize({ w: spec.size, h: spec.size });
    await writeImage(iconRound, resolve(dir, "ic_launcher_round.png"));
  }

  // Generate adaptive icon foregrounds (with safe-zone padding)
  for (let _i = 0, _it = ANDROID_FOREGROUND_ICONS, _n = _it.length; _i < _n; _i++) { const spec = _it[_i];
    const dir = resolve(resDir, spec.dir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const foreground = createForegroundIcon(source, spec.size);
    await writeImage(foreground, resolve(dir, "ic_launcher_foreground.png"));
  }

  log.info("mobile", "  → Android launcher icons generated (5 densities × 3 variants).");
}

/**
 * Create an adaptive icon foreground: the source icon centered on a
 * transparent canvas with padding (safe zone). The foreground size is
// 108dp per density; the safe zone is the inner ~66% (72/108).
 */
function createForegroundIcon(source: JimpInstance, targetSize: number): JimpInstance {
  const canvas = new Jimp({ width: targetSize, height: targetSize, color: 0x00000000 });
  const iconSize = Math.round(targetSize * 0.66);
  const offset = Math.round((targetSize - iconSize) / 2);

  const icon = source.clone();
  icon.resize({ w: iconSize, h: iconSize });
  canvas.composite(icon, offset, offset);

  return canvas;
}

// ---------------------------------------------------------------------------
// Android splash screen generation
// ---------------------------------------------------------------------------

async function generateAndroidSplash(source: JimpInstance, androidDir: string): Promise<void> {
  const resDir = resolve(androidDir, "app/src/main/res");

  // Default (non-oriented) splash
  const drawableDir = resolve(resDir, "drawable");
  if (!existsSync(drawableDir)) mkdirSync(drawableDir, { recursive: true });
  const defaultSplash = createSplashImage(source, ANDROID_SPLASH_DEFAULT_SIZE, ANDROID_SPLASH_DEFAULT_SIZE);
  await writeImage(defaultSplash, resolve(drawableDir, "splash.png"));

  // Portrait splashes
  for (let _i = 0, _it = ANDROID_SPLASH_PORTRAIT, _n = _it.length; _i < _n; _i++) { const spec = _it[_i];
    const dir = resolve(resDir, spec.dir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const splash = createSplashImage(source, spec.width, spec.height);
    await writeImage(splash, resolve(dir, "splash.png"));
  }

  // Landscape splashes
  for (let _i = 0, _it = ANDROID_SPLASH_LANDSCAPE, _n = _it.length; _i < _n; _i++) { const spec = _it[_i];
    const dir = resolve(resDir, spec.dir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const splash = createSplashImage(source, spec.width, spec.height);
    await writeImage(splash, resolve(dir, "splash.png"));
  }

  log.info("mobile", "  → Android splash screens generated (11 variants: default + 5 portrait + 5 landscape).");
}

/**
 * Create a splash screen: a solid background color with the icon centered.
 * The icon is scaled to ~40% of the smaller dimension and composited in the center.
 */
function createSplashImage(source: JimpInstance, width: number, height: number): JimpInstance {
  // Background: use the icon's average edge color, or the placeholder color
  const bg = new Jimp({ width, height, color: PLACEHOLDER_COLOR });

  // Center the icon at ~40% of the smaller dimension
  const iconSize = Math.round(Math.min(width, height) * 0.4);
  const offsetX = Math.round((width - iconSize) / 2);
  const offsetY = Math.round((height - iconSize) / 2);

  const icon = source.clone();
  icon.resize({ w: iconSize, h: iconSize });
  bg.composite(icon, offsetX, offsetY);

  return bg;
}

// ---------------------------------------------------------------------------
// iOS icon generation
// ---------------------------------------------------------------------------

async function generateIosIcon(source: JimpInstance, iosAppDir: string): Promise<void> {
  const appIconDir = resolve(iosAppDir, "Assets.xcassets/AppIcon.appiconset");
  if (!existsSync(appIconDir)) mkdirSync(appIconDir, { recursive: true });

  const icon = source.clone();
  // Cover-fit to exactly 1024×1024
  if (icon.width !== IOS_ICON_SIZE || icon.height !== IOS_ICON_SIZE) {
    const scale = Math.max(IOS_ICON_SIZE / icon.width, IOS_ICON_SIZE / icon.height);
    const scaledW = Math.round(icon.width * scale);
    const scaledH = Math.round(icon.height * scale);
    icon.resize({ w: scaledW, h: scaledH });
    const cropX = Math.round((scaledW - IOS_ICON_SIZE) / 2);
    const cropY = Math.round((scaledH - IOS_ICON_SIZE) / 2);
    icon.crop({ x: cropX, y: cropY, w: IOS_ICON_SIZE, h: IOS_ICON_SIZE });
  }

  await writeImage(icon, resolve(appIconDir, IOS_ICON_FILENAME));
  log.info("mobile", "  → iOS AppIcon generated (1024×1024, Xcode 14+ single-size format).");
}

// ---------------------------------------------------------------------------
// iOS splash screen generation
// ---------------------------------------------------------------------------

async function generateIosSplash(source: JimpInstance, iosAppDir: string): Promise<void> {
  const splashDir = resolve(iosAppDir, "Assets.xcassets/Splash.imageset");
  if (!existsSync(splashDir)) mkdirSync(splashDir, { recursive: true });

  // Generate a single 2732×2732 splash and write it to all 3 filenames
  // referenced by Contents.json (@1x, @2x, @3x all use the same universal image)
  const splash = createSplashImage(source, IOS_SPLASH_SIZE, IOS_SPLASH_SIZE);

  for (let _i = 0, _it = IOS_SPLASH_FILES, _n = _it.length; _i < _n; _i++) { const filename = _it[_i];
    await writeImage(splash, resolve(splashDir, filename));
  }

  log.info("mobile", "  → iOS splash screen generated (2732×2732 universal set).");
}
