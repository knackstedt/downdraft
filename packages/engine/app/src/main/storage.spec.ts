import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { cleanupStaleStorage, resolveUserDataDir } from "./storage";

function makeTempUserData(): string {
  return mkdtempSync(join(tmpdir(), "dd-storage-spec-"));
}

describe("resolveUserDataDir", () => {
  it("returns the joined appData/appId path when appId is given", () => {
    const fakeApp = { getPath: (name: string) => (name === "appData" ? "/home/user/.config" : "/home/user/.config/default") };
    expect(resolveUserDataDir(fakeApp as any, "downdraft-my-game")).toBe("/home/user/.config/downdraft-my-game");
  });

  it("falls back to the default userData path when no appId is given", () => {
    const fakeApp = { getPath: (name: string) => "/home/user/.config/default" };
    expect(resolveUserDataDir(fakeApp as any)).toBe("/home/user/.config/default");
  });
});

describe("cleanupStaleStorage", () => {
  it("removes stale LevelDB LOCK files", () => {
    const dir = makeTempUserData();
    mkdirSync(join(dir, "Service Worker"), { recursive: true });
    writeFileSync(join(dir, "Service Worker", "LOCK"), "");
    mkdirSync(join(dir, "IndexedDB"), { recursive: true });
    writeFileSync(join(dir, "IndexedDB", "LOCK"), "");

    cleanupStaleStorage(dir);

    expect(existsSync(join(dir, "Service Worker", "LOCK"))).toBe(false);
    expect(existsSync(join(dir, "IndexedDB", "LOCK"))).toBe(false);
  });

  it("removes a stale Electron SingletonLock symlink", () => {
    const dir = makeTempUserData();
    // Electron's SingletonLock is a symlink pointing at "<host>-<pid>".
    symlinkSync("/nonexistent-host-12345", join(dir, "SingletonLock"));

    cleanupStaleStorage(dir);

    expect(existsSync(join(dir, "SingletonLock"))).toBe(false);
  });

  it("removes a stale SingletonSocket file", () => {
    const dir = makeTempUserData();
    writeFileSync(join(dir, "SingletonSocket"), "");

    cleanupStaleStorage(dir);

    expect(existsSync(join(dir, "SingletonSocket"))).toBe(false);
  });

  it("removes Chromium temp artifacts (.org.chromium.Chromium.*)", () => {
    const dir = makeTempUserData();
    writeFileSync(join(dir, ".org.chromium.Chromium.abc"), "temp");
    writeFileSync(join(dir, ".org.chromium.Chromium.def"), "temp");
    writeFileSync(join(dir, "keep-me.txt"), "data");

    cleanupStaleStorage(dir);

    const remaining = readdirSync(dir);
    expect(remaining).toContain("keep-me.txt");
    expect(remaining).not.toContain(".org.chromium.Chromium.abc");
    expect(remaining).not.toContain(".org.chromium.Chromium.def");
  });

  it("is a no-op when the userData dir is empty/missing", () => {
    const dir = join(tmpdir(), "dd-storage-spec-empty-" + process.pid);
    // dir does not exist yet — should not throw.
    cleanupStaleStorage(dir);
    expect(existsSync(dir)).toBe(false);
  });
});
