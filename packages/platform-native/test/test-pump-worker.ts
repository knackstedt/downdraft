// Worker: loads the SAME platform .so (dlopen dedups — shared QUEUE/NOTIFY
// statics), reports ready, then pushes a QUIT after a delay so the main
// thread's parked dd_window_wait_event must wake via the condvar.
import { win } from "../src/window/window-ffi";

const delay = Number(Bun.env.PUMP_QUIT_DELAY_MS ?? 20);
postMessage("ready");
setTimeout(() => {
  win.dd_window_request_quit();
  postMessage("quit-pushed");
}, delay);
