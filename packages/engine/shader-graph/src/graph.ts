export interface GraphNode {
  id: string;
  type: string;
  inputs: Record<string, string>;
  outputs: Record<string, string>;
  properties: Record<string, unknown>;
}

export class MaterialGraph {
  private nodes: Map<string, GraphNode> = new Map();
  private connections: Array<{ from: string; fromPort: string; to: string; toPort: string }> = [];

  addNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
  }

  connect(from: string, fromPort: string, to: string, toPort: string): void {
    this.connections.push({ from, fromPort, to, toPort });
  }

  getNodes(): GraphNode[] {
    return [...this.nodes.values()];
  }

  getConnections(): Array<{ from: string; fromPort: string; to: string; toPort: string }> {
    return [...this.connections];
  }

  input(name: string, type: string): string {
    const id = `input_${name}`;
    this.addNode({
      id,
      type: "input",
      inputs: {},
      outputs: { value: type },
      properties: { name, type },
    });
    return id;
  }

  output(name: string, fromNode: string, fromPort: string = "value"): void {
    const id = `output_${name}`;
    this.addNode({
      id,
      type: "output",
      inputs: { value: "" },
      outputs: {},
      properties: { name },
    });
    this.connect(fromNode, fromPort, id, "value");
  }
}
