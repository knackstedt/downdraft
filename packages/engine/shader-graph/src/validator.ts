import type { MaterialGraph, GraphNode } from "./graph";

export class GraphValidator {
  validate(graph: MaterialGraph): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const nodes = graph.getNodes();
    const connections = graph.getConnections();

    const nodeIds = new Set(nodes.map((n) => n.id));
    for (let i = 0; i < connections.length; i++) {
      const conn = connections[i];
      if (!nodeIds.has(conn.from)) {
        errors.push(`Connection from unknown node: ${conn.from}`);
      }
      if (!nodeIds.has(conn.to)) {
        errors.push(`Connection to unknown node: ${conn.to}`);
      }
    }

    const visited = new Set<string>();
    const visiting = new Set<string>();

    const checkCycle = (id: string): boolean => {
      if (visited.has(id)) return false;
      if (visiting.has(id)) return true;
      visiting.add(id);

      for (let i = 0; i < connections.length; i++) {
        if (connections[i].to === id) {
          if (checkCycle(connections[i].from)) return true;
        }
      }

      visiting.delete(id);
      visited.add(id);
      return false;
    };

    for (let i = 0; i < nodes.length; i++) {
      if (checkCycle(nodes[i].id)) {
        errors.push(`Cycle detected at node: ${nodes[i].id}`);
        break;
      }
    }

    return { valid: errors.length === 0, errors };
  }
}
