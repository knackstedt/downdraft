#!/usr/bin/env node
// ============================================================================
// fetch-wpe.mjs — vendor the WPE (embedded WebKit) runtime from Debian trixie
// packages into libraries/webui/vendor/wpe-<plat>/.
//
// Layout produced:
//   wpe-<plat>/lib/       libWPEWebKit-2.0, libwpe-1.0, libWPEBackend-fdo,
//                         plus the whole ldd closure (glib/soup/gst/icu…)
//   wpe-<plat>/libexec/   wpe-webkit-2.0/{WPEWeb,Network,GPU}Process,
//                         injected-bundle/
//   wpe-<plat>/include/   wpe-webkit + wpe + backend headers (+deps for
//                         bindgen: glib, libsoup)
//   wpe-<plat>/share/     wpe-webkit-2.0/inspector.gresource
//
// Why Debian packages and not a source build: Ubuntu has no WPE packages
// and the WebKit SDK build is ~1hr. Trixie's 2.48 stack only needs
// GLIBC≤2.39 (verified) so the vendored set runs on this host.
//
// The vendored libexec dir has a compile-time path baked into
// libWPEWebKit (/usr/lib/x86_64-linux-gnu/wpe-webkit-2.0) — at dev time we
// bind-mount it into place with `unshare -rm`; packaging patches the
// string. See README.md.
// ============================================================================

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDOR = join(HERE, "..", "vendor");
const PLAT = process.env.DD_WPE_PLAT ?? `linux-${process.arch === "x64" ? "x64" : "arm64"}`;
const DEST = join(VENDOR, `wpe-${PLAT}`);
const IMAGE = process.env.DD_WPE_VENDOR_IMAGE ?? "debian:trixie-slim";
const DOCKER = ["docker", "podman"].find((c) => spawnSync("which", [c]).status === 0);
if (!DOCKER) {
  console.error("[fetch-wpe] docker/podman not found");
  process.exit(1);
}

const PKGS = [
  // Runtime + dev (headers/.so symlinks/pkgconfig)
  "libwpewebkit-2.0-1", "libwpewebkit-2.0-dev",
  "libwpe-1.0-1", "libwpe-1.0-dev",
  "libwpebackend-fdo-1.0-1", "libwpebackend-fdo-1.0-dev",
  // ldd-closure tooling
  "binutils", "patchelf", "tar",
];

// The in-container script: install, then tar the WPE payload + full ldd
// closure of every vendored .so and subprocess binary into /out.
const INNER = `
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ${PKGS.join(" ")} >/dev/null

mkdir -p /out/lib /out/libexec /out/include /out/share /out/manifest

LIBDIR=/usr/lib/x86_64-linux-gnu
WPE_LIBDIR=$LIBDIR/wpe-webkit-2.0

# 1. WPE-owned payload: the webview lib, wpe API libs, the fdo backend,
#    subprocesses, injected bundle, gresource.
cp -a $LIBDIR/libWPEWebKit-2.0.so* /out/lib/
cp -a $LIBDIR/libwpe-1.0.so* /out/lib/
cp -a $LIBDIR/libWPEBackend-fdo-1.0.so* /out/lib/
cp -a $WPE_LIBDIR /out/libexec/
if [ -d /usr/share/wpe-webkit-2.0 ]; then
  cp -a /usr/share/wpe-webkit-2.0 /out/share/
fi

# 2. Dependency closure over every vendored shared object + subprocess
#    binary. Exclude the C runtime family — those come from the host (and
#    mixing libc copies breaks a host process).
EXCL='^(ld-linux|libc|libm|libdl|librt|libpthread|libresolv|libnsl|libutil|libgcc_s)\\.so'
CLOSURE=$(
  { ldd /out/lib/*.so.* /out/libexec/wpe-webkit-2.0/* 2>/dev/null \
      | grep -o '/[^ ]*\\.so[^ ]*' ; ldd /out/libexec/wpe-webkit-2.0/injected-bundle/*.so 2>/dev/null \
      | grep -o '/[^ ]*\\.so[^ ]*'; } \
    | sort -u
)
for so in $CLOSURE; do
  base=$(basename "$so")
  if echo "$base" | grep -qE "$EXCL"; then continue; fi
  cp -aL "$so" "/out/lib/$base" 2>/dev/null || true
done

# 3. Dev payload: headers + .so linker symlinks + pkgconfig for bindgen/cc.
for pkg in wpe-webkit-2.0 wpe-1.0 wpebackend-fdo-1.0 libsoup-3.0 glib-2.0 gobject-2.0 gio-2.0 gmodule-2.0 gstreamer-1.0 libepoxy; do
  for hdr in /usr/include/$pkg /usr/include/*/include/$pkg $LIBDIR/glib-2.0/include; do
    [ -d "$hdr" ] || continue
    name=$(basename "$hdr")
    mkdir -p "/out/include/$(dirname "$hdr" | sed 's|.*/include/||;s|.*include$||')"
    cp -a "$hdr" "/out/include/$(dirname "$hdr" | sed "s|$LIBDIR/glib-2.0|glib-2.0|;s|/usr/include/||")/" 2>/dev/null || cp -a "$hdr" /out/include/
  done
done
for so in /out/lib/*.so.*; do
  dev=$(echo "$so" | sed 's/\\.so\\..*/.so/')
  [ -e "$dev" ] || ln -sf "$(basename "$so")" "$dev"
done

# 4. gstreamer plugin dirs (media support — small set).
for d in $LIBDIR/gstreamer-1.0; do
  [ -d "$d" ] && cp -a "$d" /out/lib/
done

# 5. Manifest: what we vendored and where it came from.
dpkg-query -W -f='\${Package} \${Version}\\n' ${PKGS.join(" ")} \
  | sort > /out/manifest/packages.txt
ls /out/lib > /out/manifest/lib.txt
echo "image: $IMAGE, plat: $PLAT" > /out/manifest/source.txt
echo "[fetch-wpe] tar staged payload"
`;

console.log(`[fetch-wpe] image: ${IMAGE}`);
console.log(`[fetch-wpe] dest:  ${DEST}`);
rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });

const run = spawnSync(
  DOCKER,
  [
    "run", "--rm",
    "-v", `${DEST}:/out`,
    "-e", `IMAGE=${IMAGE}`,
    "-e", `PLAT=${PLAT}`,
    IMAGE, "bash", "-lc", INNER,
  ],
  { stdio: "inherit" },
);
if (run.status !== 0) process.exit(run.status ?? 1);

// The tar/closure landed in DEST — check the essentials.
for (const need of [
  "lib/libWPEWebKit-2.0.so.1",
  "lib/libwpe-1.0.so.1",
  "lib/libWPEBackend-fdo-1.0.so.1",
  "libexec/wpe-webkit-2.0/WPEWebProcess",
  "libexec/wpe-webkit-2.0/WPENetworkProcess",
]) {
  if (!existsSync(join(DEST, need))) {
    console.error(`[fetch-wpe] missing expected payload: ${need}`);
    process.exit(1);
  }
}
console.log(`[fetch-wpe] staged → ${DEST}`);
console.log(`[fetch-wpe] next: bun run build:native --pkg=downdraft-webui-wpe`);
