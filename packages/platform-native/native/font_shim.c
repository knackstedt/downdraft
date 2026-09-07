// ============================================================================
// font_shim.c — SDL2_ttf-based text rasterizer for native mode
//
// Uses SDL2_ttf (which wraps FreeType + HarfBuzz) to render UTF-8 text
// to RGBA pixel data with proper anti-aliasing, Unicode support, and
// font hinting. This handles all the things that are hard to get right
// with raw FreeType: UTF-8 decoding, kerning, shaping, etc.
//
// Provides:
//   - ft_shim_init(font_path) → font handle
//   - ft_shim_render_text(font, text, font_size, out_buf, ...) → RGBA pixels
//   - ft_shim_measure(font, text, font_size) → width
//   - ft_shim_done(font) → cleanup
//
// Compile: gcc -shared -fPIC -o libfont_shim.so font_shim.c $(pkg-config --cflags --libs SDL2_ttf)
// ============================================================================

#include <SDL2/SDL.h>
#include <SDL2/SDL_ttf.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

static int g_ttf_initialized = 0;

long ft_shim_init(const char* font_path) {
    if (!g_ttf_initialized) {
        if (TTF_Init() != 0) {
            fprintf(stderr, "[font_shim] TTF_Init failed: %s\n", TTF_GetError());
            return 0;
        }
        g_ttf_initialized = 1;
    }
    TTF_Font* font = TTF_OpenFont(font_path, 16);
    if (!font) {
        fprintf(stderr, "[font_shim] TTF_OpenFont failed for %s: %s\n", font_path, TTF_GetError());
        return 0;
    }
    return (long)font;
}

// Render UTF-8 text to RGBA pixels using SDL2_ttf.
// Output is RGBA where the text is white (255,255,255) with alpha = coverage.
// The caller composites this with the desired text color.
int ft_shim_render_text(long font_ptr, const char* text, int font_size,
                        unsigned char* out_data, int out_size,
                        int max_width, int max_height,
                        int* width_out, int* height_out) {
    TTF_Font* font = (TTF_Font*)font_ptr;
    if (!font || !text || !out_data) { *width_out = 0; *height_out = 0; return 0; }

    // Set the font size
    TTF_SetFontSize(font, font_size);

    // Render with blended (RGBA) anti-aliasing, white text
    SDL_Color white = { 255, 255, 255, 255 };
    SDL_Surface* surface = TTF_RenderUTF8_Blended(font, text, white);
    if (!surface) {
        *width_out = 0; *height_out = 0; return 0;
    }

    int w = surface->w;
    int h = surface->h;

    // Clamp to max dimensions
    if (w > max_width) w = max_width;
    if (h > max_height) h = max_height;

    int buf_size = w * h * 4;
    if (buf_size > out_size) {
        SDL_FreeSurface(surface);
        *width_out = 0; *height_out = 0; return 0;
    }

    // SDL_Surface pixels are already RGBA (32-bit, blended mode)
    // Copy the pixel data into the output buffer
    unsigned char* src = (unsigned char*)surface->pixels;
    int src_pitch = surface->pitch;
    for (int row = 0; row < h; row++) {
        memcpy(out_data + row * w * 4, src + row * src_pitch, w * 4);
    }

    // Ensure RGB channels are white (255) — SDL_ttf blended mode sets
    // the text color in RGB and coverage in alpha. Since we passed white,
    // RGB should already be 255, but let's be safe.
    for (int i = 0; i < buf_size; i += 4) {
        out_data[i] = 255;
        out_data[i + 1] = 255;
        out_data[i + 2] = 255;
        // Alpha is already correct from SDL_ttf
    }

    SDL_FreeSurface(surface);
    *width_out = w;
    *height_out = h;
    return buf_size;
}

// Measure text width using SDL2_ttf.
int ft_shim_measure(long font_ptr, const char* text, int font_size) {
    TTF_Font* font = (TTF_Font*)font_ptr;
    if (!font || !text) return 0;

    TTF_SetFontSize(font, font_size);
    int w = 0, h = 0;
    if (TTF_SizeUTF8(font, text, &w, &h) != 0) return 0;
    return w;
}

void ft_shim_done(long font_ptr) {
    TTF_Font* font = (TTF_Font*)font_ptr;
    if (font) TTF_CloseFont(font);
}
