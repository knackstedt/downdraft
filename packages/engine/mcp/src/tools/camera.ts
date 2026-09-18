import type { EngineContext } from "../engine-context";
import type { ToolRegistration } from "../types";
import { errorResult, jsonResult } from "../types";
import type { UndoRedoManager } from "../undo-redo";
function toVec3(arr: [number, number, number]): [number, number, number] {
  return [arr[0], arr[1], arr[2]];
}

export function createCameraTools(ctx: EngineContext, undoRedo: UndoRedoManager): ToolRegistration[] {
  const tools: ToolRegistration[] = [

    {
      def: {
        name: "set_camera",
        description: "Position and aim the camera at a target.",
        inputSchema: {
          type: "object",
          properties: {
            position: {
              type: "array",
              items: { type: "number" },
              description: "Camera position [x, y, z]",
            },
            target: {
              type: "array",
              items: { type: "number" },
              description: "Look-at target [x, y, z]",
            },
            fov: { type: "number", description: "Field of view in degrees" },
            near: { type: "number", description: "Near plane" },
            far: { type: "number", description: "Far plane" },
          },
        },
      },
      handler: (params) => {
        const oldData = ctx.camera.getData();

        if (params.position) {
          const pos = params.position as [number, number, number];
          ctx.camera.position = toVec3(pos);
        }
        if (params.target) {
          const tgt = params.target as [number, number, number];
          ctx.camera.target = toVec3(tgt);
        }
        if (params.fov !== undefined) {
          ctx.camera.fov = (params.fov as number) * (Math.PI / 180);
        }
        if (params.near !== undefined) ctx.camera.near = params.near as number;
        if (params.far !== undefined) ctx.camera.far = params.far as number;

        ctx.camera.orbit(0, 0);

        undoRedo.execute({
          description: `set_camera`,
          undo: () => {
            ctx.camera.position = toVec3(oldData.position as [number, number, number]);
            ctx.camera.target = toVec3(oldData.target as [number, number, number]);
            ctx.camera.fov = oldData.fov;
            ctx.camera.near = oldData.near;
            ctx.camera.far = oldData.far;
            ctx.camera.orbit(0, 0);
          },
          redo: () => {
            if (params.position) {
              const pos = params.position as [number, number, number];
              ctx.camera.position = toVec3(pos);
            }
            if (params.target) {
              const tgt = params.target as [number, number, number];
              ctx.camera.target = toVec3(tgt);
            }
            if (params.fov !== undefined) ctx.camera.fov = (params.fov as number) * (Math.PI / 180);
            if (params.near !== undefined) ctx.camera.near = params.near as number;
            if (params.far !== undefined) ctx.camera.far = params.far as number;
            ctx.camera.orbit(0, 0);
          },
        });

        return jsonResult({
          position: [ctx.camera.position[0], ctx.camera.position[1], ctx.camera.position[2]],
          target: [ctx.camera.target[0], ctx.camera.target[1], ctx.camera.target[2]],
          fov: ctx.camera.fov * (180 / Math.PI),
          near: ctx.camera.near,
          far: ctx.camera.far,
        });
      },
    },

    {
      def: {
        name: "set_camera_mode",
        description: "Set camera mode (orbit, fps, cinematic, follow).",
        inputSchema: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["orbit", "fps", "cinematic", "follow"],
              description: "Camera mode",
            },
            followEntity: { type: "string", description: "Entity key to follow (for follow mode)" },
          },
          required: ["mode"],
        },
      },
      handler: (params) => {
        const mode = params.mode as string;
        const followEntity = params.followEntity as string | undefined;

        const prevFollow = ctx.cameraFollowEntity;

        if (mode === "follow" && followEntity) {
          const entity = ctx.parseEntityKey(followEntity);
          if (!entity || !ctx.isEntityAlive(entity)) {
            return errorResult(`Entity ${followEntity} not found or dead`);
          }
          ctx.cameraFollowEntity = entity;
        } else {
          ctx.cameraFollowEntity = null;
        }

        undoRedo.execute({
          description: `set_camera_mode(${mode})`,
          undo: () => {
            ctx.cameraFollowEntity = prevFollow;
          },
          redo: () => {
            if (mode === "follow" && followEntity) {
              const entity = ctx.parseEntityKey(followEntity);
              if (entity && ctx.isEntityAlive(entity)) {
                ctx.cameraFollowEntity = entity;
              }
            } else {
              ctx.cameraFollowEntity = null;
            }
          },
        });

        return jsonResult({ mode, followEntity: followEntity ?? null });
      },
    },

    {
      def: {
        name: "get_camera_state",
        description: "Get current camera position, target, and parameters.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      handler: () => {
        const data = ctx.camera.getData();
        const followKey = ctx.cameraFollowEntity ? ctx.getEntityKey(ctx.cameraFollowEntity) : null;
        return jsonResult({
          ...data,
          fov: data.fov * (180 / Math.PI),
          followEntity: followKey,
        });
      },
    },

  ];

  return tools;
}
