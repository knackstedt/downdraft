import type { EngineContext } from "../engine-context";
import type { MCPResourceResult, ResourceRegistration } from "../types";

function resourceJSON(uri: string, data: unknown): MCPResourceResult {
  return {
    contents: [{
      uri,
      mimeType: "application/json",
      text: JSON.stringify(data, null, 2),
    }],
  };
}

async function queryNvidiaSmi(): Promise<Record<string, unknown> | null> {
  try {
    const { execSync } = await import("child_process");
    const gpuQuery = "utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,clocks.sm,clocks.mem,name,driver_version";
    const output = execSync(
      `nvidia-smi --query-gpu=${gpuQuery} --format=csv,noheader,nounits`,
      { timeout: 3000, encoding: "utf-8" },
    ).trim();

    const labels = gpuQuery.split(",");
    const gpus = output.split("\n").map((line) => {
      const vals = line.trim().split(",").map((v) => v.trim());
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < labels.length && i < vals.length; i++) {
        const num = parseFloat(vals[i]);
        obj[labels[i]] = isNaN(num) ? vals[i] : num;
      }
      return obj;
    });

    return { gpus, source: "nvidia-smi" };
  } catch {
    return null;
  }
}

async function queryNvidiaSmiProcesses(): Promise<Array<Record<string, unknown>> | null> {
  try {
    const { execSync } = await import("child_process");
    const output = execSync(
      "nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits",
      { timeout: 3000, encoding: "utf-8" },
    ).trim();

    if (!output) return [];
    const procs = output.split("\n").map((line) => {
      const vals = line.trim().split(",").map((v) => v.trim());
      return {
        pid: parseInt(vals[0]) || 0,
        processName: vals[1] || "",
        usedMemoryMB: parseFloat(vals[2]) || 0,
      };
    });
    return procs;
  } catch {
    return null;
  }
}

async function queryHostGpuInfo(): Promise<Record<string, unknown> | null> {
  try {
    const bridge = (globalThis as { downdraft?: { getGpuInfo?: () => Promise<Record<string, unknown> | null> } }).downdraft;
    if (typeof bridge?.getGpuInfo === "function") {
      return await bridge.getGpuInfo();
    }
  } catch {
    // No host bridge installed
  }
  return null;
}

export function createGPUInfoResource(ctx: EngineContext): ResourceRegistration[] {
  return [
    {
      def: {
        uri: "downdraft://gpu-info",
        name: "GPU Info",
        description: "Real-time GPU system metrics: utilization, VRAM, temperature, power, clocks, per-process VRAM, host GPU info, and engine resource counts",
        mimeType: "application/json",
      },
      handler: async (uri) => {
        const nvidia = await queryNvidiaSmi();
        const processes = await queryNvidiaSmiProcesses();
        const hostGPU = await queryHostGpuInfo();

        return resourceJSON(uri, {
          nvidiaSmi: nvidia,
          hostGPU: hostGPU,
          processes: processes,
          engineResources: {
            meshes: ctx.meshes.size,
            materials: ctx.materialLibrary.list().length,
          },
          timestamp: Date.now(),
          note: "For live WebGPU adapter info, device limits, resource tracking, and GPU errors, use the DevTools GPU tab or SceneInspector API (getGPUInfo, getGPUErrors, getFrameTelemetry, getGPUResourceStats).",
        });
      },
    },
  ];
}
