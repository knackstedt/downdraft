// Oxlint JS plugin — DownDraft house rules.
// Referenced from .oxlintrc.json files as:
//   "jsPlugins": [{ "name": "downdraft", "specifier": "@downdraft/engine/lint-plugin" }]

/** @type {import("oxlint/plugins-dev").Rule} */
const noForOf = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow `for..of` loops except where they are the required iteration structure",
    },
    messages: {
      forbidden:
        "for..of is not allowed — use .forEach() or an indexed for loop. " +
        "for..of is only permitted where it is required: iterating a call result " +
        "(Object.entries(), map.entries(), generators, ...) or `for await..of`.",
    },
    schema: [],
  },
  create(context) {
    return {
      ForOfStatement(node) {
        // `for await..of` is the only way to consume async iterables.
        if (node.await) return;
        // Iterating a call result — Object.entries()/keys()/values(),
        // map.entries(), generator()/iterable factories — has no
        // forEach/indexed alternative, so for..of is required there.
        if (node.right.type === "CallExpression") return;
        context.report({ node, messageId: "forbidden" });
      },
    };
  },
};

export default {
  meta: { name: "downdraft" },
  rules: {
    "no-for-of": noForOf,
  },
};
