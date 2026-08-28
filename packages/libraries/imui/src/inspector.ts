import type { World } from "@downdraft/core";
import type { Entity } from "@downdraft/core";
import type { ComponentId } from "@downdraft/core";
import { getComponentName } from "@downdraft/core";

export interface InspectorField {
  name: string;
  type: "number" | "string" | "boolean" | "vec3" | "vec4" | "color" | "enum" | "asset";
  value: unknown;
  readOnly: boolean;
  min?: number;
  max?: number;
  step?: number;
  enumValues?: string[];
}

export interface InspectorComponent {
  componentId: ComponentId;
  name: string;
  fields: InspectorField[];
  expanded: boolean;
}

export interface InspectorState {
  entity: Entity | null;
  entityName: string;
  components: InspectorComponent[];
  hasEntity: boolean;
}

const FIELD_TYPE_MAP: Record<string, InspectorField["type"]> = {
  number: "number",
  string: "string",
  boolean: "boolean",
};

export class InspectorPanel {
  private world: World;
  private entity: Entity | null = null;
  private expandedComponents: Set<ComponentId> = new Set();
  private nameOverrides: Map<number, string> = new Map();
  private onPropertyChanged: ((componentId: ComponentId, field: string, value: unknown) => void) | null = null;

  constructor(world: World) {
    this.world = world;
  }

  setOnPropertyChanged(fn: (componentId: ComponentId, field: string, value: unknown) => void): void {
    this.onPropertyChanged = fn;
  }

  setEntityName(entity: Entity, name: string): void {
    this.nameOverrides.set(entity.index, name);
  }

  inspect(entity: Entity | null): void {
    this.entity = entity;
  }

  getEntity(): Entity | null {
    return this.entity;
  }

  toggleComponentExpanded(componentId: ComponentId): void {
    if (this.expandedComponents.has(componentId)) {
      this.expandedComponents.delete(componentId);
    } else {
      this.expandedComponents.add(componentId);
    }
  }

  expandComponent(componentId: ComponentId): void {
    this.expandedComponents.add(componentId);
  }

  collapseComponent(componentId: ComponentId): void {
    this.expandedComponents.delete(componentId);
  }

  expandAll(): void {
    if (!this.entity) return;
    const arch = this.world.getArchetypeForEntity(this.entity);
    if (!arch) return;
    for (const cid of arch.componentIds) {
      this.expandedComponents.add(cid);
    }
  }

  collapseAll(): void {
    this.expandedComponents.clear();
  }

  setFieldValue(componentId: ComponentId, field: string, value: unknown): void {
    if (!this.entity) return;
    const data = this.world.getComponent<Record<string, unknown>>(this.entity, componentId);
    if (!data) return;
    data[field] = value;
    if (this.onPropertyChanged) {
      this.onPropertyChanged(componentId, field, value);
    }
  }

  getFieldValue(componentId: ComponentId, field: string): unknown {
    if (!this.entity) return undefined;
    const data = this.world.getComponent<Record<string, unknown>>(this.entity, componentId);
    return data?.[field];
  }

  private inferFieldType(value: unknown): InspectorField["type"] {
    if (typeof value === "number") return "number";
    if (typeof value === "string") return "string";
    if (typeof value === "boolean") return "boolean";
    if (Array.isArray(value)) {
      if (value.length === 3) return "vec3";
      if (value.length === 4) return "vec4";
    }
    return "string";
  }

  private buildFields(data: Record<string, unknown>): InspectorField[] {
    const fields: InspectorField[] = [];
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith("_")) continue;
      const type = this.inferFieldType(value);
      fields.push({
        name: key,
        type,
        value,
        readOnly: false,
      });
    }
    return fields;
  }

  getState(): InspectorState {
    if (!this.entity) {
      return {
        entity: null,
        entityName: "",
        components: [],
        hasEntity: false,
      };
    }

    const meta = this.world.entities[this.entity.index];
    if (!meta || meta.generation !== this.entity.generation || !meta.alive) {
      return {
        entity: null,
        entityName: "",
        components: [],
        hasEntity: false,
      };
    }

    const arch = this.world.getArchetypeForEntity(this.entity);
    if (!arch) {
      return {
        entity: this.entity,
        entityName: this.nameOverrides.get(this.entity.index) ?? `Entity_${this.entity.index}`,
        components: [],
        hasEntity: true,
      };
    }

    const components: InspectorComponent[] = [];
    for (const cid of arch.componentIds) {
      const row = arch.entities.findIndex(
        (e) => e.index === this.entity!.index && e.generation === this.entity!.generation,
      );
      if (row < 0) continue;

      const data = arch.columns.get(cid)![row] as Record<string, unknown>;
      const name = getComponentName(cid) ?? `Component_${cid}`;
      components.push({
        componentId: cid,
        name,
        fields: this.buildFields(data),
        expanded: this.expandedComponents.has(cid),
      });
    }

    return {
      entity: this.entity,
      entityName: this.nameOverrides.get(this.entity.index) ?? `Entity_${this.entity.index}`,
      components,
      hasEntity: true,
    };
  }

  addComponent(componentId: ComponentId, data: unknown): void {
    if (!this.entity) return;
    this.world.addComponent(this.entity, componentId, data);
  }

  removeComponent(componentId: ComponentId): void {
    if (!this.entity) return;
    this.world.removeComponent(this.entity, componentId);
  }

  hasComponent(componentId: ComponentId): boolean {
    if (!this.entity) return false;
    return this.world.hasComponent(this.entity, componentId);
  }
}
