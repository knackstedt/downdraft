// Downdraft Android app — zero-Java NativeActivity shell.
//
// The native libraries and the JS bundle are produced by
//   node scripts/build-native.mjs --target=aarch64-linux-android
//   node packages/node-mobile/scripts/build-android.mjs --arch=arm64
//   bun packages/cli/scripts/package-mobile.mjs <entry> <out.apk>
//
// and staged under gradle/app/ (jniLibs/, assets/). package-mobile.mjs uses
// aapt2 directly rather than this skeleton — the Gradle project exists for
// Android Studio workflows and signing-config flexibility.

val appId = providers.gradleProperty("DD_APP_ID").getOrElse("com.downdraft.game")
val appName = providers.gradleProperty("DD_APP_NAME").getOrElse("Downdraft")
val versionCode = providers.gradleProperty("DD_VERSION_CODE").map(String::toInt).getOrElse(1)
val versionName = providers.gradleProperty("DD_VERSION_NAME").getOrElse("0.0.1")
val minSdk = providers.gradleProperty("DD_MIN_SDK").map(String::toInt).getOrElse(30)

plugins {
    id("com.android.application")
}

android {
    namespace = appId
    compileSdk = 36

    defaultConfig {
        applicationId = appId
        this.minSdk = minSdk
        targetSdk = 36
        this.versionCode = versionCode
        this.versionName = versionName
        manifestPlaceholders["appName"] = appName
    }

    sourceSets {
        getByName("main") {
            // Staged by package-mobile.mjs / build-native.mjs:
            //   jniLibs/<abi>/{libdowndraft_android,libnode,libdowndraft_*}.so
            //   assets/bundle/…  (index.js, bundled modules, node_modules,
            //                     dd-assets, manifest.txt)
            jniLibs.srcDir("jniLibs")
            assets.srcDir("assets")
        }
    }

    packaging {
        jniLibs {
            useLegacyPackaging = true // extractNativeLibs=true — keeps .so readable post-install
        }
    }
}

dependencies {}
