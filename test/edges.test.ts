import { describe, it, expect } from "vitest";
import { collectNodes, buildEdges, isSecondary, validateConfig } from "../src/graph";
import type { MapCfg } from "../src/graph";
import { mk, resolverFor } from "./fixtures";

// A resolver that always misses, to force the basename/title fallbacks.
const nullResolver = () => null;

describe("buildEdges — resolution order", () => {
  it("resolves a via value through the injected resolveLink first", () => {
    // The link text in the child does NOT match the parent basename or title;
    // only the injected resolver knows where it points.
    const parent = mk("p/Parent.md", { title: "Some Other Title" });
    const child = mk("c/Child.md", { up: "[[anything-the-resolver-knows]]" });
    const cfg: MapCfg = {
      levels: [
        { id: "P", from: "p" },
        { id: "C", from: "c" },
      ],
      edges: [{ from: "P", to: "C", via: "up" }],
    };
    const { nodes, byLevel } = collectNodes(cfg, [parent, child]);
    // resolver maps the link key straight to the parent path
    const resolver = (key: string) =>
      key === "anything-the-resolver-knows" ? "p/Parent.md" : null;
    buildEdges(cfg, nodes, byLevel, resolver);
    expect(nodes["c/Child.md"].primaryParent).toBe("p/Parent.md");
  });

  it("falls back to basename when resolveLink returns null", () => {
    const parent = mk("p/Parent.md", { title: "Unrelated Title" });
    const child = mk("c/Child.md", { up: "[[Parent]]" }); // matches basename, not title
    const cfg: MapCfg = {
      levels: [
        { id: "P", from: "p" },
        { id: "C", from: "c" },
      ],
      edges: [{ from: "P", to: "C", via: "up" }],
    };
    const { nodes, byLevel } = collectNodes(cfg, [parent, child]);
    buildEdges(cfg, nodes, byLevel, nullResolver);
    expect(nodes["c/Child.md"].primaryParent).toBe("p/Parent.md");
  });

  it("falls back to the target note's `title` frontmatter when basename also misses", () => {
    // basename is "Parent" but the link points at the note by its title.
    const parent = mk("p/Parent.md", { title: "Friendly Title" });
    const child = mk("c/Child.md", { up: "[[Friendly Title]]" });
    const cfg: MapCfg = {
      levels: [
        { id: "P", from: "p" },
        { id: "C", from: "c" },
      ],
      edges: [{ from: "P", to: "C", via: "up" }],
    };
    const { nodes, byLevel } = collectNodes(cfg, [parent, child]);
    buildEdges(cfg, nodes, byLevel, nullResolver);
    expect(nodes["c/Child.md"].primaryParent).toBe("p/Parent.md");
  });
});

describe("buildEdges — list-valued via", () => {
  it("produces one edge per list item (a child with two parents)", () => {
    const goalA = mk("g/Goal A.md", { title: "Goal A" });
    const goalB = mk("g/Goal B.md", { title: "Goal B" });
    const proj = mk("p/Proj.md", { goals: ["[[Goal A]]", "[[Goal B]]"] });
    const cfg: MapCfg = {
      levels: [
        { id: "goals", from: "g" },
        { id: "projects", from: "p" },
      ],
      edges: [{ from: "goals", to: "projects", via: "goals" }],
    };
    const notes = [goalA, goalB, proj];
    const { nodes, byLevel } = collectNodes(cfg, notes);
    buildEdges(cfg, nodes, byLevel, resolverFor(notes));
    expect(nodes["p/Proj.md"].parents).toEqual(
      new Set(["g/Goal A.md", "g/Goal B.md"]),
    );
    // first list item becomes the primary parent
    expect(nodes["p/Proj.md"].primaryParent).toBe("g/Goal A.md");
  });
});

describe("buildEdges — reverse", () => {
  it("reads the via field from the FROM note (pointing down) when reverse is true", () => {
    // The child note carries NO upward link; the edge exists only because the
    // parent points down via `children` and reverse:true reads it from the parent.
    const parent = mk("p/Parent.md", { title: "Parent", children: "[[Child]]" });
    const child = mk("c/Child.md", { title: "Child" });
    const cfg: MapCfg = {
      levels: [
        { id: "P", from: "p" },
        { id: "C", from: "c" },
      ],
      edges: [{ from: "P", to: "C", via: "children", reverse: true }],
    };
    const notes = [parent, child];
    const { nodes, byLevel } = collectNodes(cfg, notes);
    buildEdges(cfg, nodes, byLevel, resolverFor(notes));
    expect(nodes["c/Child.md"].primaryParent).toBe("p/Parent.md");
    expect(nodes["p/Parent.md"].children).toEqual(new Set(["c/Child.md"]));
  });

  it("does not link when reverse is false but the down-field is the only source", () => {
    // Same data, but without reverse the via field is looked for on the child
    // and there is none — proving the reverse path is load-bearing above.
    const parent = mk("p/Parent.md", { title: "Parent", children: "[[Child]]" });
    const child = mk("c/Child.md", { title: "Child" });
    const cfg: MapCfg = {
      levels: [
        { id: "P", from: "p" },
        { id: "C", from: "c" },
      ],
      edges: [{ from: "P", to: "C", via: "children" }],
    };
    const notes = [parent, child];
    const { nodes, byLevel } = collectNodes(cfg, notes);
    buildEdges(cfg, nodes, byLevel, resolverFor(notes));
    expect(nodes["c/Child.md"].primaryParent).toBeNull();
    expect(nodes["c/Child.md"].parents.size).toBe(0);
  });
});

describe("buildEdges — dotted via reaches nested frontmatter", () => {
  it("links via a dotted path like customFields.serves", () => {
    const goal = mk("g/Goal.md", { title: "Goal" });
    const proj = mk("p/Proj.md", { customFields: { serves: "[[Goal]]" } });
    const cfg: MapCfg = {
      levels: [
        { id: "goals", from: "g" },
        { id: "projects", from: "p" },
      ],
      edges: [{ from: "goals", to: "projects", via: "customFields.serves" }],
    };
    const notes = [goal, proj];
    const { nodes, byLevel } = collectNodes(cfg, notes);
    buildEdges(cfg, nodes, byLevel, resolverFor(notes));
    expect(nodes["p/Proj.md"].primaryParent).toBe("g/Goal.md");
  });
});

describe("buildEdges — secondary edges", () => {
  it("records a secondary:true edge as secondary", () => {
    const parent = mk("p/Parent.md", { title: "Parent" });
    const child = mk("c/Child.md", { ref: "[[Parent]]" });
    const cfg: MapCfg = {
      levels: [
        { id: "P", from: "p" },
        { id: "C", from: "c" },
      ],
      edges: [{ from: "P", to: "C", via: "ref", secondary: true }],
    };
    const notes = [parent, child];
    const { nodes, byLevel } = collectNodes(cfg, notes);
    const edgeKind = buildEdges(cfg, nodes, byLevel, resolverFor(notes));
    expect(isSecondary(edgeKind, "p/Parent.md", "c/Child.md")).toBe(true);
    expect(edgeKind.get("p/Parent.md|c/Child.md")).toBe("secondary");
  });

  it("a primary edge wins when both primary and secondary exist for the same pair", () => {
    // Two edge defs over the same level pair: one secondary, one primary.
    const parent = mk("p/Parent.md", { title: "Parent" });
    const child = mk("c/Child.md", { soft: "[[Parent]]", solid: "[[Parent]]" });
    const cfg: MapCfg = {
      levels: [
        { id: "P", from: "p" },
        { id: "C", from: "c" },
      ],
      edges: [
        { from: "P", to: "C", via: "soft", secondary: true },
        { from: "P", to: "C", via: "solid" },
      ],
    };
    const notes = [parent, child];
    const { nodes, byLevel } = collectNodes(cfg, notes);
    const edgeKind = buildEdges(cfg, nodes, byLevel, resolverFor(notes));
    expect(edgeKind.get("p/Parent.md|c/Child.md")).toBe("primary");
    expect(isSecondary(edgeKind, "p/Parent.md", "c/Child.md")).toBe(false);
  });
});

describe("buildEdges — primaryParent semantics", () => {
  it("primaryParent is the FIRST non-secondary parent", () => {
    // First edge def is secondary (Goal A), second is primary (Goal B).
    // primaryParent must skip the secondary one and be Goal B.
    const goalA = mk("g/Goal A.md", { title: "Goal A" });
    const goalB = mk("g/Goal B.md", { title: "Goal B" });
    const proj = mk("p/Proj.md", { soft: "[[Goal A]]", solid: "[[Goal B]]" });
    const cfg: MapCfg = {
      levels: [
        { id: "goals", from: "g" },
        { id: "projects", from: "p" },
      ],
      edges: [
        { from: "goals", to: "projects", via: "soft", secondary: true },
        { from: "goals", to: "projects", via: "solid" },
      ],
    };
    const notes = [goalA, goalB, proj];
    const { nodes, byLevel } = collectNodes(cfg, notes);
    buildEdges(cfg, nodes, byLevel, resolverFor(notes));
    expect(nodes["p/Proj.md"].primaryParent).toBe("g/Goal B.md");
    // both are still parents
    expect(nodes["p/Proj.md"].parents).toEqual(
      new Set(["g/Goal A.md", "g/Goal B.md"]),
    );
  });

  it("a node whose only parent link is secondary has primaryParent null but keeps the parent", () => {
    const parent = mk("p/Parent.md", { title: "Parent" });
    const child = mk("c/Child.md", { ref: "[[Parent]]" });
    const cfg: MapCfg = {
      levels: [
        { id: "P", from: "p" },
        { id: "C", from: "c" },
      ],
      edges: [{ from: "P", to: "C", via: "ref", secondary: true }],
    };
    const notes = [parent, child];
    const { nodes, byLevel } = collectNodes(cfg, notes);
    buildEdges(cfg, nodes, byLevel, resolverFor(notes));
    expect(nodes["c/Child.md"].primaryParent).toBeNull();
    expect(nodes["c/Child.md"].parents).toEqual(new Set(["p/Parent.md"]));
  });
});

describe("buildEdges — parents/children populated symmetrically", () => {
  it("the parent's children set mirrors the child's parents set", () => {
    const parent = mk("p/Parent.md", { title: "Parent" });
    const child = mk("c/Child.md", { up: "[[Parent]]" });
    const cfg: MapCfg = {
      levels: [
        { id: "P", from: "p" },
        { id: "C", from: "c" },
      ],
      edges: [{ from: "P", to: "C", via: "up" }],
    };
    const notes = [parent, child];
    const { nodes, byLevel } = collectNodes(cfg, notes);
    buildEdges(cfg, nodes, byLevel, resolverFor(notes));
    expect(nodes["p/Parent.md"].children.has("c/Child.md")).toBe(true);
    expect(nodes["c/Child.md"].parents.has("p/Parent.md")).toBe(true);
  });
});

describe("validateConfig", () => {
  it("throws on null cfg", () => {
    expect(() => validateConfig(null)).toThrow(/non-empty `levels:` list/);
  });

  it("throws on a cfg missing levels", () => {
    expect(() => validateConfig({} as MapCfg)).toThrow(
      /non-empty `levels:` list/,
    );
  });

  it("throws on an empty levels array", () => {
    expect(() => validateConfig({ levels: [] })).toThrow(
      /non-empty `levels:` list/,
    );
  });

  it("does not throw on a valid cfg", () => {
    expect(() =>
      validateConfig({ levels: [{ id: "a", from: "a" }] }),
    ).not.toThrow();
  });
});
