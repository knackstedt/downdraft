struct PlayerUniforms {
  px: f32,       // player x in world cell coords
  py: f32,       // player y in world cell coords (top of bounding box)
  facing: f32,   // 1 = right, -1 = left
  animFrame: f32,
  camX: f32,     // camera center x in world cell coords
  camY: f32,     // camera center y in world cell coords
  zoom: f32,     // camera zoom
  canvasW: f32,  // canvas width in pixels
  canvasH: f32,  // canvas height in pixels
  health: f32,
  onGround: f32,
  vx: f32,
  vy: f32,
};

@group(0) @binding(0) var<uniform> u: PlayerUniforms;
@group(0) @binding(1) var lightTex: texture_2d<f32>;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) color: vec3<f32>,
  @location(1) localPos: vec2<f32>,
};

// Convert world cell coords to clip space using camera
fn worldToClip(wx: f32, wy: f32) -> vec2<f32> {
  let clipX = (wx - u.camX) * u.zoom * 2.0 / u.canvasW;
  let clipY = -(wy - u.camY) * u.zoom * 2.0 / u.canvasH;
  return vec2<f32>(clipX, clipY);
}

fn walkCycle(t: f32) -> vec4<f32> {
  let s = sin(t);
  return vec4<f32>(s * 0.5, -s * 0.5, -s * 0.4, s * 0.4);
}

fn jumpPose() -> vec4<f32> {
  return vec4<f32>(0.3, -0.3, 0.5, -0.5);
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  let pw = 3.0;
  let ph = 7.0;
  let cx = u.px;
  let topY = u.py;
  let headR = 0.8;
  let headCY = topY + 1.0;
  let bodyTopY = topY + 1.8;
  let bodyBotY = topY + 4.5;
  let hipY = bodyBotY;
  let legLen = 2.0;
  let armTopY = topY + 2.2;
  let armLen = 1.5;

  let moving = abs(u.vx) > 0.01;
  let inAir = u.onGround < 0.5;
  var swing: vec4<f32>;
  if (inAir) {
    swing = jumpPose();
  } else if (moving) {
    swing = walkCycle(u.animFrame * 0.3);
  } else {
    let idle = sin(u.animFrame * 0.05) * 0.05;
    swing = vec4<f32>(idle, -idle, -idle, idle);
  };

  let f = u.facing;

  let headL = vec2<f32>(cx - headR, headCY);
  let headR_pt = vec2<f32>(cx + headR, headCY);
  let headTop = vec2<f32>(cx, headCY + headR);
  let headBot = vec2<f32>(cx, headCY - headR);
  let neck = vec2<f32>(cx, bodyTopY);
  let hip = vec2<f32>(cx, hipY);
  let shoulder = vec2<f32>(cx, armTopY);

  let footL = vec2<f32>(cx + swing.x * f, hipY + legLen);
  let footR = vec2<f32>(cx + swing.y * f, hipY + legLen);
  let handL = vec2<f32>(cx + swing.z * f, armTopY + armLen);
  let handR = vec2<f32>(cx + swing.w * f, armTopY + armLen);

  let hp = clamp(u.health / 100.0, 0.0, 1.0);
  var col: vec3<f32>;
  if (hp > 0.5) {
    col = mix(vec3<f32>(1.0, 0.85, 0.0), vec3<f32>(0.0, 1.0, 0.2), (hp - 0.5) * 2.0);
  } else {
    col = mix(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(1.0, 0.85, 0.0), hp * 2.0);
  }

  var p: vec2<f32>;
  switch (vi) {
    case 0u: { p = headTop; }
    case 1u: { p = headR_pt; }
    case 2u: { p = headR_pt; }
    case 3u: { p = headBot; }
    case 4u: { p = headBot; }
    case 5u: { p = headL; }
    case 6u: { p = headL; }
    case 7u: { p = headTop; }
    case 8u: { p = neck; }
    case 9u: { p = hip; }
    case 10u: { p = shoulder; }
    case 11u: { p = handL; }
    case 12u: { p = shoulder; }
    case 13u: { p = handR; }
    case 14u: { p = hip; }
    case 15u: { p = footL; }
    case 16u: { p = hip; }
    case 17u: { p = footR; }
    case 18u: { p = headBot; }
    case 19u: { p = neck; }
    case 20u: { p = neck; }
    case 21u: { p = shoulder; }
    default: { p = vec2<f32>(0.0, 0.0); }
  }

  var out: VSOut;
  let clip = worldToClip(p.x, p.y);
  out.pos = vec4<f32>(clip, 0.0, 1.0);
  out.color = col;
  out.localPos = vec2<f32>(p.x, p.y);
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  // Sample the light accumulation texture at the player's local position (half-res)
  let lightCoords = vec2<i32>(i32(in.localPos.x) / 2, i32(in.localPos.y) / 2);
  let lightSample = textureLoad(lightTex, lightCoords, 0);
  let lighting = lightSample.rgb;
  return vec4<f32>(in.color * lighting, 1.0);
}
