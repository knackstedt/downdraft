#!/usr/bin/env node
// fetch-wpe-android.mjs — stage the wpe-android (WPEView) runtime into
// libraries/webui/vendor/wpe-android/ for the native-wpe crate's android
// target and package-mobile.mjs's --webui=wpe staging.
//
// Source: org.wpewebkit.wpeview:wpeview on Maven Central (Igalia). The AAR
// carries everything the Android backend needs:
//   jni/<abi>/*.so        libWPEWebKit-2.0, libwpe-1.0, libWPEBackend-android,
//                         libWPEAndroidRuntime/Service, glib/soup/gstreamer…
//   classes.jar           org.wpewebkit.wpe.* — WKRuntime bootstrap (dex'd by
//                         package-mobile.mjs; our shell never runs WPEView)
//   AndroidManifest.xml   generated WPEServices service declarations to merge
//   assets/               fontconfig, gio modules, gstreamer plugins,
//                         injected-bundles (WKRuntime copies these to filesDir)
//   include/              reference headers (WPEAndroidViewBackend C API)
//
//   node fetch-wpe-android.mjs            # pin from WPE_ANDROID_VERSION
//   node fetch-wpe-android.mjs 0.3.3      # explicit version

import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const VERSION = process.argv[2] ?? "0.3.3";
const REPO = "https://repo1.maven.org/maven2";
const AAR_URL = `${REPO}/org/wpewebkit/wpeview/wpeview/${VERSION}/wpeview-${VERSION}.aar`;

const VENDOR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "vendor", "wpe-android",
);
const TMP = join("/var/tmp", `wpe-android-${VERSION}`);

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const f = createWriteStream(dest);
    get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(download(res.headers.location, dest));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`${url} → HTTP ${res.statusCode}`));
      }
      res.pipe(f);
      f.on("finish", () => f.close(resolve));
    }).on("error", reject);
  });
}

const aarPath = join(TMP, `wpeview-${VERSION}.aar`);
mkdirSync(TMP, { recursive: true });
if (!existsSync(aarPath)) {
  console.log(`[fetch-wpe-android] downloading ${AAR_URL}`);
  await download(AAR_URL, aarPath);
}
const sha = createHash("sha256").update(readFileSync(aarPath)).digest("hex");
console.log(`[fetch-wpe-android] wpeview-${VERSION}.aar sha256 ${sha}`);

rmSync(VENDOR, { recursive: true, force: true });
mkdirSync(VENDOR, { recursive: true });

// AAR is a zip — unzip(1) is everywhere we build.
execFileSync("unzip", ["-o", "-q", aarPath, "-d", TMP], { stdio: "inherit" });

const move = (src, dst) => {
  if (!existsSync(src)) return;
  mkdirSync(dirname(dst), { recursive: true });
  execFileSync("cp", ["-a", src, dst]);
};

move(join(TMP, "classes.jar"), join(VENDOR, "classes.jar"));
move(join(TMP, "AndroidManifest.xml"), join(VENDOR, "AndroidManifest.xml"));
move(join(TMP, "jni"), join(VENDOR, "jni"));
move(join(TMP, "assets"), join(VENDOR, "assets"));
move(join(TMP, "res"), join(VENDOR, "res"));

// Reference header for the libWPEBackend-android C API (the runtime lib is
// vendored; this documents the signatures native-wpe binds by hand).
mkdirSync(join(VENDOR, "include", "wpe-android"), { recursive: true });
const hdrUrl =
  "https://raw.githubusercontent.com/Igalia/WPEBackend-android/main/include/wpe-android/view-backend.h";
await download(hdrUrl, join(VENDOR, "include", "wpe-android", "view-backend.h"));

writeFileSync(
  join(VENDOR, "manifest"),
  JSON.stringify(
    { version: VERSION, aar: AAR_URL, sha256: sha, fetched: new Date().toISOString() },
    null, 2,
  ) + "\n",
);
console.log(`[fetch-wpe-android] staged ${VENDOR}`);
