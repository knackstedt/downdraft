import type { EngineContext } from "../engine-context";
import type { ToolRegistration } from "../types";
import { jsonResult, errorResult } from "../types";
import type { UndoRedoManager } from "../undo-redo";
import { physicsBackendRegistry, PhysicsRealm } from "@downdraft/core";
import type { ColliderShape, BodyType, RigidBodyHandle } from "@downdraft/core";

export function createPhysicsTools(ctx: EngineContext, undoRedo: UndoRedoManager): ToolRegistration[] {
  const tools: ToolRegistration[] = [

    {
      def: {
        name: "create_physics_realm",
        description: "Create an isolated physics realm (world).",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Realm name" },
            gravity: {
              type: "array",
              items: { type: "number" },
              description: "Gravity vector [x, y, z]",
            },
          },
          required: ["name"],
        },
      },
      handler: (params) => {
        const name = params.name as string;
        const backend = physicsBackendRegistry.getDefault();
        if (!backend) return errorResult("No physics backend registered");

        const gravity = (params.gravity as [number, number, number]) ?? [0, -9.81, 0];
        const realm = new PhysicsRealm(backend, {
          name,
          gravity,
        });

        ctx.physicsRealms.set(name, realm);

        return jsonResult({ realm: name, id: realm.id, gravity });
      },
    },

    {
      def: {
        name: "add_collider",
        description: "Add a collider to an entity's physics body.",
        inputSchema: {
          type: "object",
          properties: {
            entity: { type: "string", description: "Entity key" },
            shape: {
              type: "string",
              enum: ["box", "sphere", "capsule"],
              description: "Collider shape",
            },
            halfExtents: {
              type: "array",
              items: { type: "number" },
              description: "Box half extents [x, y, z]",
            },
            radius: { type: "number", description: "Sphere/capsule radius" },
            halfHeight: { type: "number", description: "Capsule half height" },
            friction: { type: "number" },
            restitution: { type: "number" },
            realm: { type: "string", description: "Physics realm name (default: first)" },
          },
          required: ["entity", "shape"],
        },
      },
      handler: (params) => {
        const entityKey = params.entity as string;
        const entity = ctx.parseEntityKey(entityKey);
        if (!entity || !ctx.isEntityAlive(entity)) {
          return errorResult(`Entity ${entityKey} not found or dead`);
        }

        const shapeType = params.shape as string;
        let shape: ColliderShape;
        if (shapeType === "box") {
          const he = (params.halfExtents as [number, number, number]) ?? [0.5, 0.5, 0.5];
          shape = { type: "box", halfExtents: he };
        } else if (shapeType === "sphere") {
          shape = { type: "sphere", radius: (params.radius as number) ?? 0.5 };
        } else if (shapeType === "capsule") {
          shape = { type: "capsule", halfHeight: (params.halfHeight as number) ?? 0.5, radius: (params.radius as number) ?? 0.3 };
        } else {
          return errorResult(`Unknown shape: ${shapeType}`);
        }

        const realmName = (params.realm as string) ?? ctx.physicsRealms.keys().next().value;
        const realm = ctx.physicsRealms.get(realmName);
        if (!realm) return errorResult(`Physics realm "${realmName}" not found`);

        const handleKey = entityKey;
        let handle = ctx.bodyHandles.get(handleKey);
        if (!handle) {
          handle = realm.createBody(
            {
              type: "dynamic",
              position: [0, 0, 0],
              rotation: [0, 0, 0, 1],
            },
            entity,
          );
          ctx.bodyHandles.set(handleKey, handle);
        }

        const colliderId = realm.addCollider(handle, {
          shape,
          friction: (params.friction as number) ?? 0.5,
          restitution: (params.restitution as number) ?? 0.3,
        });

        return jsonResult({ entity: entityKey, shape: shapeType, colliderId, realm: realmName });
      },
    },

    {
      def: {
        name: "set_body_type",
        description: "Set the body type of an entity's physics body (static, dynamic, kinematic).",
        inputSchema: {
          type: "object",
          properties: {
            entity: { type: "string", description: "Entity key" },
            bodyType: {
              type: "string",
              enum: ["static", "dynamic", "kinematic"],
              description: "Body type",
            },
          },
          required: ["entity", "bodyType"],
        },
      },
      handler: (params) => {
        const entityKey = params.entity as string;
        const handle = ctx.bodyHandles.get(entityKey);
        if (!handle) return errorResult(`Entity ${entityKey} has no physics body`);

        const bodyType = params.bodyType as BodyType;
        const realm = ctx.physicsRealms.values().next().value;
        if (!realm) return errorResult("No physics realm available");

        realm.getBackend().setBodyType(handle, bodyType);

        return jsonResult({ entity: entityKey, bodyType });
      },
    },

    {
      def: {
        name: "apply_force",
        description: "Apply a force or impulse to an entity's physics body.",
        inputSchema: {
          type: "object",
          properties: {
            entity: { type: "string", description: "Entity key" },
            force: {
              type: "array",
              items: { type: "number" },
              description: "Force vector [x, y, z]",
            },
            type: {
              type: "string",
              enum: ["force", "impulse", "torque", "torqueImpulse"],
              description: "Force type (default: force)",
            },
          },
          required: ["entity", "force"],
        },
      },
      handler: (params) => {
        const entityKey = params.entity as string;
        const handle = ctx.bodyHandles.get(entityKey);
        if (!handle) return errorResult(`Entity ${entityKey} has no physics body`);

        const force = params.force as [number, number, number];
        const type = (params.type as string) ?? "force";
        const realm = ctx.physicsRealms.values().next().value as PhysicsRealm | undefined;
        if (!realm) return errorResult("No physics realm available");

        const backend = realm.getBackend();
        switch (type) {
          case "force": backend.applyForce(handle, force); break;
          case "impulse": backend.applyImpulse(handle, force); break;
          case "torque": backend.applyTorque(handle, force); break;
          case "torqueImpulse": backend.applyTorqueImpulse(handle, force); break;
          default: return errorResult(`Unknown force type: ${type}`);
        }

        return jsonResult({ entity: entityKey, type, force });
      },
    },

    {
      def: {
        name: "raycast",
        description: "Cast a ray and return the first hit.",
        inputSchema: {
          type: "object",
          properties: {
            origin: { type: "array", items: { type: "number" }, description: "Ray origin [x, y, z]" },
            direction: { type: "array", items: { type: "number" }, description: "Ray direction [x, y, z]" },
            maxDistance: { type: "number", description: "Max distance (default: 100)" },
            realm: { type: "string", description: "Physics realm name" },
          },
          required: ["origin", "direction"],
        },
      },
      handler: (params) => {
        const origin = params.origin as [number, number, number];
        const direction = params.direction as [number, number, number];
        const maxDistance = (params.maxDistance as number) ?? 100;

        const realmName = (params.realm as string) ?? ctx.physicsRealms.keys().next().value;
        const realm = ctx.physicsRealms.get(realmName);
        if (!realm) return errorResult(`Physics realm "${realmName}" not found`);

        const result = realm.raycast(origin, direction, maxDistance);
        if (!result) {
          return jsonResult({ hit: false });
        }

        return jsonResult({
          hit: true,
          entity: ctx.getEntityKey(result.entity),
          point: [...result.point],
          normal: [...result.normal],
          distance: result.distance,
        });
      },
    },

    {
      def: {
        name: "list_physics_realms",
        description: "List all physics realms.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      handler: () => {
        const realms = [...ctx.physicsRealms.entries()].map(([name, realm]) => ({
          name,
          id: realm.id,
        }));
        return jsonResult({ count: realms.length, realms });
      },
    },

  ];

  return tools;
}
