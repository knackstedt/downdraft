// ============================================================================
// singleton-lock.spec.ts — lock + second-instance forwarding coverage
//
// Forwarding is exercised single-process: writing a foreign live PID (init)
// into the lock file makes acquire take the refused path — it then pushes
// this process's {argv,cwd} to the socket our own primary listener serves.
// ============================================================================

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  acquireSingleInstanceLock,
  onSecondInstance,
  releaseSingleInstanceLock,
} from "./singleton-lock";
import { resolveNativeUserDataDir } from "./user-data-dir";

const APP_ID = `downdraft-spec-${process.pid}`;
const dir = resolveNativeUserDataDir(APP_ID);
const lockPath = join(dir, "singleton.lock");
const sockPath = join(dir, "instance.sock");

afterAll(() => {
  releaseSingleInstanceLock();
  try { rmSync(dir, { recursive: true }); } catch { /* no-op */ }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("singleton lock + second-instance forwarding", () => {
  test("first acquire takes the lock and starts the listener", async () => {
    expect(await acquireSingleInstanceLock(APP_ID)).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf-8").trim()).toBe(String(process.pid));
    // The listener socket exists on POSIX (win32 uses a named pipe).
    if (process.platform !== "win32") {
      // listen() is async — give it a tick to bind.
      for (let i = 0; i < 20 && !existsSync(sockPath); i++) await sleep(10);
      expect(existsSync(sockPath)).toBe(true);
    }
  });

  test("re-acquire by the same process is a no-op reclaim", async () => {
    expect(await acquireSingleInstanceLock(APP_ID)).toBe(true);
  });

  test("a refused instance forwards {argv,cwd} to the primary", async () => {
    const received: { argv: string[]; cwd: string }[] = [];
    const off = onSecondInstance((d) => received.push(d));

    // Forge a foreign live-PID lock — acquire takes the refused path and
    // forwards to the socket our primary listener is bound to.
    writeFileSync(lockPath, "1"); // init — always alive
    expect(await acquireSingleInstanceLock(APP_ID)).toBe(false);

    for (let i = 0; i < 50 && received.length === 0; i++) await sleep(10);
    expect(received).toEqual([{ argv: process.argv, cwd: process.cwd() }]);
    off();

    // The forged lock didn't overwrite ours — reclaim by rewriting.
    writeFileSync(lockPath, String(process.pid));
  });

  test("a dead-PID lock is reclaimed", async () => {
    // Impossible-high pid — guaranteed dead.
    writeFileSync(lockPath, "4194303");
    expect(await acquireSingleInstanceLock(APP_ID)).toBe(true);
    expect(readFileSync(lockPath, "utf-8").trim()).toBe(String(process.pid));
  });

  test("release removes the lock and socket", () => {
    releaseSingleInstanceLock();
    expect(existsSync(lockPath)).toBe(false);
    if (process.platform !== "win32") expect(existsSync(sockPath)).toBe(false);
    // Re-acquire afterwards works cleanly (fresh listener).
  });

  test("DOWNDRAFT_MULTI_INSTANCE bypasses the lock entirely", async () => {
    process.env.DOWNDRAFT_MULTI_INSTANCE = "1";
    try {
      writeFileSync(lockPath, "1");
      expect(await acquireSingleInstanceLock(APP_ID)).toBe(true);
    } finally {
      delete process.env.DOWNDRAFT_MULTI_INSTANCE;
    }
  });
});
