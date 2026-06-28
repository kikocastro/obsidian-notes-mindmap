import { describe, it, expect } from "vitest";
import {
  MapCfg, collectNodes, buildEdges, isSecondary, computeVisible, orderAndLayout,
} from "../src/graph";
import { mk, resolverFor } from "./fixtures";

// A scaled-down copy of the real product OST the plugin was validated against:
// North Star -> KPIs -> Drivers -> Opportunities -> Roadmap, exercising every
// risky edge feature at once (reverse, dotted via, secondary, where:{parentId:null}).
// Counts below are hand-derived so this doubles as the handoff "oracle" cross-check.
const notes = [
  mk("strategy/north-star/NS1.md", { title: "NS1", metric: "m" }),

  mk("strategy/kpis/K1.md", { title: "K1", north_star: "[[NS1]]", metric: "m", horizon: "now" }),
  mk("strategy/kpis/K2.md", { title: "K2", north_star: "[[NS1]]", metric: "m", horizon: "next" }),

  mk("strategy/drivers/D1.md", { title: "D1", business_kpi: "[[K1]]", metric: "m" }),
  mk("strategy/drivers/D2.md", { title: "D2", business_kpi: "[[K2]]", metric: "m", serves: ["[[O3]]"] }),

  mk("strategy/opps/O1.md", { title: "O1", "ladders-to": "[[D1]]", kind: "growth", horizon: "now", demand: ["A (client)", "B (client)", "C (prospect)"] }),
  mk("strategy/opps/O2.md", { title: "O2", "ladders-to": "[[D1]]", kind: "retention", horizon: "next", demand: ["D (client)"] }),
  mk("strategy/opps/O3.md", { title: "O3", kind: "growth", horizon: "now", demand: ["E (prospect)"] }),

  mk("strategy/roadmap/R1.md", { title: "R1", customFields: { serves: ["[[O1]]"] }, status: "active", progress: 60, parentId: null }),
  mk("strategy/roadmap/R2.md", { title: "R2", customFields: { serves: ["[[O2]]"], alsoServes: ["[[O1]]"] }, status: "done", progress: 100 }),
  mk("strategy/roadmap/R3.md", { title: "R3", customFields: { serves: ["[[O3]]"] }, status: "active", progress: 0, parentId: "" }),
  mk("strategy/roadmap/R4.md", { title: "R4", customFields: { serves: ["[[O1]]"] }, status: "active", parentId: "R1" }),
];

const cfg: MapCfg = {
  levels: [
    { id: "northstar", from: "strategy/north-star", card: { title: "title", sub: "metric" } },
    { id: "kpis", from: "strategy/kpis", card: { title: "title", sub: "metric", meta: ["horizon"] } },
    { id: "drivers", from: "strategy/drivers", card: { title: "title", sub: "metric" } },
    { id: "opportunities", from: "strategy/opps", card: { title: "title", meta: ["kind", "horizon"], bars: "demand" } },
    { id: "roadmap", from: "strategy/roadmap", where: { parentId: null }, card: { title: "title", meta: ["status"], progress: "progress" } },
  ],
  edges: [
    { from: "northstar", to: "kpis", via: "north_star" },
    { from: "kpis", to: "drivers", via: "business_kpi" },
    { from: "drivers", to: "opportunities", via: "ladders-to" },
    { from: "drivers", to: "opportunities", via: "serves", reverse: true },
    { from: "opportunities", to: "roadmap", via: "customFields.serves" },
    { from: "opportunities", to: "roadmap", via: "customFields.alsoServes", secondary: true },
  ],
  filter: ["horizon", "kind", "status"],
};

describe("OST integration (oracle cross-check)", () => {
  const { nodes, byLevel } = collectNodes(cfg, notes);
  const edgeKind = buildEdges(cfg, nodes, byLevel, resolverFor(notes));

  it("collects the right node count and shape, dropping where:parentId!=null", () => {
    expect(byLevel.map((l) => l.length)).toEqual([1, 2, 2, 3, 3]); // R4 dropped (real parentId)
    expect(Object.keys(nodes)).toHaveLength(11);
    expect(nodes["strategy/roadmap/R4.md"]).toBeUndefined();
    expect(nodes["strategy/roadmap/R3.md"]).toBeDefined(); // empty-string parentId kept
    expect(nodes["strategy/roadmap/R2.md"]).toBeDefined(); // missing parentId kept
  });

  it("builds primary edges across all levels, with one secondary (dashed) cross-link", () => {
    const kinds = [...edgeKind.values()];
    expect(kinds.filter((k) => k === "primary")).toHaveLength(10);
    expect(kinds.filter((k) => k === "secondary")).toHaveLength(1);
    // the alsoServes link is the secondary one; serves is primary for the same target
    expect(isSecondary(edgeKind, "strategy/opps/O1.md", "strategy/roadmap/R2.md")).toBe(true);
    expect(isSecondary(edgeKind, "strategy/opps/O2.md", "strategy/roadmap/R2.md")).toBe(false);
  });

  it("reverse + dotted via resolve their edges", () => {
    expect(nodes["strategy/opps/O3.md"].primaryParent).toBe("strategy/drivers/D2.md"); // via reverse serves
    expect(nodes["strategy/roadmap/R1.md"].primaryParent).toBe("strategy/opps/O1.md"); // via customFields.serves
  });

  it("every non-root node has a primary parent (no orphans in this fixture)", () => {
    const orphans = Object.values(nodes).filter((n) => n.levelIdx > 0 && !n.primaryParent);
    expect(orphans).toHaveLength(0);
    expect(nodes["strategy/north-star/NS1.md"].primaryParent).toBeNull();
  });

  it("extracts bars and numeric progress (including 0)", () => {
    expect(nodes["strategy/opps/O1.md"].bars).toEqual([["client", 2], ["prospect", 1]]);
    expect(nodes["strategy/roadmap/R1.md"].progress).toBe(60);
    expect(nodes["strategy/roadmap/R3.md"].progress).toBe(0);
  });

  it("lays out all visible nodes without dropping any", () => {
    const vis = computeVisible(nodes, new Set(), {}, cfg);
    const { order, contentRight, contentBottom } = orderAndLayout(cfg, nodes, byLevel, vis);
    expect(order.reduce((s, l) => s + l.length, 0)).toBe(11);
    expect(order[4]).toContain("strategy/roadmap/R1.md");
    expect(contentRight).toBeGreaterThan(0);
    expect(contentBottom).toBeGreaterThan(0);
    // columns march left-to-right
    expect(nodes["strategy/kpis/K1.md"].x!).toBeGreaterThan(nodes["strategy/north-star/NS1.md"].x!);
  });
});
