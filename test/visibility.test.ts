import { describe, it, expect } from "vitest";
import { collectNodes, buildEdges, computeVisible, passesFilters } from "../src/graph";
import type { MapCfg } from "../src/graph";
import { mk, resolverFor } from "./fixtures";

// Build a goals -> projects -> tasks chain and return its node map.
// edges: project.goal -> goal, task.project -> project (matches the simpleCfg shape).
const buildChain = (notes = chainNotes, cfg = chainCfg) => {
  const { nodes, byLevel } = collectNodes(cfg, notes);
  buildEdges(cfg, nodes, byLevel, resolverFor(notes));
  return nodes;
};

const chainCfg: MapCfg = {
  levels: [
    { id: "goals", from: "g", card: { title: "title" } },
    { id: "projects", from: "p", card: { title: "title", meta: ["status"] } },
    { id: "tasks", from: "t", card: { title: "title", meta: ["status"] } },
  ],
  edges: [
    { from: "goals", to: "projects", via: "goal" },
    { from: "projects", to: "tasks", via: "project" },
  ],
  filter: ["status"],
};

const chainNotes = [
  mk("g/G.md", { title: "G" }),
  mk("p/P1.md", { title: "P1", goal: "[[G]]", status: "wip" }),
  mk("p/P2.md", { title: "P2", goal: "[[G]]", status: "done" }),
  mk("t/T1.md", { title: "T1", project: "[[P1]]", status: "wip" }),
  mk("t/T2.md", { title: "T2", project: "[[P1]]", status: "done" }),
  mk("t/T3.md", { title: "T3", project: "[[P2]]", status: "wip" }),
];

const NONE = {} as Record<string, Set<string>>;

describe("computeVisible — collapse", () => {
  it("collapsing a node hides its primary subtree but keeps the node itself", () => {
    const nodes = buildChain();
    const vis = computeVisible(nodes, new Set(["p/P1.md"]), NONE, chainCfg);
    // collapsed node stays visible
    expect(vis.has("p/P1.md")).toBe(true);
    // its primary children (T1, T2) and their subtree are hidden
    expect(vis.has("t/T1.md")).toBe(false);
    expect(vis.has("t/T2.md")).toBe(false);
    // unrelated branch under P2 is untouched
    expect(vis.has("p/P2.md")).toBe(true);
    expect(vis.has("t/T3.md")).toBe(true);
    expect(vis.has("g/G.md")).toBe(true);
  });

  it("empty collapse + empty filters => everything visible", () => {
    const nodes = buildChain();
    const vis = computeVisible(nodes, new Set(), NONE, chainCfg);
    expect(vis.size).toBe(Object.keys(nodes).length);
  });

  it("collapsing a leaf hides nothing (no primary children)", () => {
    const nodes = buildChain();
    const vis = computeVisible(nodes, new Set(["t/T1.md"]), NONE, chainCfg);
    expect(vis.has("t/T1.md")).toBe(true);
    expect(vis.size).toBe(Object.keys(nodes).length);
  });
});

describe("computeVisible — a child reachable via a non-collapsed primary parent stays visible", () => {
  // C has two parents A and B (both primary edges exist), but its primaryParent is
  // whichever linked first. buildEdges processes the `via` array in order, and the
  // first non-secondary parent wins. Order the `parent` array so B (non-collapsed)
  // is primaryParent; collapsing A (a non-primary parent) must NOT hide C.
  const cfg: MapCfg = {
    levels: [
      { id: "tops", from: "top", card: { title: "title" } },
      { id: "kids", from: "kid", card: { title: "title" } },
    ],
    // reverse edge: a `top` note lists the `kid` notes it parents via `children`
    edges: [{ from: "tops", to: "kids", via: "children", reverse: true }],
  };
  const notes = [
    mk("top/A.md", { title: "A", children: ["[[C]]"] }),
    mk("top/B.md", { title: "B", children: ["[[C]]"] }),
    mk("kid/C.md", { title: "C" }),
  ];

  it("primaryParent is the first-linked parent and collapsing the OTHER parent leaves the child visible", () => {
    const { nodes, byLevel } = collectNodes(cfg, notes);
    buildEdges(cfg, nodes, byLevel, resolverFor(notes));
    // A sorts before B by path, so A links first => A is the primaryParent.
    expect(nodes["kid/C.md"].primaryParent).toBe("top/A.md");
    expect(nodes["kid/C.md"].parents.has("top/B.md")).toBe(true);

    // Collapsing B (NOT the primaryParent) must not hide C — primKids only follows primaryParent.
    const vis = computeVisible(nodes, new Set(["top/B.md"]), NONE, cfg);
    expect(vis.has("kid/C.md")).toBe(true);
    expect(vis.has("top/B.md")).toBe(true);

    // Collapsing A (the primaryParent) does hide C.
    const vis2 = computeVisible(nodes, new Set(["top/A.md"]), NONE, cfg);
    expect(vis2.has("kid/C.md")).toBe(false);
  });
});

describe("computeVisible — filters", () => {
  it("a filtered-out node hides itself and its primary descendants", () => {
    const nodes = buildChain();
    // only show status=done; P1 is wip => excluded, so P1 + its primary subtree (T1, T2) hidden
    const filters = { status: new Set(["done"]) };
    const vis = computeVisible(nodes, new Set(), filters, chainCfg);
    expect(vis.has("p/P1.md")).toBe(false);
    expect(vis.has("t/T1.md")).toBe(false);
    expect(vis.has("t/T2.md")).toBe(false);
    // P2 is done => kept. T3 is wip => excluded on its own (doesn't match done).
    expect(vis.has("p/P2.md")).toBe(true);
    expect(vis.has("t/T3.md")).toBe(false);
    // goal has no `status` property at all, so the filter doesn't constrain it.
    expect(vis.has("g/G.md")).toBe(true);
  });

  it("OR within a single property: selecting two values shows nodes matching either", () => {
    const nodes = buildChain();
    const filters = { status: new Set(["wip", "done"]) };
    const vis = computeVisible(nodes, new Set(), filters, chainCfg);
    // every status-bearing node matches one of the two values; nothing hidden by filter
    ["p/P1.md", "p/P2.md", "t/T1.md", "t/T2.md", "t/T3.md", "g/G.md"].forEach((id) =>
      expect(vis.has(id)).toBe(true),
    );
  });

  it("AND across different properties: a node must satisfy every property that has a selection", () => {
    const cfg: MapCfg = {
      levels: [{ id: "items", from: "i", card: { title: "title" } }],
      filter: ["status", "team"],
    };
    const notes = [
      mk("i/Match.md", { title: "Match", status: "wip", team: "core" }),
      mk("i/WrongTeam.md", { title: "WrongTeam", status: "wip", team: "ops" }),
      mk("i/WrongStatus.md", { title: "WrongStatus", status: "done", team: "core" }),
    ];
    const { nodes, byLevel } = collectNodes(cfg, notes);
    buildEdges(cfg, nodes, byLevel, resolverFor(notes));
    const filters = { status: new Set(["wip"]), team: new Set(["core"]) };
    const vis = computeVisible(nodes, new Set(), filters, cfg);
    expect(vis.has("i/Match.md")).toBe(true);
    expect(vis.has("i/WrongTeam.md")).toBe(false);
    expect(vis.has("i/WrongStatus.md")).toBe(false);
  });

  it("a filter only constrains nodes that HAVE the property: a whole level lacking it is not blanked", () => {
    const nodes = buildChain();
    // goals carry no `status`; filtering on status must keep the goal level intact
    const filters = { status: new Set(["done"]) };
    const vis = computeVisible(nodes, new Set(), filters, chainCfg);
    expect(vis.has("g/G.md")).toBe(true);
  });

  it("empty filter sets (selection present but no values) => everything passes", () => {
    const nodes = buildChain();
    const filters = { status: new Set<string>() };
    const vis = computeVisible(nodes, new Set(), filters, chainCfg);
    expect(vis.size).toBe(Object.keys(nodes).length);
  });
});

describe("passesFilters — unit", () => {
  const cfg: MapCfg = { levels: [{ id: "x", from: "x" }], filter: ["status", "team"] };
  const node = (fm: Record<string, any>) => {
    const { nodes, byLevel } = collectNodes(cfg, [mk("x/N.md", { title: "N", ...fm })]);
    buildEdges(cfg, nodes, byLevel, resolverFor([]));
    return nodes["x/N.md"];
  };

  it("passes when no selection for any filtered property", () => {
    expect(passesFilters(node({ status: "wip" }), NONE, cfg)).toBe(true);
  });

  it("passes when the node lacks the filtered property even though a selection exists", () => {
    // node has no `status` => that property does not constrain it
    expect(passesFilters(node({ team: "core" }), { status: new Set(["done"]) }, cfg)).toBe(true);
  });

  it("fails when the node has the property and matches no selected value", () => {
    expect(passesFilters(node({ status: "wip" }), { status: new Set(["done"]) }, cfg)).toBe(false);
  });

  it("matches wikilink-valued properties by their resolved key", () => {
    // fieldArr runs values through linkKey, so the selection holds the bare key, not "[[Goal A]]"
    const n = node({ status: "[[Goal A]]" });
    expect(passesFilters(n, { status: new Set(["Goal A"]) }, cfg)).toBe(true);
    expect(passesFilters(n, { status: new Set(["[[Goal A]]"]) }, cfg)).toBe(false);
  });

  it("a property absent from cfg.filter is ignored even if a selection is passed", () => {
    // `priority` is not in cfg.filter => never consulted
    expect(passesFilters(node({ priority: "low" }), { priority: new Set(["high"]) }, cfg)).toBe(true);
  });
});
