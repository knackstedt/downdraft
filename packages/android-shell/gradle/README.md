# Downdraft Android — Gradle skeleton

Zero-Java `android.app.NativeActivity` shell. The whole engine is native:
winit/wgpu (`libdowndraft_android.so`) + embedded Node (`libnode.so`) + the
game's JS bundle extracted from `assets/bundle/`.

`package-mobile.mjs` assembles APKs directly with `aapt2`/`zipalign`/
`apksigner` and does not need Gradle. This project exists for Android Studio
and custom-signing workflows.

## Inputs (stage before `assembleDebug`)

```
app/jniLibs/<abi>/libdowndraft_android.so   # scripts/build-native.mjs --target=<triple>
app/jniLibs/<abi>/libnode.so              # packages/node-mobile/scripts/build-android.mjs
app/jniLibs/<abi>/libdowndraft_*.so       # optional engine cdylibs
app/assets/bundle/…                       # bun bundle + dd-assets + manifest.txt
```

`package-mobile.mjs --stage-only` output drops straight into `app/` when a
Gradle build is preferred.

## Build

```
sdk.dir is read from local.properties or ANDROID_HOME.
./gradlew assembleDebug \
  -PDD_APP_ID=com.example.game -PDD_APP_NAME=Game -PDD_VERSION_NAME=1.0
```

A Gradle wrapper isn't vendored — use a system `gradle` install or open the
directory in Android Studio (it generates the wrapper on first sync).
