# @downdraft/mobile-shell — Dormant

> **⚠️ Dormant:** Mobile packaging is unmaintained during the native desktop migration bake. `draft release --target=android,ios` still runs but is not exercised by CI; expect drift. The Capacitor/WebView shell survives in-tree for a future revisit — do not build new features on it.

Canonical pre-wired Capacitor native shell for Android + iOS mobile builds.

## Purpose

This package contains the **source of truth** for the native Android and iOS
projects used by `draft release --target=android,ios` (and the deprecated
`draft mobile`). Instead of each game running `cap add` to generate ~143
native files (which must then be committed and hand-wired with the embedded
HTTP server), `draft release` copies this shell into a per-game **gitignored**
directory and patches in game-specific values.

Games commit **zero native files** — only `capacitor.config.ts`, `src/mobile.ts`,
`mobile.vite.config.ts`, and optionally `icon.png` + `mobile-overrides/`.

## What's pre-wired

The shell's native projects already have the embedded HTTP server fully wired:

### Android
- `MainActivity.java` starts `EmbeddedServer` in `onCreate()` **before** the
  Capacitor bridge loads the WebView, then overrides the WebView URL to
  `http://127.0.0.1:<port>/index.html`.
- `app/build.gradle` includes the NanoHTTPD dependency.
- `EmbeddedServer.java` serves web assets with COOP/COEP headers for
  SharedArrayBuffer cross-origin isolation.

### iOS
- `AppDelegate.swift` starts `EmbeddedServer` in
  `didFinishLaunchingWithOptions()` before the scene connects.
- `SceneDelegate.swift` overrides the WebView URL to load from the embedded
  server instead of the default `capacitor://` scheme.
- `Info.plist` includes an ATS (App Transport Security) exception for
  `127.0.0.1` to allow the local HTTP load.
- `EmbeddedServer.swift` serves web assets with COOP/COEP headers.

## Placeholders

The shell uses placeholder strings that `draft release` replaces during the
copy + patch step:

| Placeholder | Replaced with | Files |
|---|---|---|
| `__APP_ID__` | Game's Capacitor appId (e.g. `com.downdraft.sandjongg`) | `app/build.gradle`, `strings.xml` |
| `__APP_NAME__` | Game's display name (e.g. `Sandjongg`) | `strings.xml`, `Info.plist` |
| `__SERVER_PORT__` | Embedded server port (default: 8765) | `MainActivity.java`, `AppDelegate.swift`, `SceneDelegate.swift` |
| `com.downdraft.shell` (bundle ID) | Game's appId | `project.pbxproj` |

## What `draft release --target=android,ios` does

1. Builds the web bundle → `dist/mobile/`
2. Copies `packages/mobile-shell/{android,ios}/` → `games/<game>/{android,ios}/`
3. Patches placeholders with game-specific values
4. Generates app icons from `icon.png` (via jimp) if provided
5. Applies `mobile-overrides/` merge layer if present
6. Writes `capacitor.config.ts` if missing
7. Runs `cap sync` to populate web assets + Capacitor plugin configs
8. Prints next steps (`cap open android` / `cap open ios`)

## Upgrading Capacitor

When upgrading to a new Capacitor version, the native project structure may
change. To update the shell:

1. Create a temp directory and run `npx cap add android` + `npx cap add ios`
   with the new Capacitor version.
2. Diff the generated projects against `packages/mobile-shell/{android,ios}/`.
3. Merge structural changes (new build settings, manifest entries, etc.) into
   the shell while preserving the embedded server wiring.
4. Test with `draft release --target=android,ios` on a game.

## Files

```
packages/mobile-shell/
├── package.json              # Workspace package metadata
├── README.md                 # This file
├── android/                  # Canonical Android project (pre-wired)
│   ├── app/
│   │   ├── build.gradle      # NanoHTTPD dep + __APP_ID__ placeholder
│   │   └── src/main/
│   │       ├── java/com/downdraft/
│   │       │   ├── embeddedserver/EmbeddedServer.java
│   │       │   └── shell/MainActivity.java    # Server start + loadUrl
│   │       ├── res/values/strings.xml         # __APP_NAME__ / __APP_ID__
│   │       └── AndroidManifest.xml
│   ├── build.gradle
│   ├── settings.gradle
│   ├── variables.gradle
│   └── gradle/wrapper/
└── ios/                      # Canonical iOS project (pre-wired)
    └── App/
        ├── App/
        │   ├── AppDelegate.swift              # Server start
        │   ├── SceneDelegate.swift            # loadUrl override
        │   ├── EmbeddedServer.swift
        │   ├── Info.plist                     # ATS exception + __APP_NAME__
        │   └── Assets.xcassets/               # Placeholder icons
        └── App.xcodeproj/project.pbxproj      # com.downdraft.shell bundle ID
```
