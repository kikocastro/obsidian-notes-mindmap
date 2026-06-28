import { describe, it, expect } from "vitest";
import { collectNodes, buildEdges, siblings } from "../src/graph";
import type { MapCfg } from "../src/graph";
import { mk, resolverFor } from "./fixtures";

// goal -> projects -> tasks, with two projects under one goal and two tasks under one project.
const notes = [
  mk("goals/Grow revenue.md", { title: "Grow revenue" }),
  mk("projects/Pricing revamp.md", {
    title: "Pricing revamp",
    goal: "[[Grow revenue]]",
  }),
  mk("projects/Onboarding redesign.md", {
    title: "Onboarding redesign",
    goal: "[[Grow revenue]]",
  }),
  mk("tasks/Audit current pricing.md", {
    title: "Audit current pricing",
    project: "[[Pricing revamp]]",
  }),
  mk("tasks/Draft new tiers.md", {
    title: "Draft new tiers",
    project: "[[Pricing revamp]]",
  }),
];
const cfg: MapCfg = {
  levels: [
    { id: "goals", from: "goals", card: { title: "title" } },
    { id: "projects", from: "projects", card: { title: "title" } },
    { id: "tasks", from: "tasks", card: { title: "title" } },
  ],
  edges: [
    { from: "goals", to: "projects", via: "goal" },
    { from: "projects", to: "tasks", via: "project" },
  ],
};

const build = () => {
  const { nodes, byLevel } = collectNodes(cfg, notes);
  buildEdges(cfg, nodes, byLevel, resolverFor(notes));
  return nodes;
};

describe("siblings", () => {
  it("returns notes sharing a parent, excluding the node itself", () => {
    const nodes = build();
    expect(siblings(nodes, "projects/Pricing revamp.md")).toEqual([
      "projects/Onboarding redesign.md",
    ]);
    expect(siblings(nodes, "tasks/Audit current pricing.md")).toEqual([
      "tasks/Draft new tiers.md",
    ]);
  });

  it("returns nothing for a root note with no parents", () => {
    const nodes = build();
    expect(siblings(nodes, "goals/Grow revenue.md")).toEqual([]);
  });

  it("returns nothing for an unknown id", () => {
    const nodes = build();
    expect(siblings(nodes, "tasks/Does not exist.md")).toEqual([]);
  });
});
