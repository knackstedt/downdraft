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
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
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
    continue;
  }
  const cmd = ["publish", "--access", "public", ...(tag ? ["--tag", tag] : [])];
  if (!dryRun) cmd.push("--provenance");
  console.log(`${dryRun ? "would publish" : "publish"}  ${name}@${pkg.version}`);
  if (dryRun) continue;
  const r = spawnSync("npm", cmd, { cwd: dir, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`FAILED ${name} — aborting (dependents would be broken)`);
    process.exit(1);
  }
  published++;
}
console.log(`${published} package(s) published.`);
