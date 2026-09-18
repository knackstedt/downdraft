// Specs for the PE TimeDateStamp patcher.
//
// Builds a minimal in-memory PE image (DOS header + PE signature + COFF
// header), writes it to a temp file, patches it, and asserts the
// TimeDateStamp field is updated correctly. Also covers non-PE files
// being skipped and invalid e_lfanew being rejected.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeSync, mkdirSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchPeTimestamp, patchPeTimestamps } from "./pe-timestamp";

const TMP = join(tmpdir(), "downdraft-pe-timestamp-spec");

beforeEach(() => {
  // Recreate the temp dir for each test so leftover state can't leak.
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
});

/**
 * Build a minimal valid PE image with a given initial TimeDateStamp.
 *
 * Layout:
 *   0x00 .. 0x3f  DOS / MZ header (we only set e_magic and e_lfanew)
 *   0x40 .. 0x43  PE signature ("PE\0\0")
 *   0x44 .. 0x4b  IMAGE_FILE_HEADER (Machine, NumberOfSections, TimeDateStamp, ...)
 *
 * We only care about the TimeDateStamp field at 0x48 (e_lfanew + 8).
 */
function buildMinimalPe(initialTimestamp: number): Buffer {
  const buf = Buffer.alloc(0x80, 0);
  // DOS e_magic = "MZ"
  buf.writeUInt8(0x4d, 0x00);
  buf.writeUInt8(0x5a, 0x01);
  // e_lfanew = 0x40 (uint32 LE at 0x3c)
  buf.writeUInt32LE(0x40, 0x3c);
  // PE signature at 0x40
  buf.write("PE", 0x40, "latin1");
  // IMAGE_FILE_HEADER starts at 0x44.
  //   Machine (uint16) = 0x14c (IMAGE_FILE_MACHINE_I386) — arbitrary.
  buf.writeUInt16LE(0x14c, 0x44);
  //   NumberOfSections (uint16) = 0
  buf.writeUInt16LE(0, 0x46);
  //   TimeDateStamp (uint32) at 0x48
  buf.writeUInt32LE(initialTimestamp >>> 0, 0x48);
  return buf;
}

function writeTempPe(name: string, buf: Buffer): string {
  const path = join(TMP, name);
  writeFileSync(path, buf);
  return path;
}

function readTimestamp(path: string): number {
  const fd = openSync(path, "r");
  try {
    const e_lfanewBuf = Buffer.allocUnsafe(4);
    readSync(fd, e_lfanewBuf, 0, 4, 0x3c);
    const e_lfanew = e_lfanewBuf.readUInt32LE(0);
    const tsBuf = Buffer.allocUnsafe(4);
    readSync(fd, tsBuf, 0, 4, e_lfanew + 8);
    return tsBuf.readUInt32LE(0);
  } finally {
    closeSync(fd);
  }
}

describe("patchPeTimestamp", () => {
  it("writes the supplied unix timestamp into the COFF TimeDateStamp field", async () => {
    const initial = 0x5c14b0c0; // 2018-12-15 ~ Electron's stale timestamp
    const target = Math.floor(Date.now() / 1000);
    const path = writeTempPe("valid.exe", buildMinimalPe(initial));

    const result = await patchPeTimestamp(path, target);

    expect(result).not.toBeNull();
    expect(result!.previous).toBe(initial);
    expect(result!.next).toBe(target >>> 0);
    expect(readTimestamp(path)).toBe(target >>> 0);
  });

  it("truncates fractional timestamps to integer seconds", async () => {
    const path = writeTempPe("frac.exe", buildMinimalPe(1));
    const target = 1700000000.999;
    const result = await patchPeTimestamp(path, target);
    expect(result!.next).toBe(1700000000);
    expect(readTimestamp(path)).toBe(1700000000);
  });

  it("wraps timestamps > uint32 max into the low 32 bits", async () => {
    const path = writeTempPe("wrap.exe", buildMinimalPe(0));
    // 2^33 — low 32 bits should be 0.
    const result = await patchPeTimestamp(path, Math.pow(2, 33));
    expect(result!.next).toBe(0);
    expect(readTimestamp(path)).toBe(0);
  });

  it("skips non-PE files when skipNonPe is true (default)", async () => {
    const notPe = Buffer.from("This is not a PE file, just some text.".repeat(8));
    const path = writeTempPe("not-pe.exe", notPe);
    const result = await patchPeTimestamp(path, 1700000000);
    expect(result).toBeNull();
  });

  it("throws on non-PE files when skipNonPe is false", async () => {
    const notPe = Buffer.from("This is not a PE file, just some text.".repeat(8));
    const path = writeTempPe("not-pe-strict.exe", notPe);
    await expect(patchPeTimestamp(path, 1700000000, { skipNonPe: false })).rejects.toThrow();
  });

  it("skips files smaller than the DOS header", async () => {
    const tiny = Buffer.alloc(8, 0);
    const path = writeTempPe("tiny.exe", tiny);
    const result = await patchPeTimestamp(path, 1700000000);
    expect(result).toBeNull();
  });

  it("skips files with an out-of-range e_lfanew", async () => {
    const buf = buildMinimalPe(0);
    // Point e_lfanew past EOF.
    buf.writeUInt32LE(0xffff_ffff, 0x3c);
    const path = writeTempPe("bad-lfanew.exe", buf);
    const result = await patchPeTimestamp(path, 1700000000);
    expect(result).toBeNull();
  });

  it("throws on out-of-range e_lfanew when skipNonPe is false", async () => {
    const buf = buildMinimalPe(0);
    buf.writeUInt32LE(0xffff_ffff, 0x3c);
    const path = writeTempPe("bad-lfanew-strict.exe", buf);
    await expect(patchPeTimestamp(path, 1700000000, { skipNonPe: false })).rejects.toThrow();
  });
});

describe("patchPeTimestamps", () => {
  it("patches every PE file in the list and skips non-PE files", async () => {
    const a = writeTempPe("a.exe", buildMinimalPe(0));
    const b = writeTempPe("b.exe", buildMinimalPe(0));
    const c = writeTempPe("c.txt", Buffer.from("not a pe file".repeat(20)));
    const target = 1700000123;

    const results = await patchPeTimestamps([a, b, c], target);

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.file).sort()).toEqual([a, b].sort());
    expect(readTimestamp(a)).toBe(target);
    expect(readTimestamp(b)).toBe(target);
  });

  it("returns an empty array for an empty input list", async () => {
    const results = await patchPeTimestamps([], 1700000000);
    expect(results).toEqual([]);
  });

  it("propagates errors from patchPeTimestamp (does not swallow)", async () => {
    // Use a path that does not exist — open() will throw ENOENT.
    const results = patchPeTimestamps([join(TMP, "does-not-exist.exe")], 1700000000);
    await expect(results).rejects.toThrow(/Failed to patch PE timestamp/);
  });
});
