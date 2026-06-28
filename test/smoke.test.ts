import { describe, it, expect } from "vitest";
import { collectNodes, buildEdges } from "../src/graph";
import { simpleNotes, simpleCfg, resolverFor } from "./fixtures";

describe("harness smoke", () => {
  it("collects + links the simple chain", () => {
    const { nodes, byLevel } = collectNodes(simpleCfg, simpleNotes);
    buildEdges(simpleCfg, nodes, byLevel, resolverFor(simpleNotes));
    expect(Object.keys(nodes)).toHaveLength(3);
    expect(nodes["t/T1.md"].primaryParent).toBe("p/Proj 1.md");
    expect(nodes["p/Proj 1.md"].primaryParent).toBe("g/Goal A.md");
  });
});
