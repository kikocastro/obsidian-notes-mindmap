import { describe, it, expect } from "vitest";
import {
  collectNodes,
  buildEdges,
  computeVisible,
  filterOptions,
  orderAndLayout,
  searchMatch,
  resolveLayout,
  CARD_W,
  NODE_H,
  COL_GAP,
  V_GAP,
  TOP,
  type MapCfg,
  type MNode,
} from "../src/graph";
import { mk, resolverFor } from "./fixtures";

// Build a tree, wire edges, compute layout with all nodes visible. Returns the
// laid-out structures so each test can assert on the mutated nodes / order.
const layout = (cfg: MapCfg, notes: ReturnType<typeof mk>[]) => {
  const { nodes, byLevel } = collectNodes(cfg, notes);
  buildEdges(cfg, nodes, byLevel, resolverFor(notes));
  const vis = computeVisible(nodes, new Set(), {}, cfg);
  const res = orderAndLayout(cfg, nodes, byLevel, vis);
  return { nodes, byLevel, vis, ...res };
};

// a two-level goals -> projects config used by several cases
const twoLevelCfg: MapCfg = {
  levels: [
    { id: "goals", from: "g", label: "GOALS", card: { title: "title" } },
    { id: "projects", from: "p", label: "PROJECTS", card: { title: "title" } },
  ],
  edges: [{ from: "goals", to: "projects", via: "goal" }],
};

describe("orderAndLayout — DFS ordering", () => {
  it("keeps each parent's subtree contiguous and sorts siblings by collIdx", () => {
    // Two goals, each with children. Children's paths are arranged so the folder
    // sort assigns out-of-order collIdx relative to the desired visual order, and
    // we lean on the `via` links to nest them under the right parent.
    const notes = [
      mk("g/G1.md", { title: "G1", goal: null }),
      mk("g/G2.md", { title: "G2", goal: null }),
      // collIdx is assigned by sorted path order within folder p:
      //   P-a(0) P-b(1) P-c(2) P-d(3)
      mk("p/P-a.md", { title: "Pa", goal: "[[G1]]" }),
      mk("p/P-b.md", { title: "Pb", goal: "[[G2]]" }),
      mk("p/P-c.md", { title: "Pc", goal: "[[G1]]" }),
      mk("p/P-d.md", { title: "Pd", goal: "[[G2]]" }),
    ];
    const { order } = layout(twoLevelCfg, notes);

    // Level 0: roots in folder order
    expect(order[0]).toEqual(["g/G1.md", "g/G2.md"]);
    // Level 1: G1's subtree (P-a, P-c) fully precedes G2's subtree (P-b, P-d),
    // even though folder order interleaves them. Within each subtree, siblings
    // are sorted by collIdx (P-a before P-c; P-b before P-d).
    expect(order[1]).toEqual(["p/P-a.md", "p/P-c.md", "p/P-b.md", "p/P-d.md"]);
  });

  it("orders siblings of one parent by collIdx even when given out of order", () => {
    // Single parent, three children whose folder-sort order (collIdx) is z<x<y by name.
    const notes = [
      mk("g/Root.md", { title: "Root", goal: null }),
      mk("p/c-x.md", { title: "X", goal: "[[Root]]" }), // collIdx 0
      mk("p/c-y.md", { title: "Y", goal: "[[Root]]" }), // collIdx 1
      mk("p/c-z.md", { title: "Z", goal: "[[Root]]" }), // collIdx 2
    ];
    const { order, nodes } = layout(twoLevelCfg, notes);
    expect(order[1]).toEqual(["p/c-x.md", "p/c-y.md", "p/c-z.md"]);
    // confirm collIdx is the ascending sort key actually used
    const idxs = order[1].map((id) => nodes[id].collIdx);
    expect(idxs).toEqual([...idxs].sort((a, b) => a - b));
  });
});

describe("orderAndLayout — orphans", () => {
  it("appends a secondary-only child (no primary parent) to its level's order", () => {
    // Orphan's only link to a goal is a secondary edge, so it has no primaryParent
    // and the root DFS never reaches it. It must still appear in order[1].
    const cfg: MapCfg = {
      levels: [
        { id: "goals", from: "g", card: { title: "title" } },
        { id: "projects", from: "p", card: { title: "title" } },
      ],
      edges: [
        { from: "goals", to: "projects", via: "goal" },
        { from: "goals", to: "projects", via: "seeAlso", secondary: true },
      ],
    };
    const notes = [
      mk("g/G1.md", { title: "G1" }),
      mk("p/Primary.md", { title: "Primary", goal: "[[G1]]" }),
      mk("p/Orphan.md", { title: "Orphan", seeAlso: "[[G1]]" }), // secondary link only
    ];
    const { nodes, order } = layout(cfg, notes);
    expect(nodes["p/Orphan.md"].primaryParent).toBeNull();
    // Primary is reached via DFS; Orphan is appended afterward.
    expect(order[1]).toEqual(["p/Primary.md", "p/Orphan.md"]);
  });

  it("appends an orphan whose only visible link is secondary, even when a primary-linked sibling's parent is filtered out", () => {
    // Filtering a parent hides its WHOLE primary subtree (documented computeVisible
    // behavior), so a primary child of a filtered parent does NOT survive as an
    // orphan. The orphan here is a node whose sole link is secondary: it has no
    // primary parent, stays visible, and is appended to its level's order.
    const cfg: MapCfg = {
      levels: [
        { id: "goals", from: "g", card: { title: "title", meta: ["status"] } },
        { id: "projects", from: "p", card: { title: "title" } },
      ],
      edges: [
        { from: "goals", to: "projects", via: "goal" },
        { from: "goals", to: "projects", via: "seeAlso", secondary: true },
      ],
      filter: ["status"],
    };
    const notes = [
      mk("g/Keep.md", { title: "Keep", status: "active" }),
      mk("g/Drop.md", { title: "Drop", status: "archived" }),
      mk("p/UnderKeep.md", { title: "UnderKeep", goal: "[[Keep]]" }),
      mk("p/UnderDrop.md", { title: "UnderDrop", goal: "[[Drop]]" }), // primary child of filtered parent
      mk("p/Loose.md", { title: "Loose", seeAlso: "[[Keep]]" }), // secondary-only
    ];
    const { nodes, byLevel } = collectNodes(cfg, notes);
    buildEdges(cfg, nodes, byLevel, resolverFor(notes));
    const vis = computeVisible(
      nodes,
      new Set(),
      { status: new Set(["active"]) },
      cfg
    );

    // Drop is filtered out and takes its primary subtree (UnderDrop) with it.
    expect(vis.has("g/Drop.md")).toBe(false);
    expect(vis.has("p/UnderDrop.md")).toBe(false);
    // Loose is secondary-only, so the filter never touches it and it stays visible.
    expect(vis.has("p/Loose.md")).toBe(true);
    expect(nodes["p/Loose.md"].primaryParent).toBeNull();

    const { order } = orderAndLayout(cfg, nodes, byLevel, vis);
    expect(order[0]).toEqual(["g/Keep.md"]);
    // UnderKeep reached via DFS from Keep; Loose appended afterward as an orphan.
    expect(order[1]).toEqual(["p/UnderKeep.md", "p/Loose.md"]);
  });
});

describe("orderAndLayout — vertical placement", () => {
  it("centers a parent on its visible primary children and avoids overlap in a column", () => {
    const notes = [
      mk("g/Root.md", { title: "Root", goal: null }),
      mk("p/c-1.md", { title: "C1", goal: "[[Root]]" }),
      mk("p/c-2.md", { title: "C2", goal: "[[Root]]" }),
      mk("p/c-3.md", { title: "C3", goal: "[[Root]]" }),
    ];
    const { nodes, order } = layout(twoLevelCfg, notes);
    const root = nodes["g/Root.md"];
    const kids = order[1].map((id) => nodes[id]);

    // no vertical overlap within the children column
    for (let i = 1; i < kids.length; i++) {
      expect(kids[i].y!).toBeGreaterThanOrEqual(
        kids[i - 1].y! + kids[i - 1].h!
      );
    }

    // parent y sits at the midpoint of the children's y-range
    const top = Math.min(...kids.map((k) => k.y!));
    const bot = Math.max(...kids.map((k) => k.y! + k.h!));
    const expectedCenter = (top + bot) / 2 - NODE_H / 2;
    expect(root.y!).toBeCloseTo(expectedCenter, 6);
    // parent's own center aligns with the children block's center
    expect(root.y! + root.h! / 2).toBeCloseTo((top + bot) / 2, 6);
  });

  it("places a childless node at the column top with no centering", () => {
    const notes = [mk("g/Solo.md", { title: "Solo", goal: null })];
    const { nodes } = layout(twoLevelCfg, notes);
    expect(nodes["g/Solo.md"].y!).toBe(TOP);
  });
});

describe("orderAndLayout — horizontal placement and bounds", () => {
  it("gives each level a constant x that increases left to right", () => {
    const notes = [
      mk("g/G.md", { title: "G", goal: null }),
      mk("p/P.md", { title: "P", goal: "[[G]]" }),
    ];
    const { nodes, levelX } = layout(twoLevelCfg, notes);
    // every node in a level shares that level's x
    expect(nodes["g/G.md"].x!).toBe(levelX[0]);
    expect(nodes["p/P.md"].x!).toBe(levelX[1]);
    // columns step right by CARD_W + COL_GAP
    expect(levelX[1] - levelX[0]).toBe(CARD_W + COL_GAP);
    expect(levelX[1]).toBeGreaterThan(levelX[0]);
  });

  it("returns positive contentRight/contentBottom that bound the laid-out nodes", () => {
    const notes = [
      mk("g/Root.md", { title: "Root", goal: null }),
      mk("p/c-1.md", { title: "C1", goal: "[[Root]]" }),
      mk("p/c-2.md", { title: "C2", goal: "[[Root]]" }),
    ];
    const { nodes, contentRight, contentBottom, levelX } = layout(
      twoLevelCfg,
      notes
    );
    expect(contentRight).toBeGreaterThan(0);
    expect(contentBottom).toBeGreaterThan(0);
    const all = Object.values(nodes) as MNode[];
    // every node's right edge is within contentRight, bottom within contentBottom
    for (const n of all) {
      expect(n.x! + n.w!).toBeLessThanOrEqual(contentRight);
      expect(n.y! + n.h!).toBeLessThanOrEqual(contentBottom);
    }
    // contentRight is the last column's right edge
    expect(contentRight).toBe(levelX[levelX.length - 1] + CARD_W);
  });
});

describe("resolveLayout", () => {
  it("returns the built-in defaults when no layout is configured", () => {
    expect(resolveLayout(undefined)).toEqual({
      cardW: CARD_W,
      nodeH: NODE_H,
      colGap: COL_GAP,
      vGap: V_GAP,
      top: TOP,
      titleLines: 2,
    });
  });

  it("overrides only the keys given, defaulting the rest", () => {
    expect(resolveLayout({ cardWidth: 200, rowGap: 4 })).toEqual({
      cardW: 200,
      nodeH: NODE_H,
      colGap: COL_GAP,
      vGap: 4,
      top: TOP,
      titleLines: 2,
    });
  });

  it("defaults titleLines to 2 and honours an override", () => {
    expect(resolveLayout(undefined).titleLines).toBe(2);
    expect(resolveLayout({ titleLines: 3 }).titleLines).toBe(3);
  });
});

describe("orderAndLayout — layout config", () => {
  const notes = [
    mk("g/G.md", { title: "G" }),
    mk("p/P.md", { title: "P", goal: "[[G]]" }),
  ];

  it("sizes cards and column step from cfg.layout", () => {
    const cfg: MapCfg = {
      ...twoLevelCfg,
      layout: { cardWidth: 200, cardHeight: 50, columnGap: 100 },
    };
    const { nodes, levelX, contentRight } = layout(cfg, notes);
    expect(nodes["g/G.md"].w!).toBe(200);
    expect(nodes["g/G.md"].h!).toBe(50);
    expect(levelX[1] - levelX[0]).toBe(200 + 100);
    expect(contentRight).toBe(levelX[levelX.length - 1] + 200);
  });

  it("uses cfg.layout.top + rowGap for vertical stacking", () => {
    const cfg: MapCfg = {
      levels: [{ id: "g", from: "g", card: { title: "title" } }],
      layout: { top: 10, cardHeight: 40, rowGap: 5 },
    };
    const solo = [mk("g/A.md", { title: "A" }), mk("g/B.md", { title: "B" })];
    const { nodes } = layout(cfg, solo);
    expect(nodes["g/A.md"].y!).toBe(10); // first card sits at top
    expect(nodes["g/B.md"].y!).toBe(10 + 40 + 5); // next steps by cardHeight + rowGap
  });

  it("adds vertical space for bottom label pills", () => {
    const cfg: MapCfg = {
      levels: [
        {
          id: "g",
          from: "g",
          card: { title: "title", labels: ["kind"] },
        },
      ],
      layout: { cardHeight: 50 },
    };
    const { nodes } = layout(cfg, [
      mk("g/Labeled.md", { title: "Labeled", kind: "driver" }),
    ]);

    expect(nodes["g/Labeled.md"].h!).toBe(74);
  });
});

describe("filterOptions", () => {
  it("orders each property's values by first node layout position, not alphabetically", () => {
    const cfg: MapCfg = {
      levels: [
        { id: "outcomes", from: "o", card: { title: "title" } },
        { id: "drivers", from: "d", card: { title: "title" } },
      ],
      edges: [{ from: "outcomes", to: "drivers", via: "outcome" }],
      filter: ["entity"],
    };
    const notes = [
      mk("o/North Star.md", { title: "North Star", entity: "north star" }),
      mk("d/Activation.md", {
        title: "Activation",
        outcome: "[[North Star]]",
        entity: "driver",
      }),
      mk("d/Adoption.md", {
        title: "Adoption",
        outcome: "[[North Star]]",
        entity: "adoption",
      }),
    ];
    const { nodes, byLevel } = collectNodes(cfg, notes);
    buildEdges(cfg, nodes, byLevel, resolverFor(notes));
    const vis = computeVisible(nodes, new Set(), {}, cfg);
    orderAndLayout(cfg, nodes, byLevel, vis);

    expect(filterOptions(nodes, cfg).entity).toEqual([
      "north star",
      "driver",
      "adoption",
    ]);
  });

  it("uses the earliest laid-out node carrying a repeated value", () => {
    const cfg: MapCfg = {
      levels: [
        { id: "goals", from: "g", card: { title: "title" } },
        { id: "projects", from: "p", card: { title: "title" } },
      ],
      edges: [{ from: "goals", to: "projects", via: "goal" }],
      filter: ["status"],
    };
    const notes = [
      mk("g/G1.md", { title: "G1", status: "zeta" }),
      mk("g/G2.md", { title: "G2", status: "beta" }),
      mk("p/Child.md", { title: "Child", goal: "[[G2]]", status: "alpha" }),
      mk("p/Repeat.md", { title: "Repeat", goal: "[[G1]]", status: "beta" }),
    ];
    const { nodes, byLevel } = collectNodes(cfg, notes);
    buildEdges(cfg, nodes, byLevel, resolverFor(notes));
    const vis = computeVisible(nodes, new Set(), {}, cfg);
    orderAndLayout(cfg, nodes, byLevel, vis);

    expect(filterOptions(nodes, cfg).status).toEqual(["zeta", "beta", "alpha"]);
  });
});

describe("searchMatch", () => {
  const node = (over: Partial<MNode>): MNode =>
    ({
      id: "x",
      levelIdx: 0,
      path: "x",
      basename: "x",
      fm: {},
      title: "",
      sub: "",
      meta: "",
      color: "",
      levelLabel: "",
      progress: null,
      bars: [],
      collIdx: 0,
      parents: new Set(),
      children: new Set(),
      primaryParent: null,
      ...over,
    }) as MNode;

  it("matches case-insensitively against the title", () => {
    const n = node({ title: "Roadmap Alpha" });
    expect(searchMatch(n, "alpha")).toBe(true);
    expect(searchMatch(n, "roadmap")).toBe(true);
  });

  it("matches a term found in sub or meta, not just title", () => {
    const n = node({
      title: "Goal",
      sub: "north star kpi",
      meta: "status: wip · owner: kiko",
    });
    expect(searchMatch(n, "kpi")).toBe(true); // in sub
    expect(searchMatch(n, "owner")).toBe(true); // in meta
    expect(searchMatch(n, "missing")).toBe(false);
  });

  it("matches when the term spans the title/sub boundary is not required; each field is searched in the joined string", () => {
    const n = node({ title: "Foo", sub: "Bar" });
    // joined lowercased string is "foo bar " — a substring within one field matches
    expect(searchMatch(n, "bar")).toBe(true);
    expect(searchMatch(n, "foo")).toBe(true);
  });

  it('matches every node on the empty term (includes("") is always true)', () => {
    expect(searchMatch(node({ title: "anything" }), "")).toBe(true);
    expect(searchMatch(node({ title: "", sub: "", meta: "" }), "")).toBe(true);
  });
});
