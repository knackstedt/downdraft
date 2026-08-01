struct Particle {
  posX: f32, posY: f32, posZ: f32,
  velX: f32, velY: f32, velZ: f32,
  life: f32, size: f32,
  colorR: f32, colorG: f32, colorB: f32,
  alive: f32,
};

struct SimParams {
  deltaTime: f32,
  time: f32,
  spawnCount: f32,
  maxParticles: f32,
  cursor: f32,
  weatherType: f32,
  isSnow: f32,
  _pad0: f32,
  cameraPos: vec3<f32>,
  collisionRadius: f32,
  spawnSpread: f32,
  spawnHeight: f32,
  baseVelY: f32,
  particleSize: f32,
  lifetime: f32,
  colorR: f32, colorG: f32, colorB: f32,
  windX: f32, windZ: f32,
  _pad1: f32, _pad2: f32,
  voxelOrigin: vec3<f32>,
  voxelSize: f32,
  voxelDimX: f32, voxelDimY: f32, voxelDimZ: f32,
  voxelCount: f32,
  isoLevel: f32,
  seed: f32,
};

struct Counter {
  cursor: atomic<u32>,
  activeCount: atomic<u32>,
};

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<uniform> params: SimParams;
@group(0) @binding(2) var<storage, read_write> counter: Counter;
@group(0) @binding(3) var<storage, read> voxelData: array<f32>;

fn hash(seed: ptr<function, u32>) -> f32 {
  *seed = *seed * 1103515245u + 12345u;
  return f32(*seed) / 4294967296.0;
}

fn randRange(seed: ptr<function, u32>, min: f32, max: f32) -> f32 {
  return min + hash(seed) * (max - min);
}

fn sampleVoxel(x: i32, y: i32, z: i32) -> f32 {
  if (x < 0 || x >= i32(params.voxelDimX) ||
      y < 0 || y >= i32(params.voxelDimY) ||
      z < 0 || z >= i32(params.voxelDimZ)) {
    return -1.0;
  }
  let idx = u32(x) * u32(params.voxelDimY) * u32(params.voxelDimZ) + u32(y) * u32(params.voxelDimZ) + u32(z);
  if (idx >= u32(params.voxelCount)) { return -1.0; }
  return voxelData[idx];
}

fn sampleVoxelGrad(p: vec3<f32>) -> vec3<f32> {
  let vs = params.voxelSize;
  let ox = params.voxelOrigin.x;
  let oy = params.voxelOrigin.y;
  let oz = params.voxelOrigin.z;
  let vx = i32(floor((p.x - ox) / vs));
  let vy = i32(floor((p.y - oy) / vs));
  let vz = i32(floor((p.z - oz) / vs));
  let dx = sampleVoxel(vx + 1, vy, vz) - sampleVoxel(vx - 1, vy, vz);
  let dy = sampleVoxel(vx, vy + 1, vz) - sampleVoxel(vx, vy - 1, vz);
  let dz = sampleVoxel(vx, vy, vz + 1) - sampleVoxel(vx, vy, vz - 1);
  let n = vec3<f32>(dx, dy, dz);
  let len = length(n);
  if (len < 1e-6) { return vec3<f32>(0.0, 1.0, 0.0); }
  return n / len;
}

fn voxelDensityAt(p: vec3<f32>) -> f32 {
  let vs = params.voxelSize;
  let ox = params.voxelOrigin.x;
  let oy = params.voxelOrigin.y;
  let oz = params.voxelOrigin.z;
  let vx = i32(floor((p.x - ox) / vs));
  let vy = i32(floor((p.y - oy) / vs));
  let vz = i32(floor((p.z - oz) / vs));
  return sampleVoxel(vx, vy, vz);
}

@compute @workgroup_size(64)
fn cs_emit(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= u32(params.spawnCount)) { return; }

  let cursor = atomicAdd(&counter.cursor, 1u) % u32(params.maxParticles);
  var seed = u32(params.seed) + idx * 7919u + u32(params.time * 1000.0);

  let px = params.cameraPos.x + randRange(&seed, -params.spawnSpread, params.spawnSpread);
  let py = params.cameraPos.y + params.spawnHeight + randRange(&seed, 0.0, params.spawnHeight * 0.3);
  let pz = params.cameraPos.z + randRange(&seed, -params.spawnSpread, params.spawnSpread);

  let vx = params.windX + randRange(&seed, -2.0, 2.0);
  let vy = params.baseVelY + randRange(&seed, -3.0, 3.0);
  let vz = params.windZ + randRange(&seed, -2.0, 2.0);

  particles[cursor].posX = px;
  particles[cursor].posY = py;
  particles[cursor].posZ = pz;
  particles[cursor].velX = vx;
  particles[cursor].velY = vy;
  particles[cursor].velZ = vz;
  particles[cursor].life = params.lifetime + randRange(&seed, -0.5, 0.5);
  particles[cursor].size = params.particleSize;
  particles[cursor].colorR = params.colorR;
  particles[cursor].colorG = params.colorG;
  particles[cursor].colorB = params.colorB;
  particles[cursor].alive = 1.0;
}

@compute @workgroup_size(64)
fn cs_update(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= u32(params.maxParticles)) { return; }

  if (particles[idx].alive < 0.5) { return; }

  var p = particles[idx];

  // Apply gravity (snow has gentler fall)
  let gravity = select(-30.0, -3.0, u32(params.isSnow) == 1u);
  p.velY += gravity * params.deltaTime;

  // Apply wind
  p.velX += params.windX * params.deltaTime * 0.5;
  p.velZ += params.windZ * params.deltaTime * 0.5;

  // Snow: add gentle sway
  if (u32(params.isSnow) == 1u) {
    let swayPhase = params.time * 2.0 + f32(idx) * 0.1;
    p.velX += sin(swayPhase) * 0.5 * params.deltaTime;
    p.velZ += cos(swayPhase * 0.7) * 0.5 * params.deltaTime;
  }

  // Drag — frame-rate independent: pow(perFrameDrag, dt*60) = exp(log(drag)*dt*60)
  let dragRate = select(log(0.99) * 60.0, log(0.98) * 60.0, u32(params.isSnow) == 1u);
  let dragMul = exp(dragRate * params.deltaTime);
  p.velX *= dragMul;
  p.velY *= dragMul;
  p.velZ *= dragMul;

  // Compute new position
  var newPos = vec3<f32>(p.posX, p.posY, p.posZ) + vec3<f32>(p.velX, p.velY, p.velZ) * params.deltaTime;

  // LOD collision: only check voxel density if within collision radius of camera
  // TEMPORARILY DISABLED — voxel collision causing premature particle death
  let distToCam = length(newPos - params.cameraPos);
  if (false && distToCam < params.collisionRadius && u32(params.voxelCount) > 0u) {
    let density = voxelDensityAt(newPos);
    if (density >= params.isoLevel) {
      // Compute surface normal from density gradient (6-tap)
      let normal = sampleVoxelGrad(newPos);

      if (u32(params.isSnow) == 1u) {
        // Snow: stick to surface — zero out velocity, clamp to just above surface
        let surfacePoint = newPos - normal * (density - params.isoLevel) * params.voxelSize * 0.5;
        newPos = surfacePoint + normal * 0.05;
        p.velX = 0.0;
        p.velY = 0.0;
        p.velZ = 0.0;
        // Snow stays longer once settled
        p.life = min(p.life, 2.0);
      } else {
        // Rain: splash and die
        p.alive = 0.0;
        particles[idx] = p;
        return;
      }
    }
  }

  // Kill below water level or if dead
  p.life -= params.deltaTime;
  if (p.life <= 0.0 || newPos.y < -1.0) {
    p.alive = 0.0;
    particles[idx] = p;
    return;
  }

  // Kill if too far from camera (squared distance)
  let dx = newPos.x - params.cameraPos.x;
  let dz = newPos.z - params.cameraPos.z;
  if (dx * dx + dz * dz > 22500.0) {  // 150² — must be > spawnSpread²
    p.alive = 0.0;
    particles[idx] = p;
    return;
  }

  p.posX = newPos.x;
  p.posY = newPos.y;
  p.posZ = newPos.z;

  particles[idx] = p;
}
