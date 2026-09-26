// ============================================================================
// sdl_shim.c — thin C wrapper over SDL2 for window creation + event polling
//
// Creates a native window, extracts the window handle for wgpu surface
// creation, and polls events (keyboard, mouse, resize, close).
//
// Compile: gcc -shared -fPIC -o libsdl_shim.so sdl_shim.c $(pkg-config --cflags --libs sdl2)
// ============================================================================

#include <SDL2/SDL.h>
#include <SDL2/SDL_syswm.h>
#include <stdio.h>
#include <string.h>

static SDL_Window* g_window = NULL;
static int g_initialized = 0;

// ── Window title ──
// Some SDL2 builds only write the legacy WM_NAME property (XA_STRING —
// nominally Latin-1) on X11, so a UTF-8 title like "Model Viewer — Native"
// renders as mojibake ("…Viewer â€" Native") in WMs that honor it. The
// modern _NET_WM_NAME (UTF8_STRING) property is what KWin/GNOME actually
// display — set it ourselves. Wayland/Windows/macOS take UTF-8 natively.
#if defined(SDL_VIDEO_DRIVER_X11)
static void x11_set_utf8_title(const char* title) {
    if (!g_window || !title) return;
    SDL_SysWMinfo wmInfo;
    SDL_VERSION(&wmInfo.version);
    if (SDL_GetWindowWMInfo(g_window, &wmInfo) && wmInfo.subsystem == SDL_SYSWM_X11) {
        Display* dpy = wmInfo.info.x11.display;
        Atom netWmName = XInternAtom(dpy, "_NET_WM_NAME", False);
        Atom utf8String = XInternAtom(dpy, "UTF8_STRING", False);
        XChangeProperty(dpy, wmInfo.info.x11.window, netWmName, utf8String, 8,
                        PropModeReplace, (const unsigned char*)title, (int)strlen(title));
        XFlush(dpy);
    }
}
#else
static void x11_set_utf8_title(const char* title) { (void)title; }
#endif

// ── Window creation ──

// Create a window. Returns 0 on success, non-zero on failure.
// width/height: window dimensions
// title: window title (UTF-8)
int sdl_shim_create_window(const char* title, int width, int height) {
    if (g_initialized) return 0;

    if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_EVENTS) < 0) {
        fprintf(stderr, "[sdl_shim] SDL_Init failed: %s\n", SDL_GetError());
        return 1;
    }

    g_window = SDL_CreateWindow(
        title,
        SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
        width, height,
        SDL_WINDOW_SHOWN | SDL_WINDOW_RESIZABLE
    );

    if (!g_window) {
        fprintf(stderr, "[sdl_shim] SDL_CreateWindow failed: %s\n", SDL_GetError());
        return 2;
    }

    SDL_ShowWindow(g_window);
    x11_set_utf8_title(title);
    // Do NOT grab input on startup — let the user click the window to
    // engage pointer lock. Grabbing immediately steals focus from whatever
    // the user was doing (IDE, terminal, etc.) which is hostile UX.
    g_initialized = 1;
    return 0;
}

// ── Event polling ──

// Event types returned by sdl_shim_poll_event
#define SDL_SHIM_EVENT_NONE       0
#define SDL_SHIM_EVENT_QUIT       1
#define SDL_SHIM_EVENT_KEY_DOWN   2
#define SDL_SHIM_EVENT_KEY_UP     3
#define SDL_SHIM_EVENT_MOUSE_MOVE 4
#define SDL_SHIM_EVENT_MOUSE_DOWN 5
#define SDL_SHIM_EVENT_MOUSE_UP   6
#define SDL_SHIM_EVENT_WHEEL      7
#define SDL_SHIM_EVENT_RESIZE     8
#define SDL_SHIM_EVENT_TEXT_INPUT 9
#define SDL_SHIM_EVENT_FOCUS_LOST 10
#define SDL_SHIM_EVENT_MOVED      11
#define SDL_SHIM_EVENT_DROP_FILE  12
#define SDL_SHIM_EVENT_FOCUS_GAINED 13

// Poll one event. Returns the event type (0 = no event).
// out_data: pointer to a buffer for event data (int32 slots):
//   Key:        [0]=keycode, [1]=SDL_Keymod bitmask, [2]=repeat flag
//   Mouse move: [0]=x, [1]=y, [2]=xrel, [3]=yrel, [4]=button state, [5]=mod
//   Mouse btn:  [0]=x, [1]=y, [2]=button (1=l,2=m,3=r), [3]=button state, [4]=mod
//   Wheel:      [0]=delta_x (f32 bits), [1]=delta_y (f32 bits), [2]=mod,
//               [3]=mouse_x, [4]=mouse_y
//   Resize:     [0]=width, [1]=height
//   Text input: out_data is a char buffer (32 bytes)
// ── Input grab ──
// SDL_SetRelativeMouseMode: hides cursor, captures mouse to the window,
// and delivers relative motion via event.motion.xrel/yrel.
// SDL_SetWindowGrab: grabs both mouse AND keyboard to the window.
// Together these provide proper FPS-style input capture.

void sdl_shim_grab_input(int grab) {
    if (!g_window) return;
    if (grab) {
        SDL_SetWindowGrab(g_window, SDL_TRUE);
        SDL_SetRelativeMouseMode(SDL_TRUE);
    } else {
        SDL_SetRelativeMouseMode(SDL_FALSE);
        SDL_SetWindowGrab(g_window, SDL_FALSE);
    }
}

// ── Text input (IME-aware) ──
// SDL_StartTextInput enables text input events (SDL_TEXTINPUT) for the
// window. This is needed for the console REPL input field. When text input
// is active, SDL sends SDL_TEXTINPUT events for printable characters and
// SDL_KEYDOWN events for control keys (Backspace, Enter, arrows, etc.).
// SDL_StopTextInput disables text input events.

void sdl_shim_start_text_input(void) {
    if (g_window) SDL_StartTextInput();
}

void sdl_shim_stop_text_input(void) {
    if (g_window) SDL_StopTextInput();
}

// Set the text input rect (for IME candidate window positioning).
void sdl_shim_set_text_input_rect(int x, int y, int w, int h) {
    if (g_window) {
        SDL_Rect r = { x, y, w, h };
        SDL_SetTextInputRect(&r);
    }
}

// ── Window queries ──

// Returns the SDL_SysWMinfo subsystem tag (SDL_SYSWM_X11, _WAYLAND, _WINDOWS,
// _COCOA, ...) or -1 on failure. Useful for diagnostics/logging.
int sdl_shim_get_window_subsystem(void) {
    if (!g_window) return -1;
    SDL_SysWMinfo wmInfo;
    SDL_VERSION(&wmInfo.version);
    if (!SDL_GetWindowWMInfo(g_window, &wmInfo)) return -1;
    return (int)wmInfo.subsystem;
}

// Current window size in pixels (reflects live resizes — the value SDL
// reports may differ from what the swapchain was last configured with).
void sdl_shim_get_window_size(int* width_out, int* height_out) {
    int w = 0, h = 0;
    if (g_window) SDL_GetWindowSize(g_window, &w, &h);
    if (width_out) *width_out = w;
    if (height_out) *height_out = h;
}

// Update the window title (e.g. to show FPS in the title bar).
void sdl_shim_set_window_title(const char* title) {
    if (g_window && title) {
        SDL_SetWindowTitle(g_window, title);
        x11_set_utf8_title(title);
    }
}

// ── Fullscreen / window geometry / display info ──

// Toggle borderless-desktop fullscreen (SDL_WINDOW_FULLSCREEN_DESKTOP keeps
// the native display mode, avoiding mode-switch flicker).
void sdl_shim_set_fullscreen(int enabled) {
    if (!g_window) return;
    SDL_SetWindowFullscreen(g_window, enabled ? SDL_WINDOW_FULLSCREEN_DESKTOP : 0);
}

// Current window position (for window-state persistence).
void sdl_shim_get_window_pos(int* x_out, int* y_out) {
    int x = 0, y = 0;
    if (g_window) SDL_GetWindowPosition(g_window, &x, &y);
    if (x_out) *x_out = x;
    if (y_out) *y_out = y;
}

void sdl_shim_set_window_pos(int x, int y) {
    if (g_window) SDL_SetWindowPosition(g_window, x, y);
}

// Window frame border sizes (titlebar height in top_out, side/bottom frame
// widths in the rest). Returns SDL_GetWindowBordersSize's code: 0 once the
// WM has framed the window (_NET_FRAME_EXTENTS on X11), negative before
// that or when the WM doesn't report extents.
int sdl_shim_get_window_borders(int* top_out, int* left_out, int* bottom_out, int* right_out) {
    int t = 0, l = 0, b = 0, r = 0;
    int rc = g_window ? SDL_GetWindowBordersSize(g_window, &t, &l, &b, &r) : -1;
    if (top_out) *top_out = t;
    if (left_out) *left_out = l;
    if (bottom_out) *bottom_out = b;
    if (right_out) *right_out = r;
    return rc;
}

// Resize the window (window-state persistence restores saved bounds).
void sdl_shim_set_window_size(int width, int height) {
    if (g_window) SDL_SetWindowSize(g_window, width, height);
}

// Query the display the window is on: refresh rate (Hz) and content scale
// factor (DPI / 96). Writes 0/1.0 on failure.
void sdl_shim_get_display_info(int* refresh_out, float* scale_out) {
    int refresh = 0;
    float scale = 1.0f;
    if (g_window) {
        int idx = SDL_GetWindowDisplayIndex(g_window);
        if (idx >= 0) {
            SDL_DisplayMode mode;
            if (SDL_GetCurrentDisplayMode(idx, &mode) == 0 && mode.refresh_rate > 0) {
                refresh = mode.refresh_rate;
            }
            float ddpi = 0.0f;
            if (SDL_GetDisplayDPI(idx, &ddpi, NULL, NULL) == 0 && ddpi > 0.0f) {
                scale = ddpi / 96.0f;
            }
        }
    }
    if (refresh_out) *refresh_out = refresh;
    if (scale_out) *scale_out = scale;
}

// Push an SDL_QUIT event so the event loop exits through the normal close
// path (JS "close" listeners fire, cleanup runs).
void sdl_shim_request_quit(void) {
    SDL_Event ev;
    memset(&ev, 0, sizeof(ev));
    ev.type = SDL_QUIT;
    SDL_PushEvent(&ev);
}

// Modal error dialog — used for uncaughtException / unhandledRejection
// parity with the Electron error dialog.
int sdl_shim_show_message_box(const char* title, const char* message) {
    return SDL_ShowSimpleMessageBox(SDL_MESSAGEBOX_ERROR,
        title ? title : "Error",
        message ? message : "",
        g_window);
}

// ── Clipboard ──

void sdl_shim_set_clipboard(const char* text) {
    if (text) SDL_SetClipboardText(text);
}

// Copy the clipboard text into out (NUL-terminated). Returns the number of
// bytes that would have been written (like snprintf), or 0 on empty/failure.
int sdl_shim_get_clipboard(char* out, int max_len) {
    if (!out || max_len <= 0) return 0;
    out[0] = '\0';
    char* text = SDL_GetClipboardText();
    if (!text) return 0;
    int len = (int)strlen(text);
    int copy = len < max_len - 1 ? len : max_len - 1;
    memcpy(out, text, copy);
    out[copy] = '\0';
    SDL_free(text);
    return len;
}

// Translate an SDL_Event into the flat out_data layout. Returns the shim
// event type (SDL_SHIM_EVENT_NONE for events we don't surface).
static int translate_event(const SDL_Event* event, void* out_data) {
    int* iout = (int*)out_data;
    float* fout = (float*)out_data;

    switch (event->type) {
        case SDL_QUIT:
            return SDL_SHIM_EVENT_QUIT;

        case SDL_KEYDOWN:
            iout[0] = (int)event->key.keysym.sym;
            iout[1] = (int)event->key.keysym.mod;
            iout[2] = (int)event->key.repeat;
            return SDL_SHIM_EVENT_KEY_DOWN;

        case SDL_KEYUP:
            iout[0] = (int)event->key.keysym.sym;
            iout[1] = (int)event->key.keysym.mod;
            iout[2] = 0;
            return SDL_SHIM_EVENT_KEY_UP;

        case SDL_MOUSEMOTION:
            iout[0] = event->motion.x;
            iout[1] = event->motion.y;
            iout[2] = event->motion.xrel;
            iout[3] = event->motion.yrel;
            iout[4] = (int)event->motion.state; // SDL_BUTTON bitmask
            iout[5] = (int)SDL_GetModState();
            return SDL_SHIM_EVENT_MOUSE_MOVE;

        case SDL_MOUSEBUTTONDOWN:
        case SDL_MOUSEBUTTONUP:
            iout[0] = event->button.x;
            iout[1] = event->button.y;
            iout[2] = event->button.button; // 1=left, 2=middle, 3=right
            iout[3] = (int)SDL_GetMouseState(NULL, NULL); // post-event state
            iout[4] = (int)SDL_GetModState();
            return event->type == SDL_MOUSEBUTTONDOWN
                ? SDL_SHIM_EVENT_MOUSE_DOWN : SDL_SHIM_EVENT_MOUSE_UP;

        case SDL_MOUSEWHEEL:
            // preciseX/Y carry fractional detents for hi-res scroll devices
            // (touchpads); x/y are the integer detents. SDL +y = scrolled
            // away (up) — the TS side negates/scales to DOM pixel deltas.
            fout[0] = event->wheel.preciseX;
            fout[1] = event->wheel.preciseY;
            iout[2] = (int)SDL_GetModState();
            // DOM WheelEvent carries pointer coords — include them so
            // clientX/clientY exist for hit-testing and position tracking.
            iout[3] = event->wheel.mouseX;
            iout[4] = event->wheel.mouseY;
            return SDL_SHIM_EVENT_WHEEL;

        case SDL_WINDOWEVENT:
            if (event->window.event == SDL_WINDOWEVENT_RESIZED ||
                event->window.event == SDL_WINDOWEVENT_SIZE_CHANGED) {
                iout[0] = event->window.data1; // width
                iout[1] = event->window.data2; // height
                return SDL_SHIM_EVENT_RESIZE;
            }
            if (event->window.event == SDL_WINDOWEVENT_MOVED) {
                iout[0] = event->window.data1; // x
                iout[1] = event->window.data2; // y
                return SDL_SHIM_EVENT_MOVED;
            }
            if (event->window.event == SDL_WINDOWEVENT_FOCUS_LOST) {
                // Lets JS clear its pressed-keys tracking so keys don't get
                // "stuck" when focus is lost mid-press.
                return SDL_SHIM_EVENT_FOCUS_LOST;
            }
            if (event->window.event == SDL_WINDOWEVENT_FOCUS_GAINED) {
                return SDL_SHIM_EVENT_FOCUS_GAINED;
            }
            // Do NOT re-grab on focus-gained — let the user explicitly
            // click the window to engage pointer lock.
            return SDL_SHIM_EVENT_NONE;

        case SDL_DROPFILE:
            // event.drop.file is a heap-allocated path that must be SDL_free'd.
            if (event->drop.file) {
                strncpy((char*)out_data, event->drop.file, 255);
                ((char*)out_data)[255] = '\0';
                SDL_free(event->drop.file);
            } else {
                ((char*)out_data)[0] = '\0';
            }
            return SDL_SHIM_EVENT_DROP_FILE;

        case SDL_TEXTINPUT:
            strncpy((char*)out_data, event->text.text, 31);
            ((char*)out_data)[31] = '\0';
            return SDL_SHIM_EVENT_TEXT_INPUT;

        default:
            return SDL_SHIM_EVENT_NONE;
    }
}

int sdl_shim_poll_event(void* out_data) {
    if (!g_window) return SDL_SHIM_EVENT_NONE;

    SDL_Event event;
    if (!SDL_PollEvent(&event)) return SDL_SHIM_EVENT_NONE;

    return translate_event(&event, out_data);
}

// Block up to timeout_ms for an event. Returns the shim event type, or
// SDL_SHIM_EVENT_NONE on timeout. Used to pace the event loop when no
// rAF callbacks are pending so the loop doesn't busy-spin.
int sdl_shim_wait_event(void* out_data, uint32_t timeout_ms) {
    if (!g_window) { SDL_Delay(timeout_ms); return SDL_SHIM_EVENT_NONE; }

    SDL_Event event;
    if (!SDL_WaitEventTimeout(&event, (int)timeout_ms)) return SDL_SHIM_EVENT_NONE;

    return translate_event(&event, out_data);
}

// ── Surface creation from SDL window ──
// This creates a wgpu surface from the SDL window's native handle.
// We need to include the wgpu header for this.
#include <webgpu/webgpu.h>

WGPUSurface sdl_shim_create_wgpu_surface(WGPUInstance instance) {
    if (!g_window) return NULL;

    SDL_SysWMinfo wmInfo;
    SDL_VERSION(&wmInfo.version);
    if (!SDL_GetWindowWMInfo(g_window, &wmInfo)) {
        fprintf(stderr, "[sdl_shim] Failed to get WM info for surface: %s\n", SDL_GetError());
        return NULL;
    }

    WGPUSurfaceDescriptor desc = {0};
    desc.nextInChain = NULL;
    desc.label = (WGPUStringView){0};

#if defined(SDL_VIDEO_DRIVER_X11)
    if (wmInfo.subsystem == SDL_SYSWM_X11) {
        static WGPUSurfaceSourceXlibWindow x11Desc;
        x11Desc.chain.next = NULL;
        x11Desc.chain.sType = WGPUSType_SurfaceSourceXlibWindow;
        x11Desc.display = wmInfo.info.x11.display;
        x11Desc.window = wmInfo.info.x11.window;
        desc.nextInChain = (const WGPUChainedStruct*)&x11Desc;
        return wgpuInstanceCreateSurface(instance, &desc);
    }
#endif
#if defined(SDL_VIDEO_DRIVER_WAYLAND)
    if (wmInfo.subsystem == SDL_SYSWM_WAYLAND) {
        static WGPUSurfaceSourceWaylandSurface wlDesc;
        wlDesc.chain.next = NULL;
        wlDesc.chain.sType = WGPUSType_SurfaceSourceWaylandSurface;
        wlDesc.display = wmInfo.info.wl.display;
        wlDesc.surface = wmInfo.info.wl.surface;
        desc.nextInChain = (const WGPUChainedStruct*)&wlDesc;
        return wgpuInstanceCreateSurface(instance, &desc);
    }
#endif
#if defined(SDL_VIDEO_DRIVER_WINDOWS)
    if (wmInfo.subsystem == SDL_SYSWM_WINDOWS) {
        static WGPUSurfaceSourceWindowsHWND winDesc;
        winDesc.chain.next = NULL;
        winDesc.chain.sType = WGPUSType_SurfaceSourceWindowsHWND;
        winDesc.hinstance = GetModuleHandle(NULL);
        winDesc.hwnd = wmInfo.info.win.window;
        desc.nextInChain = (const WGPUChainedStruct*)&winDesc;
        return wgpuInstanceCreateSurface(instance, &desc);
    }
#endif
#if defined(SDL_VIDEO_DRIVER_COCOA)
    if (wmInfo.subsystem == SDL_SYSWM_COCOA) {
        static WGPUSurfaceSourceMetalLayer metalDesc;
        metalDesc.chain.next = NULL;
        metalDesc.chain.sType = WGPUSType_SurfaceSourceMetalLayer;
        metalDesc.window = wmInfo.info.cocoa.window;
        desc.nextInChain = (const WGPUChainedStruct*)&metalDesc;
        return wgpuInstanceCreateSurface(instance, &desc);
    }
#endif

    fprintf(stderr, "[sdl_shim] Unsupported window subsystem for surface: %d\n", wmInfo.subsystem);
    return NULL;
}

// ── Cleanup ──

void sdl_shim_destroy_window(void) {
    if (g_window) { SDL_DestroyWindow(g_window); g_window = NULL; }
    SDL_Quit();
    g_initialized = 0;
}

// ── Vsync / present ──
// On SDL2, we don't use SDL_GL_SwapWindow because we're using wgpu for rendering.
// The wgpu surface's present() function handles presentation.
// But we can use SDL_Delay for frame pacing if needed.

void sdl_shim_delay(uint32_t ms) {
    SDL_Delay(ms);
}
