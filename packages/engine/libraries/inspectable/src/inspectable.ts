// ============================================================================
// inspectable.ts — InspectableRegistry: a schema'd, hierarchical registry of
// named game-state nodes that automation (MCP tools, devtools) can read and
// write WITHOUT synthesizing user input.
//
// Why callbacks instead of field reflection: most interesting state isn't
// live-bound — e.g. `CharacterCustomization.girth` only takes effect after
// the game re-runs resolveCustomizationMeshes() and re-uploads meshes. A raw
// `obj[key] = value` would silently desync the store, the rendered mesh, and
// the sim. Each node therefore carries a `set()` that routes through the same
// apply function the game's own UI calls.
//
// Hierarchy is derived from dot-separated `path`s ("player.customization.
// girth") — no class hierarchy or decorator machinery required.
//
// Thread model: `set()` runs in whatever thread hosts the registry. For
// sim-authoritative state, implement `set` as a dispatch over the game's
// RendererToSimMessage channel and let `get` read the last received snapshot;
// mark the node `thread: "sim"` so callers know the write isn't synchronous.
//
// When to use what:
//   - inspectable_* tools (this registry) — semantic game state with schema
//   - add_component (editor MCP)      — ECS component data
//   - extraTools / set_test_state     — bespoke escape hatches
//   - inject_input / dispatch_*       — exercising the real input pipeline
// ============================================================================

export type InspectableType = "number" | "boolean" | "string" | "enum" | "json";

/** Which thread owns the value. Informational — writes always execute in the
 *  thread hosting the registry. */
export type InspectableThread = "renderer" | "sim" | "main";

/**
 * One addressable piece of game state.
 *
 * Path convention: dot-separated identifiers ("player.customization.girth").
 * Segments must not contain `.` — arbitrary map keys (material names with
 * spaces/dots) belong in a `json` node that writes the whole map.
 */
export interface InspectableNode {
    path: string;
    label?: string;
    description?: string;
    type: InspectableType;
    /** number only — inclusive bounds enforced on set. */
    min?: number;
    max?: number;
    /** enum only — lazy so dynamic option lists (variant catalogs) stay fresh. */
    enum?: () => readonly string[];
    /** Default false. Nodes without `set` are treated as read-only regardless. */
    readOnly?: boolean;
    thread?: InspectableThread;
    get(): unknown;
    /** Routes through the game's apply pipeline (store update → re-resolve →
     *  sim dispatch). May be async when the apply involves uploads. */
    set?(value: unknown): void | Promise<void>;
}

/** Serializable descriptor returned by list()/tree() — no live `get` call. */
export interface InspectableNodeInfo {
    path: string;
    label?: string;
    description?: string;
    type: InspectableType;
    min?: number;
    max?: number;
    options?: readonly string[];
    readOnly: boolean;
    thread?: InspectableThread;
    children?: InspectableNodeInfo[];
}

export interface InspectableSetResult {
    path: string;
    value: unknown;
}

export class InspectableError extends Error {
    constructor(
        message: string,
        /** Machine-readable hint for callers that want to distinguish failures. */
        readonly reason: "not_found" | "read_only" | "bad_type" | "out_of_range" | "bad_enum",
    ) {
        super(message);
        this.name = "InspectableError";
    }
}

export class InspectableRegistry {
    private nodes = new Map<string, InspectableNode>();
    private listeners = new Set<(path: string, value: unknown) => void>();

    /** Register a node. Returns an unregister function. Throws on duplicate paths. */
    register(node: InspectableNode): () => void {
        if (!node.path) throw new InspectableError("Node requires a path", "bad_type");
        if (this.nodes.has(node.path)) {
            throw new InspectableError(`Node "${node.path}" is already registered`, "bad_type");
        }
        this.nodes.set(node.path, node);
        return () => { this.nodes.delete(node.path); };
    }

    registerAll(nodes: InspectableNode[]): () => void {
        const unsubs = nodes.map((n) => this.register(n));
        return () => { unsubs.forEach((u) => u()); };
    }

    unregister(path: string): boolean {
        return this.nodes.delete(path);
    }

    has(path: string): boolean {
        return this.nodes.has(path);
    }

    size(): number {
        return this.nodes.size;
    }

    /** Node descriptors (schema only — no live reads), optionally filtered to
     *  a path prefix ("player" matches "player.health" but not "players.x"). */
    list(prefix?: string): InspectableNodeInfo[] {
        const out: InspectableNodeInfo[] = [];
        for (const node of this.nodes.values()) {
            if (prefix && node.path !== prefix && !node.path.startsWith(prefix + ".")) continue;
            out.push(this.describeNode(node));
        }
        return out.sort((a, b) => a.path.localeCompare(b.path));
    }

    /** Nested tree of node descriptors — intermediate path segments become
     *  grouping objects with `children` and a synthesized `type: "json"`. */
    tree(prefix?: string): InspectableNodeInfo[] {
        interface TreeEntry extends InspectableNodeInfo { _kids: Map<string, TreeEntry>; }
        const roots = new Map<string, TreeEntry>();
        for (const info of this.list(prefix)) {
            const segs = info.path.split(".");
            let kids = roots;
            for (let i = 0; i < segs.length; i++) {
                const leaf = i === segs.length - 1;
                let entry = kids.get(segs[i]);
                if (!entry) {
                    entry = {
                        path: segs.slice(0, i + 1).join("."),
                        type: "json",
                        readOnly: true,
                        children: [],
                        _kids: new Map(),
                    } as TreeEntry;
                    kids.set(segs[i], entry);
                }
                if (leaf) Object.assign(entry, info, { children: entry.children, _kids: entry._kids });
                kids = entry._kids;
            }
        }
        const strip = (entries: Map<string, TreeEntry>): InspectableNodeInfo[] =>
            [...entries.values()].map(({ _kids, ...info }) => ({
                ...info,
                children: _kids.size ? strip(_kids) : undefined,
            }));
        return strip(roots);
    }

    /** Schema descriptor for a single node (throws on unknown path). */
    describe(path: string): InspectableNodeInfo {
        return this.describeNode(this.node(path));
    }

    /** Current value of a node. */
    get(path: string): InspectableSetResult {
        const node = this.node(path);
        return { path, value: node.get() };
    }

    /** Validate and apply a write through the node's `set()`, then return a
     *  fresh `get()` echo so callers see what actually landed. */
    async set(path: string, value: unknown): Promise<InspectableSetResult> {
        const node = this.node(path);
        if (node.readOnly || !node.set) {
            throw new InspectableError(`Node "${path}" is read-only`, "read_only");
        }
        this.validate(node, value);
        await node.set(value);
        const result = { path, value: node.get() };
        this.listeners.forEach((l) => {
            try { l(path, result.value); } catch { /* listener errors don't fail the write */ }
        });
        return result;
    }

    /** Subscribe to successful writes (path + resulting value). */
    onChanged(listener: (path: string, value: unknown) => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    private node(path: string): InspectableNode {
        const node = this.nodes.get(path);
        if (node) return node;
        // Suggest likely targets: children of the queried path, ancestors, and
        // siblings sharing the parent prefix ("player.heal" → "player.health").
        const parent = path.slice(0, path.lastIndexOf("."));
        const near = [...this.nodes.keys()].filter((k) =>
            k.startsWith(path + ".") || path.startsWith(k + ".") ||
            (parent && k.startsWith(parent + ".")));
        throw new InspectableError(
            `Unknown inspectable path "${path}"` + (near.length ? `. Did you mean: ${near.slice(0, 8).join(", ")}?` : ""),
            "not_found",
        );
    }

    private validate(node: InspectableNode, value: unknown): void {
        switch (node.type) {
            case "number": {
                if (typeof value !== "number" || !Number.isFinite(value)) {
                    throw new InspectableError(`"${node.path}" expects a finite number, got ${typeof value}`, "bad_type");
                }
                if (node.min !== undefined && value < node.min || node.max !== undefined && value > node.max) {
                    throw new InspectableError(
                        `"${node.path}" must be within [${node.min ?? "-∞"}, ${node.max ?? "+∞"}], got ${value}`,
                        "out_of_range",
                    );
                }
                return;
            }
            case "boolean":
                if (typeof value !== "boolean") {
                    throw new InspectableError(`"${node.path}" expects a boolean, got ${typeof value}`, "bad_type");
                }
                return;
            case "string":
                if (typeof value !== "string") {
                    throw new InspectableError(`"${node.path}" expects a string, got ${typeof value}`, "bad_type");
                }
                return;
            case "enum": {
                const options = node.enum?.() ?? [];
                if (typeof value !== "string" || !options.includes(value)) {
                    throw new InspectableError(
                        `"${node.path}" must be one of [${options.join(", ")}], got ${JSON.stringify(value)}`,
                        "bad_enum",
                    );
                }
                return;
            }
            case "json":
                if (!isJsonSerializable(value)) {
                    throw new InspectableError(`"${node.path}" expects a JSON-serializable value`, "bad_type");
                }
                return;
        }
    }

    private describeNode(node: InspectableNode): InspectableNodeInfo {
        return {
            path: node.path,
            label: node.label,
            description: node.description,
            type: node.type,
            min: node.min,
            max: node.max,
            options: node.type === "enum" ? (node.enum?.() ?? []) : undefined,
            readOnly: node.readOnly ?? !node.set,
            thread: node.thread,
        };
    }
}

function isJsonSerializable(value: unknown): boolean {
    try {
        JSON.stringify(value);
        return value === undefined ? false : true;
    } catch {
        return false;
    }
}
