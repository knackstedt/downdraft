// ============================================================================
// dialogs.ts — HostAPI dialog/notify surface over the dd_dialog_* FFI group
//
// File pickers are async: dd_dialog_open/save/pick_folder return a request
// id, the detached rfd thread pushes DD_EVENT_DIALOG_RESULT, and the
// NUL-joined path list is pulled with dd_dialog_result_paths. Requests
// resolve to `string[]` — null on cancel or error (Electron returns
// {canceled, filePaths}; a nullable list keeps the call-site one-line).
//
// Message boxes are synchronous: dd_message_box runs the modal on this
// thread and returns the pressed-button index (wrapped in a resolved
// Promise — the blocking native call already produced the answer).
//
// Every method degrades when the optional symbol group is absent (old
// cdylib): pickers resolve null, message box resolves 0, notify resolves
// false — the fs bridge falls back to zenity/kdialog separately.
//
// DD_DIALOGS_MOCK=1 short-circuits here too — the Rust event queue is
// gated on a live window (poll_event returns NONE once the window is
// gone), so routing mock results through FFI would fail in the very
// headless/no-window contexts the mock exists for. The JS mock resolves
// synchronously with the same canned path the Rust side uses.
// ============================================================================

import type {
    HostFileDialogOptions,
    HostMessageBoxOptions,
    HostNotifyOptions,
} from "@downdraft/engine/app/shared/types";
import { createLogger } from "@downdraft/engine/util/logger";
import type { NativeWindow } from "../window/native-window";
import { winDialogs } from "../window/window-ffi";

const log = createLogger("info");

const DIALOG_RESULT_OK = 1;

/** Headless test mode — resolves every picker with a canned path, message
 *  boxes with index 0, notifications with success. Mirrors the Rust-side
 *  DD_DIALOGS_MOCK branch (which stays for direct-FFI callers). */
const DIALOGS_MOCK = () => process.env.DD_DIALOGS_MOCK === "1";
const mockPath = () => process.env.DD_DIALOGS_MOCK_PATH || "/var/tmp/dd-dialog-mock";

export type FileDialogOptions = HostFileDialogOptions;
export type MessageBoxOptions = HostMessageBoxOptions;
export type NotifyOptions = HostNotifyOptions;

export interface NativeDialogs {
  readonly available: boolean;
  showOpenDialog(opts?: FileDialogOptions): Promise<string[] | null>;
  showSaveDialog(opts?: FileDialogOptions): Promise<string | null>;
  pickFolder(opts?: FileDialogOptions): Promise<string[] | null>;
  showMessageBox(opts: MessageBoxOptions): Promise<number>;
  notify(opts: NotifyOptions): Promise<boolean>;
}

export function createNativeDialogs(window: NativeWindow): NativeDialogs {
  const pending = new Map<number, (kind: number) => void>();

  // Results land on the shared event queue — dispatch always trails the
  // synchronous dd_dialog_* call that registered the pending entry, so a
  // plain map suffices (the DD_DIALOGS_MOCK path pushes the event before
  // returning, but it still can't be polled until this synchronous stretch
  // completes and the map is populated).
  // Duck-typed: a minimal/mock window may lack addEventListener — without
  // the listener only the FFI picker path loses its resolver (JS-mock and
  // no-FFI paths never need it).
  window.addEventListener?.("dialogresult", (e: { reqId: number; kind: number }) => {
    const resolve = pending.get(e.reqId);
    if (!resolve) {
      // Unknown request — drain the result anyway so the registry can't
      // grow unboundedly on stray/mismatched completions.
      pullPaths(e.reqId);
      return;
    }
    pending.delete(e.reqId);
    resolve(e.kind);
  });

  const request = (fn: keyof typeof winDialogs, opts: FileDialogOptions): Promise<string[] | null> => {
    if (DIALOGS_MOCK()) return Promise.resolve([mockPath()]);
    const sym = winDialogs[fn];
    if (!sym) return Promise.resolve(null);
    const reqId = (sym as (o: string) => number)(JSON.stringify(opts));
    if (reqId <= 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      pending.set(reqId, (kind) => {
        resolve(kind === DIALOG_RESULT_OK ? pullPaths(reqId) : null);
      });
    });
  };

  return {
    available: Boolean(
      winDialogs.dd_dialog_open &&
      winDialogs.dd_dialog_save &&
      winDialogs.dd_dialog_pick_folder &&
      winDialogs.dd_dialog_result_paths,
    ),

    showOpenDialog: (opts) => request("dd_dialog_open", opts ?? {}),
    showSaveDialog: async (opts) => (await request("dd_dialog_save", opts ?? {}))?.[0] ?? null,
    pickFolder: (opts) => request("dd_dialog_pick_folder", opts ?? {}),

    showMessageBox: (opts) => {
      if (DIALOGS_MOCK()) return Promise.resolve(0);
      const sym = winDialogs.dd_message_box;
      if (!sym) return Promise.resolve(0);
      try {
        return Promise.resolve(sym(JSON.stringify(opts)));
      } catch (e) {
        log.warn("dialogs", `dd_message_box failed: ${(e as Error).message}`);
        return Promise.resolve(-1);
      }
    },

    notify: (opts) => {
      if (DIALOGS_MOCK()) return Promise.resolve(true);
      const sym = winDialogs.dd_notify;
      if (!sym) return Promise.resolve(false);
      try {
        return Promise.resolve(sym(JSON.stringify(opts)) === 0);
      } catch (e) {
        log.warn("dialogs", `dd_notify failed: ${(e as Error).message}`);
        return Promise.resolve(false);
      }
    },
  };
}

/** Pull the NUL-joined path list for a completed request (consumes it).
 *  Two-call snprintf sizing — results can exceed the event's 64-byte
 *  slot budget, which is why paths travel out-of-band. */
function pullPaths(reqId: number): string[] | null {
  const pull = winDialogs.dd_dialog_result_paths;
  if (!pull) return null;
  const needed = pull(reqId, null as any, 0);
  if (needed <= 1) return needed === 1 ? [] : null;
  const buf = new Uint8Array(needed);
  pull(reqId, buf as any, buf.length);
  const text = new TextDecoder().decode(buf.subarray(0, needed - 1));
  return text === "" ? [] : text.split("\0");
}
