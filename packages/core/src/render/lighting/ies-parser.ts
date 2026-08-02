export interface IESProfile {
  label: string;
  photometricType: number;
  lumens: number;
  candelaMultiplier: number;
  numVerticalAngles: number;
  numHorizontalAngles: number;
  verticalAngles: Float32Array;
  horizontalAngles: Float32Array;
  candelaValues: Float32Array;
  width: number;
  height: number;
}

export interface IESLoadOptions {
  label?: string;
  maxTextureSize?: number;
}

export function parseIES(data: string, options?: IESLoadOptions): IESProfile {
  const lines = data.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  let lineIdx = 0;

  const label = options?.label ?? `IES-${Date.now()}`;

  // IES header — "IESNA:LM-63" or just "IESNA"
  const header = lines[lineIdx++] || "";

  // Skip tilt line
  const tilt = lines[lineIdx++] || "";
  void tilt;

  // Read property lines until we hit the numeric data
  // Properties start with "[" and end with "]"
  const properties: Record<string, string> = {};
  while (lineIdx < lines.length && lines[lineIdx].startsWith("[")) {
    const propLine = lines[lineIdx++];
    const match = propLine.match(/\[(.*?)\]/);
    if (match) {
      const parts = match[1].split("=");
      if (parts.length === 2) {
        properties[parts[0].trim()] = parts[1].trim();
      }
    }
  }

  // Now read the numeric data
  // Line format: <lumens> <candelaMultiplier> <numVerticalAngles> <numHorizontalAngles> <photometricType> <unitsType> <width> <length> <height>
  const dimsLine = lines[lineIdx++] || "";
  const dimsParts = dimsLine.split(/\s+/).filter((s) => s.length > 0);

  const lumens = parseFloat(dimsParts[0] || "0");
  const candelaMultiplier = parseFloat(dimsParts[1] || "1");
  const numVerticalAngles = parseInt(dimsParts[2] || "0", 10);
  const numHorizontalAngles = parseInt(dimsParts[3] || "0", 10);
  const photometricType = parseInt(dimsParts[4] || "1", 10);
  const width = parseFloat(dimsParts[6] || "0");
  const height = parseFloat(dimsParts[7] || "0");

  // Read vertical angles
  const verticalAngles = new Float32Array(numVerticalAngles);
  let vIdx = 0;
  while (vIdx < numVerticalAngles && lineIdx < lines.length) {
    const parts = lines[lineIdx++].split(/\s+/).filter((s) => s.length > 0);
    for (const p of parts) {
      if (vIdx < numVerticalAngles) {
        verticalAngles[vIdx++] = parseFloat(p);
      }
    }
  }

  // Read horizontal angles + candela values
  const horizontalAngles = new Float32Array(numHorizontalAngles);
  const candelaValues = new Float32Array(numHorizontalAngles * numVerticalAngles);
  let hIdx = 0;
  let cIdx = 0;

  while (hIdx < numHorizontalAngles && lineIdx < lines.length) {
    // First number on the line is the horizontal angle
    const firstParts = lines[lineIdx++].split(/\s+/).filter((s) => s.length > 0);
    if (firstParts.length === 0) continue;

    horizontalAngles[hIdx] = parseFloat(firstParts[0]);
    const remaining = firstParts.slice(1);
    for (const p of remaining) {
      if (cIdx < candelaValues.length) {
        candelaValues[cIdx++] = parseFloat(p);
      }
    }

    // Read remaining candela values for this horizontal angle
    while (cIdx < (hIdx + 1) * numVerticalAngles && lineIdx < lines.length) {
      const parts = lines[lineIdx++].split(/\s+/).filter((s) => s.length > 0);
      for (const p of parts) {
        if (cIdx < candelaValues.length) {
          candelaValues[cIdx++] = parseFloat(p);
        }
      }
    }
    hIdx++;
  }

  return {
    label,
    photometricType,
    lumens,
    candelaMultiplier,
    numVerticalAngles,
    numHorizontalAngles,
    verticalAngles,
    horizontalAngles,
    candelaValues,
    width,
    height,
  };
}

export function iesProfileToTextureData(
  profile: IESProfile,
  maxWidth: number = 180,
  maxHeight: number = 90,
): { data: Float32Array; width: number; height: number } {
  const width = Math.min(profile.numHorizontalAngles, maxWidth);
  const height = Math.min(profile.numVerticalAngles, maxHeight);
  const data = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const hIdx = Math.min(x, profile.numHorizontalAngles - 1);
      const vIdx = Math.min(y, profile.numVerticalAngles - 1);
      const candela = profile.candelaValues[hIdx * profile.numVerticalAngles + vIdx];
      data[y * width + x] = candela * profile.candelaMultiplier;
    }
  }

  return { data, width, height };
}

export function createIESGpuTexture(
  device: GPUDevice,
  profile: IESProfile,
  maxWidth: number = 180,
  maxHeight: number = 90,
): GPUTexture {
  const { data, width, height } = iesProfileToTextureData(profile, maxWidth, maxHeight);

  const texture = device.createTexture({
    label: `ies-${profile.label}`,
    size: [width, height],
    format: "r16float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });

  device.queue.writeTexture(
    { texture },
    data as unknown as BufferSource,
    { bytesPerRow: width * 2, rowsPerImage: height },
    [width, height],
  );

  return texture;
}
