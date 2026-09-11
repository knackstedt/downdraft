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
static SDL_Renderer* g_renderer = NULL;
static int g_initialized = 0;

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
    // Do NOT grab input on startup — let the user click the window to
    // engage pointer lock. Grabbing immediately steals focus from whatever
    // the user was doing (IDE, terminal, etc.) which is hostile UX.
    g_initialized = 1;
    return 0;
}

// Get the native window handle for wgpu surface creation.
// On Linux X11: returns the Window (XID) cast to void*.
// On Linux Wayland: returns the wl_surface*.
// On Windows: returns the HWND.
// On macOS: returns the NSWindow*.
// The actual surface creation is handled by wgpu-native's
// wgpuInstanceCreateSurface with the appropriate platform extension.
void* sdl_shim_get_window_handle(void) {
    if (!g_window) return NULL;

    SDL_SysWMinfo wmInfo;
    SDL_VERSION(&wmInfo.version);
    if (!SDL_GetWindowWMInfo(g_window, &wmInfo)) {
        fprintf(stderr, "[sdl_shim] SDL_GetWindowWMInfo failed: %s\n", SDL_GetError());
        return NULL;
    }

#if defined(SDL_VIDEO_DRIVER_X11)
    if (wmInfo.subsystem == SDL_SYSWM_X11) {
        return (void*)wmInfo.info.x11.window;
    }
#endif
#if defined(SDL_VIDEO_DRIVER_WAYLAND)
    if (wmInfo.subsystem == SDL_SYSWM_WAYLAND) {
        return (void*)wmInfo.info.wl.surface;
    }
#endif
#if defined(SDL_VIDEO_DRIVER_WINDOWS)
    if (wmInfo.subsystem == SDL_SYSWM_WINDOWS) {
        return (void*)wmInfo.info.win.window;
    }
#endif
#if defined(SDL_VIDEO_DRIVER_COCOA)
    if (wmInfo.subsystem == SDL_SYSWM_COCOA) {
        return (void*)wmInfo.info.cocoa.window;
    }
#endif

    fprintf(stderr, "[sdl_shim] Unsupported window subsystem: %d\n", wmInfo.subsystem);
    return NULL;
}

// Get the display handle (needed for some surface creation APIs).
void* sdl_shim_get_display_handle(void) {
    if (!g_window) return NULL;

    SDL_SysWMinfo wmInfo;
    SDL_VERSION(&wmInfo.version);
    if (!SDL_GetWindowWMInfo(g_window, &wmInfo)) return NULL;

#if defined(SDL_VIDEO_DRIVER_X11)
    if (wmInfo.subsystem == SDL_SYSWM_X11) {
        return (void*)wmInfo.info.x11.display;
    }
#endif
    return NULL;
}

// Get the window subsystem type.
// Returns: 0=unknown, 1=X11, 2=Wayland, 3=Windows, 4=Cocoa, 5=Android
int sdl_shim_get_window_subsystem(void) {
    if (!g_window) return 0;

    SDL_SysWMinfo wmInfo;
    SDL_VERSION(&wmInfo.version);
    if (!SDL_GetWindowWMInfo(g_window, &wmInfo)) return 0;

    return (int)wmInfo.subsystem;
}

// Get window dimensions.
void sdl_shim_get_window_size(int* width, int* height) {
    if (g_window) {
        SDL_GetWindowSize(g_window, width, height);
    } else {
        *width = 0;
        *height = 0;
    }
}

// Set window title.
void sdl_shim_set_window_title(const char* title) {
    if (g_window) SDL_SetWindowTitle(g_window, title);
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

// Poll one event. Returns the event type (0 = no event).
// out_data: pointer to a buffer for event data:
//   For key events: out_data[0] = keycode (int32)
//   For mouse events: out_data[0] = x, out_data[1] = y (int32 each)
//   For mouse button: out_data[0] = button (1=left, 2=middle, 3=right)
//   For wheel: out_data[0] = delta_x (float as int32 bits), out_data[1] = delta_y
//   For resize: out_data[0] = width, out_data[1] = height
//   For text input: out_data is a char buffer (32 bytes)
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

int sdl_shim_poll_event(void* out_data) {
    if (!g_window) return SDL_SHIM_EVENT_NONE;

    SDL_Event event;
    if (!SDL_PollEvent(&event)) return SDL_SHIM_EVENT_NONE;

    int* iout = (int*)out_data;
    float* fout = (float*)out_data;

    switch (event.type) {
        case SDL_QUIT:
            return SDL_SHIM_EVENT_QUIT;

        case SDL_KEYDOWN:
            iout[0] = (int)event.key.keysym.sym;
            return SDL_SHIM_EVENT_KEY_DOWN;

        case SDL_KEYUP:
            iout[0] = (int)event.key.keysym.sym;
            return SDL_SHIM_EVENT_KEY_UP;

        case SDL_MOUSEMOTION:
            iout[0] = event.motion.x;
            iout[1] = event.motion.y;
            iout[2] = event.motion.xrel;
            iout[3] = event.motion.yrel;
            return SDL_SHIM_EVENT_MOUSE_MOVE;

        case SDL_MOUSEBUTTONDOWN:
            iout[0] = event.button.x;
            iout[1] = event.button.y;
            iout[2] = event.button.button; // 1=left, 2=middle, 3=right
            return SDL_SHIM_EVENT_MOUSE_DOWN;

        case SDL_MOUSEBUTTONUP:
            iout[0] = event.button.x;
            iout[1] = event.button.y;
            iout[2] = event.button.button;
            return SDL_SHIM_EVENT_MOUSE_UP;

        case SDL_MOUSEWHEEL:
            fout[0] = event.wheel.x;
            fout[1] = event.wheel.y;
            return SDL_SHIM_EVENT_WHEEL;

        case SDL_WINDOWEVENT:
            if (event.window.event == SDL_WINDOWEVENT_RESIZED ||
                event.window.event == SDL_WINDOWEVENT_SIZE_CHANGED) {
                iout[0] = event.window.data1; // width
                iout[1] = event.window.data2; // height
                return SDL_SHIM_EVENT_RESIZE;
            }
            // Do NOT re-grab on focus-gained — let the user explicitly
            // click the window to engage pointer lock.
            return SDL_SHIM_EVENT_NONE;

        case SDL_TEXTINPUT:
            strncpy((char*)out_data, event.text.text, 31);
            ((char*)out_data)[31] = '\0';
            return SDL_SHIM_EVENT_TEXT_INPUT;

        default:
            return SDL_SHIM_EVENT_NONE;
    }
}

// ── Surface creation from SDL window ──
// This creates a wgpu surface from the SDL window's native handle.
// We need to include the wgpu header for this.
#include <webgpu/webgpu.h>

extern WGPUInstance g_instance;

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
    if (g_renderer) { SDL_DestroyRenderer(g_renderer); g_renderer = NULL; }
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
