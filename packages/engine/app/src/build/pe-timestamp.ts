// ============================================================================
// PE TimeDateStamp patcher
// ============================================================================
//
// electron-builder copies Electron's prebuilt `electron.exe` without
// recompiling, so the PE COFF `TimeDateStamp` field stays at Electron's
// fixed build timestamp (e.g. 2018-12-15). VirusTotal reports this stale
// timestamp as the "Compilation Timestamp", which looks suspicious and is
// simply wrong — the .exe was packaged today, not in 2018.
//
// This module patches the COFF `TimeDateStamp` (uint32 LE at
// `e_lfanew + 8`) of each produced .exe to the actual build time. The
// patch is safe for unsigned portable builds: it only touches 4 bytes in
// the COFF header, does not invalidate the optional-header checksum
// (Electron portable exes ship with a zero checksum), and must run BEFORE
// any code-signing step (signing would otherwise cover the stale
// timestamp and be invalidated by the patch).

import { FileHandle, open } from "node:fs/promises";

/** PE signature bytes ("PE\0\0") that follow the DOS stub. */
const PE_SIGNATURE = Buffer.from([0x50, 0x45, 0x00, 0x00]);
/** Offset of `e_lfanew` (pointer to PE header) in the DOS / MZ header. */
const E_LFANEW_OFFSET = 0x3c;
/** Offset of the COFF `TimeDateStamp` field from the PE signature.
 *  Layout: 4-byte PE sig ("PE\0\0") + IMAGE_FILE_HEADER, where
 *  TimeDateStamp is at byte 4 of the file header (after Machine + NumberOfSections).
 *  So the absolute offset from the PE signature is 4 + 4 = 8. */
const TIMEDATESTAMP_OFFSET_FROM_PE = 8;
/** Size of the `e_lfanew` field (uint32 LE). */
const UINT32 = 4;
/** Minimum size of a valid DOS / MZ header (we need to read e_lfanew). */
const MIN_DOS_SIZE = E_LFANEW_OFFSET + UINT32;
/** Minimum size of a valid PE file to contain the TimeDateStamp field. */
const MIN_PE_SIZE = 0x40 + 4 + 8;

export interface PePatchResult {
  /** Absolute path of the file that was patched. */
  file: string;
  /** Previous TimeDateStamp value (unix seconds). */
  previous: number;
  /** New TimeDateStamp value (unix seconds). */
  next: number;
}

export interface PePatchOptions {
  /** Skip files that are not valid PE images instead of throwing.
   *  Defaults to true — non-.exe artifacts in the output dir are ignored. */
  skipNonPe?: boolean;
}

/**
 * Patch the COFF `TimeDateStamp` of a single file to `unixTimestamp`.
 *
 * @param filePath Absolute path to the .exe to patch.
 * @param unixTimestamp Unix epoch seconds to write into the TimeDateStamp.
 * @param opts      Optional behavior flags.
 * @returns The previous and new timestamp values, or `null` if the file
 *          was skipped (non-PE and `skipNonPe` is true).
 */
export async function patchPeTimestamp(
  filePath: string,
  unixTimestamp: number,
  opts: PePatchOptions = {},
): Promise<PePatchResult | null> {
  const skipNonPe = opts.skipNonPe ?? true;
  const stamp = Math.floor(unixTimestamp) >>> 0;

  let fh: FileHandle | null = null;
  try {
    fh = await open(filePath, "r+");
    const stat = await fh.stat();
    if (stat.size < MIN_PE_SIZE) {
      if (skipNonPe) return null;
      throw new Error(`File too small to be a PE image (${stat.size} bytes): ${filePath}`);
    }

    // Read e_lfanew (uint32 LE at 0x3c).
    const e_lfanewBuf = Buffer.allocUnsafe(UINT32);
    await fh.read(e_lfanewBuf, 0, UINT32, E_LFANEW_OFFSET);
    const e_lfanew = e_lfanewBuf.readUInt32LE(0);
    if (e_lfanew < MIN_DOS_SIZE || e_lfanew + 4 + 8 > stat.size) {
      if (skipNonPe) return null;
      throw new Error(`Invalid e_lfanew=${e_lfanew} for ${filePath} (size=${stat.size})`);
    }

    // Verify the PE signature at e_lfanew.
    const sigBuf = Buffer.allocUnsafe(PE_SIGNATURE.length);
    await fh.read(sigBuf, 0, PE_SIGNATURE.length, e_lfanew);
    if (!sigBuf.equals(PE_SIGNATURE)) {
      if (skipNonPe) return null;
      throw new Error(`Missing PE signature at offset ${e_lfanew} in ${filePath}`);
    }

    // Read the current TimeDateStamp (uint32 LE at e_lfanew + 4).
    const tsOffset = e_lfanew + TIMEDATESTAMP_OFFSET_FROM_PE;
    const curBuf = Buffer.allocUnsafe(UINT32);
    await fh.read(curBuf, 0, UINT32, tsOffset);
    const previous = curBuf.readUInt32LE(0);

    // Write the new timestamp.
    const nextBuf = Buffer.allocUnsafe(UINT32);
    nextBuf.writeUInt32LE(stamp, 0);
    await fh.write(nextBuf, 0, UINT32, tsOffset);

    return { file: filePath, previous, next: stamp };
  } finally {
    if (fh) await fh.close();
  }
}

/**
 * Patch the COFF `TimeDateStamp` of every file in `paths` to
 * `unixTimestamp`. Non-PE files are silently skipped (so a glob over the
 * release dir that includes `.dll`/`.pak`/etc. is safe).
 *
 * @returns Array of results for files that were actually patched.
 */
export async function patchPeTimestamps(
  paths: string[] | readonly string[],
  unixTimestamp: number,
  opts: PePatchOptions = {},
): Promise<PePatchResult[]> {
  const results: PePatchResult[] = [];
  for (let _i = 0, _it = paths, _n = _it.length; _i < _n; _i++) { const p = _it[_i];
    try {
      const r = await patchPeTimestamp(p, unixTimestamp, opts);
      if (r) results.push(r);
    } catch (err) {
      // Re-throw with the path for easier debugging; callers decide whether
      // to abort the whole build or continue.
      throw new Error(
        `Failed to patch PE timestamp for ${p}: ${(err as Error).message}`,
      );
    }
  }
  return results;
}
