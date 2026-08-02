export interface RSMConfig {
  resolution: number;
  maxVPLs: number;
  intensity: number;
  depthBias: number;
  rsmRadius: number;
  enabled: boolean;
}

export const DEFAULT_RSM_CONFIG: RSMConfig = {
  resolution: 512,
  maxVPLs: 512,
  intensity: 1.0,
  depthBias: 0.001,
  rsmRadius: 0.15,
  enabled: false,
};

export interface VPLData {
  position: [number, number, number];
  color: [number, number, number];
  intensity: number;
  range: number;
  normal: [number, number, number];
}

export const VPL_FLOATS = 12; // 3 pos + 1 range + 3 color + 1 intensity + 3 normal + 1 pad
export const VPL_SIZE = VPL_FLOATS * 4; // 48 bytes

export function packVPLsToBuffer(vpls: VPLData[], maxVPLs: number): Float32Array {
  const buf = new Float32Array(maxVPLs * VPL_FLOATS);
  for (let i = 0; i < Math.min(vpls.length, maxVPLs); i++) {
    const vpl = vpls[i];
    const offset = i * VPL_FLOATS;
    buf[offset] = vpl.position[0];
    buf[offset + 1] = vpl.position[1];
    buf[offset + 2] = vpl.position[2];
    buf[offset + 3] = vpl.range;
    buf[offset + 4] = vpl.color[0];
    buf[offset + 5] = vpl.color[1];
    buf[offset + 6] = vpl.color[2];
    buf[offset + 7] = vpl.intensity;
    buf[offset + 8] = vpl.normal[0];
    buf[offset + 9] = vpl.normal[1];
    buf[offset + 10] = vpl.normal[2];
    buf[offset + 11] = 0; // pad
  }
  return buf;
}

export function sampleRSMToVPLs(
  rsmDepth: Float32Array,
  rsmAlbedo: Float32Array,
  rsmNormal: Float32Array,
  rsmFlux: Float32Array,
  width: number,
  height: number,
  lightViewProj: Float32Array,
  invLightViewProj: Float32Array,
  maxVPLs: number,
  intensity: number,
  rsmRadius: number,
): VPLData[] {
  const vpls: VPLData[] = [];
  const sampleStride = Math.max(1, Math.floor((width * height) / maxVPLs));

  let sampleIdx = 0;
  for (let y = 0; y < height && vpls.length < maxVPLs; y++) {
    for (let x = 0; x < width && vpls.length < maxVPLs; x++) {
      if (sampleIdx % sampleStride !== 0) {
        sampleIdx++;
        continue;
      }
      sampleIdx++;

      const pixelIdx = y * width + x;
      const depth = rsmDepth[pixelIdx];
      if (depth >= 1.0) continue;

      // Reconstruct world position from RSM depth
      const u = (x / width) * 2.0 - 1.0;
      const v = (y / height) * 2.0 - 1.0;
      const ndc = [u, -v, depth, 1.0];

      // Transform by inverse light view-proj
      const worldX = invLightViewProj[0] * ndc[0] + invLightViewProj[4] * ndc[1] + invLightViewProj[8] * ndc[2] + invLightViewProj[12] * ndc[3];
      const worldY = invLightViewProj[1] * ndc[0] + invLightViewProj[5] * ndc[1] + invLightViewProj[9] * ndc[2] + invLightViewProj[13] * ndc[3];
      const worldZ = invLightViewProj[2] * ndc[0] + invLightViewProj[6] * ndc[1] + invLightViewProj[10] * ndc[2] + invLightViewProj[14] * ndc[3];
      const worldW = invLightViewProj[3] * ndc[0] + invLightViewProj[7] * ndc[1] + invLightViewProj[11] * ndc[2] + invLightViewProj[15] * ndc[3];

      const pos: [number, number, number] = [worldX / worldW, worldY / worldW, worldZ / worldW];

      const albedoIdx = pixelIdx * 4;
      const color: [number, number, number] = [
        rsmAlbedo[albedoIdx] * rsmFlux[pixelIdx * 3] * intensity,
        rsmAlbedo[albedoIdx + 1] * rsmFlux[pixelIdx * 3 + 1] * intensity,
        rsmAlbedo[albedoIdx + 2] * rsmFlux[pixelIdx * 3 + 2] * intensity,
      ];

      const normalIdx = pixelIdx * 4;
      const normal: [number, number, number] = [
        rsmNormal[normalIdx] * 2.0 - 1.0,
        rsmNormal[normalIdx + 1] * 2.0 - 1.0,
        rsmNormal[normalIdx + 2] * 2.0 - 1.0,
      ];

      vpls.push({
        position: pos,
        color,
        intensity: 1.0,
        range: rsmRadius * 10,
        normal,
      });
    }
  }

  return vpls;
}
