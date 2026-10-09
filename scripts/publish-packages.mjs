// scripts/publish-packages.mjs
// Publishes all public @downdraft/* packages to npm in dependency order.
//
// Usage:
//   node scripts/publish-packages.mjs [--dry-run] [--tag=<tag>] [--filter=<substr>]
//
// Publishing uses `npm publish --provenance` — run inside GitHub Actions with
// `id-token: write` (trusted publishing) or locally with `npm login`.
// Packages whose current version is already on npm are skipped.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const tag = args.find((a) => a.startsWith("--tag="))?.split("=")[1];
const filter = args.find((a) => a.startsWith("--filter="))?.split("=")[1];

// Collect every publishable package (private:true is skipped). Engine
// libraries/modules live inside @downdraft/engine — not separate packages.
const dirs = [];
for (let _i = 0, _it = ["packages"], _n = _it.length; _i < _n; _i++) { const top = _it[_i];
  const abs = join(root, top);
  if (!existsSync(abs)) continue;
  for (const entry of readdirSync(abs)) {
    const dir = join(abs, entry);
    if (statSync(dir).isDirectory() && existsSync(join(dir, "package.json"))) {
      dirs.push(dir);
    }
  }
}

const pkgs = new Map(); // name -> { dir, pkg }
for (let _i = 0, _it = dirs, _n = _it.length; _i < _n; _i++) { const dir = _it[_i];
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  if (!pkg.name?.startsWith("@downdraft/") || pkg.private) continue;
  pkgs.set(pkg.name, { dir, pkg });
}

// The published packages' "default" export condition resolves dist/*.js —
// build the dist trees once up front so a broken build fails before any
// package publishes (per-package prepublishOnly hooks rebuild too, but late).
if (!dryRun) {
  const r = spawnSync("node", [join(root, "scripts/build-dist.mjs")], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error("FAILED build-dist — aborting before any publish");
    process.exit(r.status ?? 1);
  }
  // Verify staged native-* libs export every symbol the JS FFI spec tables
  // declare — a stale artifact otherwise dlopen-fails on consumer machines.
  const sym = spawnSync("node", [join(root, "scripts/check-native-symbols.mjs")], { stdio: "inherit" });
  if (sym.status !== 0) {
    console.error("FAILED check-native-symbols — aborting before any publish");
    process.exit(sym.status ?? 1);
  }
}

// Topo-sort by @downdraft/* dependencies so dependents publish after deps.
const order = [];
const seen = new Set();
function visit(name) {
  if (seen.has(name) || !pkgs.has(name)) return;
  seen.add(name);
  const { pkg } = pkgs.get(name);
  ["dependencies", "peerDependencies"].forEach((field) => {
    for (const dep of Object.keys(pkg[field] ?? {})) visit(dep);
  });
  order.push(name);
}
for (const name of pkgs.keys()) visit(name);

function isPublished(name, version) {
  const r = spawnSync("npm", ["view", `${name}@${version}`, "version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return r.status === 0 && r.stdout.trim() === version;
}

let published = 0;
for (let _i = 0, _it = order, _n = _it.length; _i < _n; _i++) { const name = _it[_i];
  if (filter && !name.includes(filter)) continue;
  const { dir, pkg } = pkgs.get(name);
  if (isPublished(name, pkg.version)) {
    console.log(`skip  ${name}@${pkg.version} (already published)`);
    console.log(`::notice::skip ${name}@${pkg.version} (already on npm)`);
    continue;
  }
  const cmd = ["publish", "--access", "public", ...(tag ? ["--tag", tag] : [])];
  if (!dryRun) cmd.push("--provenance");
  console.log(`${dryRun ? "would publish" : "publish"}  ${name}@${pkg.version}`);
  if (dryRun) continue;
  const r = spawnSync("npm", cmd, { cwd: dir, encoding: "utf8" });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    // Surface the npm error as a workflow annotation — job logs need sign-in,
    // annotations don't.
    const tail = ((r.stderr || "") + (r.stdout || "")).trim().split("\n").slice(-16).join(" | ").slice(0, 1800);
    console.error(`::error::npm publish ${name} failed (exit ${r.status}) — ${tail}`);
    console.error(`FAILED ${name} — aborting (dependents would be broken)`);
    process.exit(1);
  }
  console.log(`::notice::published ${name}@${pkg.version}`);
  published++;
}
console.log(`${published} package(s) published.`);
