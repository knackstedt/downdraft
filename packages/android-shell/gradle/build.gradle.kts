// Root project — the app module carries no Java/Kotlin sources
// (hasCode=false NativeActivity); AGP only assembles manifest + jniLibs +
// assets into the APK.
plugins {
    id("com.android.application") version "8.7.3" apply false
}
