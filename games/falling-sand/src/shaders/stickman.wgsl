struct PlayerUniforms {
  px: f32,       // player x in grid cells
  py: f32,       // player y in grid cells (top of bounding box)
  facing: f32,   // 1 = right, -1 = left
  animFrame: f32,// animation frame counter
  gridW: f32,
  gridH: f32,
  canvasW: f32,
  canvasH: f32,
  health: f32,
  onGround: f32,
  vx: f32,
  vy: f32,
};

@group(0) @binding(0) var<uniform> u: PlayerUniforms;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) color: vec3<f32>,
};

// Convert grid cell coords to clip space
fn gridToClip(gx: f32, gy: f32) -> vec2<f32> {
  let nx = gx / u.gridW * 2.0 - 1.0;
  let ny = gy / u.gridH * 2.0 - 1.0;
  return vec2<f32>(nx, -ny);
}

// Walk cycle: returns leg/arm swing offsets
fn walkCycle(t: f32) -> vec4<f32> {
  let s = sin(t);
  let c = cos(t);
  // legSwingL, legSwingR, armSwingL, armSwingR
  return vec4<f32>(s * 0.5, -s * 0.5, -s * 0.4, s * 0.4);
}

// Jump pose: legs tucked, arms up
fn jumpPose() -> vec4<f32> {
  return vec4<f32>(0.3, -0.3, 0.5, -0.5);
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  // 22 vertices = 11 line segments (line-list topology)
  // Stickman proportions relative to player position (px, py = top of bounding box)
  // Width = 3 cells, Height = 7 cells
  let pw = 3.0;
  let ph = 7.0;
  let cx = u.px;           // center x
  let topY = u.py;         // top of bounding box
  let headR = 0.8;         // head radius
  let headCY = topY + 1.0; // head center y
  let bodyTopY = topY + 1.8;
  let bodyBotY = topY + 4.5;
  let hipY = bodyBotY;
  let legLen = 2.0;
  let armTopY = topY + 2.2;
  let armLen = 1.5;

  // Determine pose
  let moving = abs(u.vx) > 0.01;
  let inAir = u.onGround < 0.5;
  var swing: vec4<f32>;
  if (inAir) {
    swing = jumpPose();
  } else if (moving) {
    swing = walkCycle(u.animFrame * 0.3);
  } else {
    // Idle: slight breathing
    let idle = sin(u.animFrame * 0.05) * 0.05;
    swing = vec4<f32>(idle, -idle, -idle, idle);
  };

  let f = u.facing;
  let halfW = pw * 0.5;

  // Define key points
  let headL = vec2<f32>(cx - headR, headCY);
  let headR_pt = vec2<f32>(cx + headR, headCY);
  let headTop = vec2<f32>(cx, headCY + headR);
  let headBot = vec2<f32>(cx, headCY - headR);
  let neck = vec2<f32>(cx, bodyTopY);
  let hip = vec2<f32>(cx, hipY);
  let shoulder = vec2<f32>(cx, armTopY);

  // Legs: swing forward/back
  let footL = vec2<f32>(cx + swing.x * f, hipY + legLen);
  let footR = vec2<f32>(cx + swing.y * f, hipY + legLen);

  // Arms: opposite swing
  let handL = vec2<f32>(cx + swing.z * f, armTopY + armLen);
  let handR = vec2<f32>(cx + swing.w * f, armTopY + armLen);

  // Health-based color: green=full, yellow=half, red=low
  let hp = clamp(u.health / 100.0, 0.0, 1.0);
  var col: vec3<f32>;
  if (hp > 0.5) {
    col = mix(vec3<f32>(1.0, 0.85, 0.0), vec3<f32>(0.0, 1.0, 0.2), (hp - 0.5) * 2.0);
  } else {
    col = mix(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(1.0, 0.85, 0.0), hp * 2.0);
  }

  var p: vec2<f32>;
  // 11 segments = 22 vertices (line list)
  // 0-1: head circle (approximated as diamond: top->right->bot->left->top)
  //    seg 0: headTop -> headR_pt
  //    seg 1: headR_pt -> headBot
  //    seg 2: headBot -> headL
  //    seg 3: headL -> headTop
  // 4: neck -> hip (body)
  // 5: shoulder -> handL (left arm)
  // 6: shoulder -> handR (right arm)
  // 7: hip -> footL (left leg)
  // 8: hip -> footR (right leg)
  // 9: neck -> shoulder (neck stub)
  // 10: headBot -> neck (connect head to body)
  switch (vi) {
    // seg 0: headTop -> headR_pt
    case 0u: { p = headTop; }
    case 1u: { p = headR_pt; }
    // seg 1: headR_pt -> headBot
    case 2u: { p = headR_pt; }
    case 3u: { p = headBot; }
    // seg 2: headBot -> headL
    case 4u: { p = headBot; }
    case 5u: { p = headL; }
    // seg 3: headL -> headTop
    case 6u: { p = headL; }
    case 7u: { p = headTop; }
    // seg 4: neck -> hip (body)
    case 8u: { p = neck; }
    case 9u: { p = hip; }
    // seg 5: shoulder -> handL
    case 10u: { p = shoulder; }
    case 11u: { p = handL; }
    // seg 6: shoulder -> handR
    case 12u: { p = shoulder; }
    case 13u: { p = handR; }
    // seg 7: hip -> footL
    case 14u: { p = hip; }
    case 15u: { p = footL; }
    // seg 8: hip -> footR
    case 16u: { p = hip; }
    case 17u: { p = footR; }
    // seg 9: headBot -> neck
    case 18u: { p = headBot; }
    case 19u: { p = neck; }
    // seg 10: neck -> shoulder
    case 20u: { p = neck; }
    case 21u: { p = shoulder; }
    default: { p = vec2<f32>(0.0, 0.0); }
  }

  var out: VSOut;
  let clip = gridToClip(p.x, p.y);
  out.pos = vec4<f32>(clip, 0.0, 1.0);
  out.color = col;
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  return vec4<f32>(in.color, 1.0);
}
