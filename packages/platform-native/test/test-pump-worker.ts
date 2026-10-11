// Worker: loads the SAME platform .so (dlopen dedups — shared QUEUE/NOTIFY
// statics), reports ready, then pushes a QUIT after a delay so the main
// thread's parked sdl_shim_wait_event must wake via the condvar.
import { sdl } from "../src/window/sdl-ffi";

const delay = Number(Bun.env.PUMP_QUIT_DELAY_MS ?? 20);
postMessage("ready");
setTimeout(() => {
  sdl.sdl_shim_request_quit();
  postMessage("quit-pushed");
}, delay);
