// scripts/bump-version.mjs
// Syncs every publishable @downdraft/* package to the root package.json
// version — the single version source of truth. publish.yml enforces the
// same lockstep against the pushed v<version> tag.
//
// Usage:
//   node scripts/bump-version.mjs              # sync packages to root version
//   node scripts/bump-version.mjs --to=X.Y.Z   # set root version first, then sync
//   node scripts/bump-version.mjs --dry-run
//
// Also rewrites @downdraft/* ranges in dependencies/devDependencies/
// peerDependencies/optionalDependencies to ^<version> — 0.x caret ranges
// don't span minor bumps, so a 0.1.x → 0.2.0 bump must move them or the
// published packages would resolve an old engine. workspace:* specs are
// left alone.
//
// Afterwards run `bun install` so bun.lock matches — publish.yml installs
// with --frozen-lockfile and fails on a stale lockfile.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const to = args.find((a) => a.startsWith("--to="))?.split("=")[1];

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const rootFile = join(root, "package.json");
const rootPkg = JSON.parse(readFileSync(rootFile, "utf8"));
if (to) {
  if (!SEMVER.test(to)) {
    console.error(`--to=${to} is not a semver version`);
    process.exit(1);
  }
  if (rootPkg.version !== to) {
    console.log(`${dryRun ? "would set" : "set"}  root version ${rootPkg.version} → ${to}`);
    rootPkg.version = to;
    if (!dryRun) writeFileSync(rootFile, JSON.stringify(rootPkg, null, 2) + "\n");
  }
}
const version = rootPkg.version;

const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

let changed = 0;
for (const entry of readdirSync(join(root, "packages"))) {
  const dir = join(root, "packages", entry);
  const file = join(dir, "package.json");
  if (!statSync(dir).isDirectory() || !existsSync(file)) continue;
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  if (!pkg.name?.startsWith("@downdraft/") || pkg.private) continue;

  const changes = [];
  if (pkg.version !== version) {
    changes.push(`version ${pkg.version} → ${version}`);
    pkg.version = version;
  }
  for (const field of DEP_FIELDS) {
    for (const [dep, range] of Object.entries(pkg[field] ?? {})) {
      if (!dep.startsWith("@downdraft/") || range.startsWith("workspace:")) continue;
      const next = `^${version}`;
      if (range !== next) {
        changes.push(`${field}.${dep} ${range} → ${next}`);
        pkg[field][dep] = next;
      }
    }
  }

  if (changes.length === 0) {
    console.log(`ok    ${pkg.name}@${version}`);
    continue;
  }
  console.log(`${dryRun ? "would bump" : "bump"}  ${pkg.name}: ${changes.join(", ")}`);
  if (!dryRun) writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  changed++;
}

console.log(dryRun
  ? `dry run — ${changed} package(s) would change`
  : `${changed} package(s) bumped — run "bun install" to refresh bun.lock, then tag v${version}`);
