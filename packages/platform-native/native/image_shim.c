// ============================================================================
// image_shim.c — stb_image-based image decoder for native mode
//
// Provides:
//   - decode_image(data, size, width_out, height_out, channels_out) → pixel data
//   - free_image(ptr)
//
// Compile: gcc -shared -fPIC -o libimage_shim.so image_shim.c -lm
// ============================================================================

#define STB_IMAGE_IMPLEMENTATION
#include "stb_image.h"
#include <stdlib.h>
#include <string.h>

// Decode image data (PNG, JPEG, BMP, TGA, etc.).
// Copies the decoded RGBA pixel data into the provided output buffer.
// Returns 0 on success, non-zero on failure.
// *width_out, *height_out, *channels_out are set to the image dimensions.
int image_shim_decode(const unsigned char* data, int size, unsigned char* out_data, int out_size, int* width_out, int* height_out, int* channels_out) {
    int width, height, channels;
    unsigned char* pixels = stbi_load_from_memory(data, size, &width, &height, &channels, 4); // force RGBA
    if (!pixels) {
        return 1;
    }
    int pixel_size = width * height * 4;
    if (out_size < pixel_size) {
        stbi_image_free(pixels);
        return 2;
    }
    memcpy(out_data, pixels, pixel_size);
    stbi_image_free(pixels);
    *width_out = width;
    *height_out = height;
    *channels_out = 4;
    return 0;
}

// Decode image from file path.
int image_shim_decode_file(const char* path, unsigned char* out_data, int out_size, int* width_out, int* height_out, int* channels_out) {
    int width, height, channels;
    unsigned char* pixels = stbi_load(path, &width, &height, &channels, 4);
    if (!pixels) {
        return 1;
    }
    int pixel_size = width * height * 4;
    if (out_size < pixel_size) {
        stbi_image_free(pixels);
        return 2;
    }
    memcpy(out_data, pixels, pixel_size);
    stbi_image_free(pixels);
    *width_out = width;
    *height_out = height;
    *channels_out = 4;
    return 0;
}

// Free image data returned by image_shim_decode.
void image_shim_free(unsigned char* ptr) {
    if (ptr) stbi_image_free(ptr);
}

// Get image dimensions without decoding the full image.
// Returns 0 on success, non-zero on failure.
int image_shim_info(const unsigned char* data, int size, int* width_out, int* height_out, int* channels_out) {
    int width, height, channels;
    if (!stbi_info_from_memory(data, size, &width, &height, &channels)) {
        return 1;
    }
    *width_out = width;
    *height_out = height;
    *channels_out = channels;
    return 0;
}
