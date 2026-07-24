export interface ParticleGPUData {
  position: Float32Array;   // xyz
  velocity: Float32Array;   // xyz
  color: Float32Array;      // rgba
  size: Float32Array;       // 1f
  lifetime: Float32Array;   // current remaining
  maxLifetime: Float32Array;// initial lifetime
  rotation: Float32Array;   // 1f
  angularVelocity: Float32Array; // 1f
  active: Uint8Array;       // 1 per particle
}

export const PARTICLE_STRIDE = 48; // 3 pos + 3 vel + 4 color + 1 size + 1 life + 1 maxLife + 1 rot + 1 angVel + 1 active = 16 floats * 4 bytes (with padding to 48)

export function createParticleGPUData(maxParticles: number): ParticleGPUData {
  return {
    position: new Float32Array(maxParticles * 3),
    velocity: new Float32Array(maxParticles * 3),
    color: new Float32Array(maxParticles * 4),
    size: new Float32Array(maxParticles),
    lifetime: new Float32Array(maxParticles),
    maxLifetime: new Float32Array(maxParticles),
    rotation: new Float32Array(maxParticles),
    angularVelocity: new Float32Array(maxParticles),
    active: new Uint8Array(maxParticles),
  };
}

export function packParticleBuffer(data: ParticleGPUData, maxParticles: number): Float32Array {
  const buf = new Float32Array(maxParticles * 12);
  for (let i = 0; i < maxParticles; i++) {
    const o = i * 12;
    buf[o + 0] = data.position[i * 3 + 0];
    buf[o + 1] = data.position[i * 3 + 1];
    buf[o + 2] = data.position[i * 3 + 2];
    buf[o + 3] = data.color[i * 4 + 0];
    buf[o + 4] = data.color[i * 4 + 1];
    buf[o + 5] = data.color[i * 4 + 2];
    buf[o + 6] = data.color[i * 4 + 3];
    buf[o + 7] = data.size[i];
    buf[o + 8] = data.lifetime[i];
    buf[o + 9] = data.rotation[i];
    buf[o + 10] = data.active[i] ? 1 : 0;
    buf[o + 11] = data.maxLifetime[i] > 0 ? data.lifetime[i] / data.maxLifetime[i] : 0; // normalized age (1=born, 0=dead)
  }
  return buf;
}
