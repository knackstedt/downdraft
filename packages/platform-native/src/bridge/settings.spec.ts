// ============================================================================
// settings.spec.ts — typed KV store over <configDir>/settings.json
// ============================================================================

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppSettings } from "./settings";
import { resolveAppDirs } from "./user-data-dir";

const dir = join(tmpdir(), `downdraft-settings-spec-${process.pid}`);
const file = join(dir, "settings.json");

afterAll(() => {
  try { rmSync(dir, { recursive: true }); } catch { /* no-op */ }
});

describe("app settings", () => {
  test("get/set/getAll round-trip with fallbacks", () => {
    const s = createAppSettings(dir);
    expect(s.get("missing")).toBeUndefined();
    expect(s.get("missing", 42)).toBe(42);
    s.set("theme", "dark");
    s.set("volume", 0.5);
    expect(s.get("theme")).toBe("dark");
    expect(s.get("volume")).toBe(0.5);
    expect(s.getAll()).toEqual({ theme: "dark", volume: 0.5 });
  });

  test("set(key, undefined) removes the key", () => {
    const s = createAppSettings(dir);
    s.set("ephemeral", 1);
    s.set("ephemeral", undefined);
    expect(s.get("ephemeral")).toBeUndefined();
    expect("ephemeral" in s.getAll()).toBe(false);
  });

  test("watch fires on same-process set — returns unsubscribe", () => {
    const s = createAppSettings(dir);
    const seen: unknown[] = [];
    const off = s.watch("theme", (v) => seen.push(v));
    s.set("theme", "light");
    s.set("other", "ignored");
    off();
    s.set("theme", "dark");
    expect(seen).toEqual(["light"]);
  });

  test("flush writes atomically — a fresh instance reloads values", () => {
    const s = createAppSettings(dir);
    s.set("persisted", { nested: [1, 2, 3] });
    s.flush();
    expect(existsSync(file)).toBe(true);
    const raw = JSON.parse(readFileSync(file, "utf-8"));
    expect(raw.schemaVersion).toBe(1);
    // New instance over the same dir sees the persisted state.
    const s2 = createAppSettings(dir);
    expect(s2.get("persisted")).toEqual({ nested: [1, 2, 3] });
  });

  test("corrupt file degrades to empty store (and recovers on write)", () => {
    const badDir = join(dir, "corrupt");
    const badFile = join(badDir, "settings.json");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(badFile, "not json {{{");
    const s = createAppSettings(badDir);
    expect(s.getAll()).toEqual({});
    s.set("recovered", true);
    s.flush();
    const s2 = createAppSettings(badDir);
    expect(s2.get("recovered")).toBe(true);
  });
});

describe("resolveAppDirs", () => {
  test("returns the platform-split paths", () => {
    const p = resolveAppDirs("downdraft-spec");
    if (process.platform === "linux") {
      expect(p.configDir).toContain(".config/downdraft-spec");
      expect(p.dataDir).toContain(".local/share/downdraft-spec");
      expect(p.cacheDir).toContain(".cache/downdraft-spec");
    } else {
      expect(p.configDir).toContain("downdraft-spec");
      expect(p.cacheDir).toContain("downdraft-spec");
    }
  });
});
