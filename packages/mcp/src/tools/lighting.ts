import type { EngineContext } from "../engine-context.ts";
import { LightType, createDirectionalLight, createPointLight } from "../engine-context.ts";
import type { ToolRegistration } from "../types.ts";
import { jsonResult, errorResult } from "../types.ts";
import type { UndoRedoManager } from "../undo-redo.ts";
import type { Light, DirectionalLight } from "@downdraft/core";

function toVec3(arr: [number, number, number]): Float32Array {
  return new Float32Array(arr);
}

export function createLightingTools(ctx: EngineContext, undoRedo: UndoRedoManager): ToolRegistration[] {
  const tools: ToolRegistration[] = [

    {
      def: {
        name: "add_light",
        description: "Add a light to the scene (directional, point, or spot).",
        inputSchema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["directional", "point", "spot"],
              description: "Light type",
            },
            direction: {
              type: "array",
              items: { type: "number" },
              description: "Direction (for directional/spot)",
            },
            position: {
              type: "array",
              items: { type: "number" },
              description: "Position (for point/spot)",
            },
            color: {
              type: "array",
              items: { type: "number" },
              description: "RGB color [0-1]",
            },
            intensity: { type: "number", description: "Light intensity" },
            range: { type: "number", description: "Range (for point/spot)" },
            castShadows: { type: "boolean", description: "Cast shadows (directional)" },
          },
          required: ["type"],
        },
      },
      handler: (params) => {
        const type = params.type as string;
        const color = (params.color as [number, number, number]) ?? [1, 1, 1];
        const intensity = (params.intensity as number) ?? 1.0;

        let light: Light;

        if (type === "directional") {
          const dir = (params.direction as [number, number, number]) ?? [0.5, 0.8, 0.3];
          light = createDirectionalLight(
            toVec3(dir),
            toVec3(color),
            intensity,
            (params.castShadows as boolean) ?? true,
          );
        } else if (type === "point") {
          const pos = (params.position as [number, number, number]) ?? [0, 5, 0];
          light = createPointLight(toVec3(pos), toVec3(color), intensity, (params.range as number) ?? 20);
        } else if (type === "spot") {
          const pos = (params.position as [number, number, number]) ?? [0, 5, 0];
          const dir = (params.direction as [number, number, number]) ?? [0, -1, 0];
          light = {
            type: LightType.Spot,
            position: toVec3(pos),
            direction: toVec3(dir),
            color: toVec3(color),
            intensity,
            range: (params.range as number) ?? 20,
            innerConeAngle: 0.5,
            outerConeAngle: 0.8,
          } as unknown as Light;
        } else {
          return errorResult(`Unknown light type: ${type}`);
        }

        const index = ctx.lights.length;
        ctx.lights.push(light);

        undoRedo.execute({
          description: `add_light("${type}", #${index})`,
          undo: () => { ctx.lights.splice(index, 1); },
          redo: () => { ctx.lights.push(light); },
        });

        return jsonResult({ lightIndex: index, type, intensity, color });
      },
    },

    {
      def: {
        name: "set_sun_angle",
        description: "Quickly set the sun (directional light) angle by elevation and azimuth.",
        inputSchema: {
          type: "object",
          properties: {
            elevation: { type: "number", description: "Sun elevation in degrees (0=horizon, 90=zenith)" },
            azimuth: { type: "number", description: "Sun azimuth in degrees (0=north, 90=east)" },
            intensity: { type: "number", description: "Sun intensity" },
          },
          required: ["elevation", "azimuth"],
        },
      },
      handler: (params) => {
        const elevation = (params.elevation as number) * Math.PI / 180;
        const azimuth = (params.azimuth as number) * Math.PI / 180;
        const intensity = (params.intensity as number) ?? 3.0;

        const dir: [number, number, number] = [
          Math.cos(elevation) * Math.sin(azimuth),
          Math.sin(elevation),
          Math.cos(elevation) * Math.cos(azimuth),
        ];
        const dirVec = toVec3(dir);

        const existingDir = ctx.lights.findIndex((l) => l.type === LightType.Directional);

        if (existingDir >= 0) {
          const oldLight = ctx.lights[existingDir] as DirectionalLight;
          const newLight = createDirectionalLight(dirVec, oldLight.color, intensity, oldLight.castShadows);
          ctx.lights[existingDir] = newLight;

          undoRedo.execute({
            description: `set_sun_angle(${params.elevation}°, ${params.azimuth}°)`,
            undo: () => { ctx.lights[existingDir] = oldLight; },
            redo: () => { ctx.lights[existingDir] = createDirectionalLight(dirVec, oldLight.color, intensity, oldLight.castShadows); },
          });
        } else {
          const light = createDirectionalLight(dirVec, toVec3([1, 1, 0.95]), intensity, true);
          ctx.lights.push(light);

          undoRedo.execute({
            description: `set_sun_angle(${params.elevation}°, ${params.azimuth}°)`,
            undo: () => { ctx.lights.pop(); },
            redo: () => { ctx.lights.push(light); },
          });
        }

        return jsonResult({
          elevation: params.elevation,
          azimuth: params.azimuth,
          direction: dir,
          intensity,
        });
      },
    },

    {
      def: {
        name: "remove_light",
        description: "Remove a light by index.",
        inputSchema: {
          type: "object",
          properties: {
            index: { type: "number", description: "Light index" },
          },
          required: ["index"],
        },
      },
      handler: (params) => {
        const index = params.index as number;
        if (index < 0 || index >= ctx.lights.length) {
          return errorResult(`Light index ${index} out of range (0-${ctx.lights.length - 1})`);
        }

        const removed = ctx.lights.splice(index, 1)[0];

        undoRedo.execute({
          description: `remove_light(#${index})`,
          undo: () => { ctx.lights.splice(index, 0, removed); },
          redo: () => { ctx.lights.splice(index, 1); },
        });

        return jsonResult({ removed: true, index, type: removed.type });
      },
    },

    {
      def: {
        name: "list_lights",
        description: "List all lights in the scene.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      handler: () => {
        const lights = ctx.lights.map((l, i) => ({
          index: i,
          type: l.type,
          intensity: l.intensity,
          color: [...l.color],
          ...(l.type === LightType.Directional ? { direction: [...l.direction], castShadows: l.castShadows } : {}),
          ...(l.type === LightType.Point ? { position: [...l.position], range: l.range } : {}),
          ...(l.type === LightType.Spot ? { position: [...l.position], direction: [...l.direction], range: l.range } : {}),
        }));
        return jsonResult({ count: lights.length, lights });
      },
    },

  ];

  return tools;
}
