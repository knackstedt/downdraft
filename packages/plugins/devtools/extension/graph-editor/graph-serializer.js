// ============================================================================
// GraphSerializer — Serialize/deserialize graph editor state to/from JSON
// Also provides helpers for converting between UI graph format and
// the engine's UINodeData/UIConnection format (graph-bridge.ts).
// ============================================================================

(function (global) {
  "use strict";

  var GraphSerializer = {
    // ─── Basic serialize/deserialize ──────────────────────────────────

    serialize: function (graphEditor) {
      return graphEditor.serializeGraph();
    },

    deserialize: function (graphEditor, json) {
      graphEditor.loadGraph(json);
    },

    toJSON: function (graphEditor) {
      return JSON.stringify(graphEditor.serializeGraph(), null, 2);
    },

    fromJSON: function (graphEditor, jsonStr) {
      try {
        var data = JSON.parse(jsonStr);
        graphEditor.loadGraph(data);
        return true;
      } catch (e) {
        console.error("[GraphSerializer] Failed to parse JSON:", e);
        return false;
      }
    },

    // ─── Convert to engine format (UINodeData/UIConnection) ────────────
    // This format matches graph-bridge.ts's UINodeData and UIConnection

    toEngineFormat: function (graphEditor) {
      var nodes = graphEditor.getNodes();
      var connections = graphEditor.getConnections();

      var uiNodes = nodes.map(function (n) {
        return {
          id: n.id,
          type: n.type,
          inputs: (n.inputs || []).map(function (p) {
            return { id: n.id + "_in_" + p.name, name: p.name, type: p.type };
          }),
          outputs: (n.outputs || []).map(function (p) {
            return { id: n.id + "_out_" + p.name, name: p.name, type: p.type };
          }),
          properties: n.properties || {},
        };
      });

      var uiConnections = connections.map(function (c) {
        return {
          id: c.id,
          fromNode: c.fromNode,
          fromPort: c.fromPort,
          toNode: c.toNode,
          toPort: c.toPort,
        };
      });

      return {
        nodes: uiNodes,
        connections: uiConnections,
      };
    },

    // ─── Export to compact URL-safe format ────────────────────────────

    toCompact: function (graphEditor) {
      var data = graphEditor.serializeGraph();
      // Strip metadata for compactness
      delete data.metadata;
      return btoa(JSON.stringify(data));
    },

    fromCompact: function (graphEditor, encoded) {
      try {
        var data = JSON.parse(atob(encoded));
        graphEditor.loadGraph(data);
        return true;
      } catch (e) {
        console.error("[GraphSerializer] Failed to decode compact graph:", e);
        return false;
      }
    },

    // ─── Validate graph ───────────────────────────────────────────────

    validate: function (graphEditor) {
      var errors = [];
      var warnings = [];
      var nodes = graphEditor.getNodes();
      var connections = graphEditor.getConnections();
      var nodeIds = new Set(nodes.map(function (n) { return n.id; }));

      // Check for cycles
      var adj = {};
      nodes.forEach(function (n) { adj[n.id] = []; });
      connections.forEach(function (c) {
        if (adj[c.fromNode]) adj[c.fromNode].push(c.toNode);
      });

      function hasCycle(nodeId, visited, stack) {
        visited.add(nodeId);
        stack.add(nodeId);
        var neighbors = adj[nodeId] || [];
        for (var i = 0; i < neighbors.length; i++) {
          if (!visited.has(neighbors[i])) {
            if (hasCycle(neighbors[i], visited, stack)) return true;
          } else if (stack.has(neighbors[i])) {
            return true;
          }
        }
        stack.delete(nodeId);
        return false;
      }

      var visited = new Set();
      for (var i = 0; i < nodes.length; i++) {
        if (!visited.has(nodes[i].id)) {
          if (hasCycle(nodes[i].id, visited, new Set())) {
            errors.push("Graph contains a cycle");
            break;
          }
        }
      }

      // Check for disconnected inputs (non-optional)
      nodes.forEach(function (n) {
        if (!n.inputs) return;
        n.inputs.forEach(function (inp) {
          if (inp.optional) return;
          var hasConnection = connections.some(function (c) {
            return c.toNode === n.id && c.toPort === inp.name;
          });
          if (!hasConnection) {
            warnings.push("Node '" + (n.label || n.type) + "' has unconnected input: " + inp.name);
          }
        });
      });

      // Check for orphan nodes (no connections at all)
      nodes.forEach(function (n) {
        var hasConn = connections.some(function (c) {
          return c.fromNode === n.id || c.toNode === n.id;
        });
        if (!hasConn && nodes.length > 1) {
          warnings.push("Node '" + (n.label || n.type) + "' is not connected to anything");
        }
      });

      return { errors: errors, warnings: warnings, valid: errors.length === 0 };
    },
  };

  global.GraphSerializer = GraphSerializer;
})(typeof window !== "undefined" ? window : this);
