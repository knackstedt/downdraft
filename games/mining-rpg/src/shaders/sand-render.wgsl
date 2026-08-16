struct Uniforms {
  gridW: f32,
  gridH: f32,
  time: f32,
  pad: f32,
};

struct CameraUniforms {
  // Camera center in active-grid cell coords
  camX: f32,
  camY: f32,
  // Zoom factor (1 = 1 cell per pixel, >1 = zoomed in)
  zoom: f32,
  // Canvas dimensions in pixels
  canvasW: f32,
  canvasH: f32,
  // Player depth in chunks (for ambient darkening)
  depth: f32,
  pad1: f32,
};

@group(0) @binding(0) var gridTex: texture_2d<u32>;
@group(0) @binding(1) var paletteTex: texture_2d<f32>;
@group(0) @binding(2) var propsTex: texture_2d<f32>;
@group(0) @binding(3) var behindTex: texture_2d<f32>;
@group(0) @binding(4) var<uniform> u: Uniforms;
@group(0) @binding(5) var<uniform> cam: CameraUniforms;

// Returns true if the cell at grid coords c is a non-empty detached cell.
// Out-of-bounds and empty (air) cells are treated as non-detached so that
// detached cells get an outline against the world edge and against air.
fn isDetachedAt(c: vec2<i32>) -> bool {
  if (c.x < 0 || c.x >= i32(u.gridW) || c.y < 0 || c.y >= i32(u.gridH)) {
    return false;
  }
  let p = textureLoad(gridTex, c, 0).r;
  if ((p & 0xffu) == 0u) {
    return false;
  }
  return ((p >> 16u) & 0x10u) != 0u;
}

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  // uv is 0..1 across the fullscreen quad (uv.y=0 at top, uv.y=1 at bottom).
  // Convert to active-grid cell coords using the camera position and zoom.
  // Screen pixel coords (0..canvasW, 0..canvasH), origin at top-left.
  let screenPx = vec2<f32>(uv.x * cam.canvasW, uv.y * cam.canvasH);
  // World cell coords: center the camera, scale by zoom
  let cellX = (screenPx.x - cam.canvasW * 0.5) / cam.zoom + cam.camX;
  let cellY = (screenPx.y - cam.canvasH * 0.5) / cam.zoom + cam.camY;

  let coords = vec2<i32>(i32(cellX), i32(cellY));
  if (coords.x < 0 || coords.x >= i32(u.gridW) || coords.y < 0 || coords.y >= i32(u.gridH)) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }

  let packed = textureLoad(gridTex, coords, 0).r;
  let matId = packed & 0xffu;
  let lifetime = f32((packed >> 8u) & 0xffu) / 255.0;
  let shade = (packed >> 16u) & 0x03u;
  // Bit 4 of the flags field (bit 20 of packed) = FLAG_DETACHED
  let detached = ((packed >> 16u) & 0x10u) != 0u;

  if (matId == 0u) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }

  let palIdx = i32(matId) * 4 + i32(shade);
  let matColor = textureLoad(paletteTex, vec2<i32>(palIdx, 0), 0);

  let props = textureLoad(propsTex, vec2<i32>(i32(matId), 0), 0);
  let brightness = props.b;

  // Detached cells (loosened by mining) get a stronger warm tint plus a dark
  // amber outline along any edge that borders attached terrain or air. This
  // makes loose material clearly readable against static terrain at any zoom.
  var color = matColor.rgb;
  if (detached) {
    color = color * 1.2 + vec3<f32>(0.10, 0.05, 0.0);

    // Outline: draw a dark amber edge where a detached cell touches a
    // non-detached neighbor (attached solid or air). Clusters of detached
    // cells share a single perimeter outline.
    let frac = fract(vec2<f32>(cellX, cellY));
    // Outline thickness in cell-fraction, kept ~1.5px but clamped so it never
    // overwhelms tiny (zoomed-out) or huge (zoomed-in) cells.
    let outlineW = clamp(1.5 / cam.zoom, 0.04, 0.45);
    var onEdge = false;
    if (frac.x < outlineW && !isDetachedAt(coords + vec2<i32>(-1, 0))) {
      onEdge = true;
    } else if (frac.x > (1.0 - outlineW) && !isDetachedAt(coords + vec2<i32>(1, 0))) {
      onEdge = true;
    } else if (frac.y < outlineW && !isDetachedAt(coords + vec2<i32>(0, -1))) {
      onEdge = true;
    } else if (frac.y > (1.0 - outlineW) && !isDetachedAt(coords + vec2<i32>(0, 1))) {
      onEdge = true;
    }
    if (onEdge) {
      // Dark amber: darker than the brightened interior (frames it) but
      // lighter than pure black (visible against air).
      color = mix(color, vec3<f32>(0.22, 0.11, 0.03), 0.7);
    }
  }

  var alpha = matColor.a;
  if (matId == 5u || matId == 50u || matId == 51u) {
    alpha = alpha * (0.85 + 0.15 * lifetime);
  } else if (matId == 6u || matId == 11u || matId == 21u ||
      matId == 22u || matId == 39u) {
    alpha = alpha * (0.4 + 0.6 * lifetime);
  }
  if (matId == 22u) {
    alpha = alpha * 0.15;
  }
  if (matId == 27u) {
    let flicker = 0.5 + 0.5 * sin(u.time * 5.0 + f32(coords.x) * 0.5 + f32(coords.y) * 0.3);
    alpha = alpha * flicker;
  }

  let finalColor = color * brightness;

  // Depth-based ambient darkening: deeper = darker.
  // At depth 0 (surface): full brightness. At depth 20+: 40% brightness.
  // Lava and fire materials are exempt (they emit light).
  var ambient = 1.0 - clamp(cam.depth / 20.0, 0.0, 0.6);
  if (matId == 27u || matId == 6u || matId == 21u) {
    ambient = 1.0; // lava, fire, burning oil emit light
  }

  return vec4<f32>(finalColor * ambient, alpha);
}
