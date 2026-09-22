// ============================================================================
// native-fs-bridge.ts — native implementation of the model-viewer `mv` bridge
//
// The Electron build exposes `downdraft.mv` over IPC (see
// games/downdraft-model-viewer/src/main.ts). On the native host there's no IPC
// — the same surface is implemented directly over node:fs, and file dialogs
// go through zenity/kdialog when available (SDL2 has no file dialog).
//
// Attach from a game's native entry:
//   (globalThis as any).downdraft.mv = createNativeMvBridge(host.window, { ... });
// ============================================================================

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { NativeWindow } from "../window/native-window";

export interface NativeFsTreeEntry {
  name: string;
  path: string;
  isDir: boolean;
  children?: NativeFsTreeEntry[];
}

export interface NativeMvBridgeOptions {
  /** Filter applied to files in listDir (e.g. model + companion extensions).
   *  Directories are always descended into; a dir is only listed when it
   *  contains at least one matching file. Default: accept all files. */
  fileFilter?: (name: string) => boolean;
  /** Extra argv-derived paths already validated by the caller — returned once
   *  from initialPaths(). Default: files/dirs passed on the command line. */
  initialPaths?: string[];
  /** File-dialog helper: "zenity" (default), "kdialog", or a custom binary. */
  dialogTool?: string;
}

async function listDirTree(dir: string, fileFilter: ((n: string) => boolean) | undefined, depth = 0): Promise<NativeFsTreeEntry[]> {
  if (depth > 8) return [];
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const entries: NativeFsTreeEntry[] = [];
  for (const d of dirents) {
    if (d.name.startsWith(".")) continue;
    const full = join(dir, d.name);
    if (d.isDirectory()) {
      const children = await listDirTree(full, fileFilter, depth + 1);
      if (children.length > 0) entries.push({ name: d.name, path: full, isDir: true, children });
    } else if (!fileFilter || fileFilter(d.name.toLowerCase())) {
      entries.push({ name: d.name, path: full, isDir: false });
    }
  }
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  return entries;
}

function runDialog(argv: string[]): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", () => resolvePromise(null)); // tool not installed
    child.on("close", (code) => {
      // zenity exits 1 on cancel; kdialog similar.
      resolvePromise(code === 0 && out.trim().length > 0 ? out.trim() : null);
    });
  });
}

export function createNativeMvBridge(window: NativeWindow, opts: NativeMvBridgeOptions = {}) {
  let initialPathsDrained = false;
  const openPathListeners = new Set<(paths: string[]) => void>();

  // Drag-dropped files map to "open" paths, matching the Electron
  // mv:open-paths channel (files dropped onto the window open in the viewer).
  window.addEventListener("dropfile", (e: any) => {
    const p = e?.path ?? e?.data;
    if (typeof p === "string" && p.length > 0) {
      for (const cb of openPathListeners) cb([p]);
    }
  });

  const cliPaths = (): string[] =>
    opts.initialPaths ?? process.argv.slice(2).filter((a) => !a.startsWith("-")).map((a) => resolve(a));

  const openDialog = async (mode: "files" | "folder"): Promise<string[] | null> => {
    const tool = opts.dialogTool ?? "zenity";
    const argv = tool === "kdialog"
      ? (mode === "folder" ? [tool, "--getexistingdirectory"] : [tool, "--getopenfilename", "", "*", "--multiple", "--separate-output"])
      : (mode === "folder"
          ? [tool, "--file-selection", "--directory"]
          : [tool, "--file-selection", "--multiple", "--separator=\n"]);
    const out = await runDialog(argv);
    return out ? out.split("\n").filter(Boolean) : null;
  };

  const saveDialog = async (defaultName: string, _filterName: string, ext: string): Promise<string | null> => {
    const tool = opts.dialogTool ?? "zenity";
    const suggested = join(homedir(), `${defaultName}.${ext}`);
    const argv = tool === "kdialog"
      ? [tool, "--getsavefilename", suggested]
      : [tool, "--file-selection", "--save", "--confirm-overwrite", `--filename=${suggested}`];
    return runDialog(argv);
  };

  return {
    homedir: async () => homedir(),

    readFile: async (path: string): Promise<ArrayBuffer> => {
      const buf = await readFile(path);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    },

    stat: async (path: string) => {
      try {
        const s = await stat(path);
        return { exists: true, isDir: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs };
      } catch {
        return { exists: false, isDir: false, size: 0, mtimeMs: 0 };
      }
    },

    listDir: (path: string) => listDirTree(resolve(path), opts.fileFilter),

    listShallow: async (path: string) => {
      try {
        const dirents = await readdir(resolve(path), { withFileTypes: true });
        return dirents
          .filter((d) => !d.name.startsWith("."))
          .map((d) => ({ name: d.name, isDir: d.isDirectory() }));
      } catch {
        return [];
      }
    },

    initialPaths: async () => {
      if (initialPathsDrained) return [];
      initialPathsDrained = true;
      const out: string[] = [];
      for (const p of cliPaths()) {
        try {
          const s = await stat(p);
          if (s.isDirectory() || s.isFile()) out.push(p);
        } catch { /* doesn't exist — skip */ }
      }
      return out;
    },

    onOpenPaths: (cb: (paths: string[]) => void) => {
      openPathListeners.add(cb);
      return () => openPathListeners.delete(cb);
    },

    showOpenDialog: (o: { mode: "files" | "folder" }) => openDialog(o.mode),

    showSaveDialog: (defaultName: string, filterName: string, ext: string) =>
      saveDialog(defaultName, filterName, ext),

    writeFile: async (path: string, data: ArrayBuffer | string) => {
      try {
        mkdirSync(dirname(path), { recursive: true });
        await writeFile(path, typeof data === "string" ? data : Buffer.from(data));
        return { success: true, path };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    },

    readFileDataUrl: async (path: string) => {
      try {
        const buf = await readFile(path);
        const ext = basename(path).split(".").pop()?.toLowerCase() ?? "png";
        const mime = ext === "jpg" ? "jpeg" : ext;
        return `data:image/${mime};base64,${buf.toString("base64")}`;
      } catch {
        return null;
      }
    },
  };
}

export type NativeMvBridge = ReturnType<typeof createNativeMvBridge>;
