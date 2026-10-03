#!/usr/bin/env node
// Symlink @downdraft/* engine packages into each game repo's node_modules
// under games/. Games are separate repos (not part of this repo) — clone
// them under games/ or run this anywhere a sibling games/ dir exists.
// No-op where links already point at the right package or games/ is absent.
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    rmSync,
    symlinkSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// Expand the packages/* workspace globs to discover engine packages.
const enginePkgs = new Map();
for (let _i = 0, _it = rootPkg.workspaces ?? [], _n = _it.length; _i < _n; _i++) { const pattern = _it[_i];
  if (!pattern.startsWith("packages/")) continue;
  const star = pattern.endsWith("/*");
  const base = star ? pattern.slice(0, -2) : pattern;
  const dirs = star
    ? readdirSync(join(root, base), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => join(base, d.name))
    : [base];
  for (let _i = 0, _it = dirs, _n = _it.length; _i < _n; _i++) { const dir = _it[_i];
    const manifest = join(root, dir, "package.json");
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    if (pkg.name?.startsWith("@downdraft/")) {
      enginePkgs.set(pkg.name, join(root, dir));
    }
  }
}

// Creates a symlink at linkPath -> target (relative). Returns
// "linked" | "ok" | "realdir".
function ensureLink(linkPath, target) {
  const rel = relative(dirname(linkPath), target);
  const st = lstatSync(linkPath, { throwIfNoEntry: false });
  if (st?.isSymbolicLink()) {
    if (readlinkSync(linkPath) === rel) return "ok";
    rmSync(linkPath);
  } else if (st) {
    return "realdir";
  }
  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(rel, linkPath);
  return "linked";
}

let created = 0;
let existing = 0;
const warnings = [];

const gamesDir = join(root, "games");
if (!existsSync(gamesDir)) {
  console.log("link-games: no games/ directory — nothing to link");
  process.exit(0);
}
for (const entry of readdirSync(gamesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const gameDir = join(root, "games", entry.name);
  if (!existsSync(join(gameDir, "package.json"))) continue;

  for (const [name, target] of enginePkgs.entries()) {
    const linkPath = join(gameDir, "node_modules", "@downdraft", name.slice("@downdraft/".length));
    const result = ensureLink(linkPath, target);
    if (result === "linked") created++;
    else if (result === "ok") existing++;
    else warnings.push(`${entry.name}: ${name} is a real directory, not linking`);
  }

  const cliDir = enginePkgs.get("@downdraft/cli");
  if (cliDir) {
    const result = ensureLink(join(gameDir, "node_modules", ".bin", "draft"), join(cliDir, "src/index.ts"));
    if (result === "linked") created++;
    else if (result === "ok") existing++;
    else warnings.push(`${entry.name}: .bin/draft is a real file, not linking`);
  }
}

warnings.forEach((w) => { console.warn(`link-games: ${w}`);; });
console.log(`link-games: ${created} link(s) created, ${existing} already correct`);
