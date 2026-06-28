import { describe, it, expect } from "vitest";
import { collectNodes, AUTO_COLORS } from "../src/graph";
import type { MapCfg } from "../src/graph";
import { mk } from "./fixtures";

describe("collectNodes — inFolder selection", () => {
  it("collects notes inside a level's folder and subfolders, drops notes outside", () => {
    const cfg: MapCfg = { levels: [{ id: "lv", from: "area" }] };
    const notes = [
      mk("area/Direct.md"),
      mk("area/sub/Nested.md"),
      mk("other/Outside.md"),
      mk("areaX/NotChild.md"), // prefix-only, not a folder boundary
    ];
    const { nodes, byLevel } = collectNodes(cfg, notes);
    expect(Object.keys(nodes).sort()).toEqual(["area/Direct.md", "area/sub/Nested.md"]);
    expect(byLevel[0].map((n) => n.path)).toEqual(["area/Direct.md", "area/sub/Nested.md"]);
  });
});

describe("collectNodes — where: { parentId: null }", () => {
  // null / empty-string / missing are all treated as "no parent" (load-bearing for the strategy map)
  it("keeps explicit-null and missing parentId and drops a real parentId value", () => {
    const cfg: MapCfg = { levels: [{ id: "roots", from: "r", where: { parentId: null } }] };
    const notes = [
      mk("r/ExplicitNull.md", { parentId: null }),
      mk("r/Missing.md", {}),
      mk("r/HasParent.md", { parentId: "[[Some Parent]]" }),
    ];
    const { nodes } = collectNodes(cfg, notes);
    expect(Object.keys(nodes).sort()).toEqual([
      "r/ExplicitNull.md",
      "r/Missing.md",
    ]);
    expect(nodes["r/HasParent.md"]).toBeUndefined();
  });

  it("keeps an empty-string parentId (treated as null)", () => {
    const cfg: MapCfg = { levels: [{ id: "roots", from: "r", where: { parentId: null } }] };
    const notes = [mk("r/Empty.md", { parentId: "" })];
    const { nodes } = collectNodes(cfg, notes);
    expect(nodes["r/Empty.md"]).toBeDefined();
  });
});

describe("collectNodes — first-matching-level-only", () => {
  it("places a path matching two levels' folders in the FIRST level and only once", () => {
    const cfg: MapCfg = {
      levels: [
        { id: "all", from: "" }, // empty folder matches every path
        { id: "shared", from: "shared" },
      ],
    };
    const notes = [mk("shared/Note.md"), mk("loose/Other.md")];
    const { nodes, byLevel } = collectNodes(cfg, notes);
    expect(Object.keys(nodes)).toHaveLength(2);
    expect(byLevel[0].map((n) => n.path).sort()).toEqual(["loose/Other.md", "shared/Note.md"]);
    expect(byLevel[1]).toHaveLength(0);
    expect(nodes["shared/Note.md"].levelIdx).toBe(0);
  });
});

describe("collectNodes — card extraction", () => {
  it("title falls back to basename when card.title field is absent or empty", () => {
    const cfg: MapCfg = {
      levels: [{ id: "lv", from: "c", card: { title: "title" } }],
    };
    const notes = [
      mk("c/WithTitle.md", { title: "Real Title" }),
      mk("c/NoTitleField.md", {}),
      mk("c/EmptyTitle.md", { title: "" }),
    ];
    const { nodes } = collectNodes(cfg, notes);
    expect(nodes["c/WithTitle.md"].title).toBe("Real Title");
    expect(nodes["c/NoTitleField.md"].title).toBe("NoTitleField");
    expect(nodes["c/EmptyTitle.md"].title).toBe("EmptyTitle");
  });

  it("sub is the resolved single field; meta joins multiple fields and drops empties", () => {
    const cfg: MapCfg = {
      levels: [
        { id: "lv", from: "c", card: { sub: "kpi", meta: ["status", "owner", "blank"] } },
      ],
    };
    const notes = [
      mk("c/Note.md", { kpi: "north star", status: "wip", owner: "[[Alice|A]]", blank: "" }),
    ];
    const { nodes } = collectNodes(cfg, notes);
    expect(nodes["c/Note.md"].sub).toBe("north star");
    // blank field is dropped; wikilink owner reduced to its key; joined with the separator
    expect(nodes["c/Note.md"].meta).toBe("wip  ·  Alice");
  });

  it("progress parses to a number, and is null when absent or non-numeric", () => {
    const cfg: MapCfg = {
      levels: [{ id: "lv", from: "c", card: { progress: "progress" } }],
    };
    const notes = [
      mk("c/Numeric.md", { progress: 75 }),
      mk("c/NumericStr.md", { progress: "42" }),
      mk("c/Absent.md", {}),
      mk("c/NonNumeric.md", { progress: "soon" }),
    ];
    const { nodes } = collectNodes(cfg, notes);
    expect(nodes["c/Numeric.md"].progress).toBe(75);
    expect(nodes["c/NumericStr.md"].progress).toBe(42);
    expect(nodes["c/Absent.md"].progress).toBeNull();
    expect(nodes["c/NonNumeric.md"].progress).toBeNull();
  });

  it("bars uses countByCat: groups by trailing-parens category, sorted by count desc", () => {
    const cfg: MapCfg = {
      levels: [{ id: "lv", from: "c", card: { bars: "accounts" } }],
    };
    const notes = [
      mk("c/Note.md", {
        accounts: ["Acme (client)", "Beta (prospect)", "Gamma (client)", "Delta (client)"],
      }),
      mk("c/NoBars.md", {}),
    ];
    const { nodes } = collectNodes(cfg, notes);
    expect(nodes["c/Note.md"].bars).toEqual([
      ["client", 3],
      ["prospect", 1],
    ]);
    expect(nodes["c/NoBars.md"].bars).toEqual([]);
  });
});

describe("collectNodes — color", () => {
  it("uses explicit level.color when present, else cycles AUTO_COLORS by level index", () => {
    const cfg: MapCfg = {
      levels: [
        { id: "a", from: "a", color: "#abcdef" },
        { id: "b", from: "b" },
        { id: "c", from: "c" },
      ],
    };
    const notes = [mk("a/A.md"), mk("b/B.md"), mk("c/C.md")];
    const { nodes } = collectNodes(cfg, notes);
    expect(nodes["a/A.md"].color).toBe("#abcdef");
    expect(nodes["b/B.md"].color).toBe(AUTO_COLORS[1]);
    expect(nodes["c/C.md"].color).toBe(AUTO_COLORS[2]);
  });

  it("cycles AUTO_COLORS modulo its length past the palette end", () => {
    const levels = Array.from({ length: AUTO_COLORS.length + 1 }, (_, i) => ({
      id: `l${i}`,
      from: `f${i}`,
    }));
    const cfg: MapCfg = { levels };
    const notes = levels.map((l, i) => mk(`f${i}/N${i}.md`));
    const { nodes } = collectNodes(cfg, notes);
    const lastIdx = AUTO_COLORS.length; // wraps to 0
    expect(nodes[`f${lastIdx}/N${lastIdx}.md`].color).toBe(AUTO_COLORS[0]);
  });
});

describe("collectNodes — collIdx", () => {
  it("reflects sorted-by-path order within the source folder", () => {
    const cfg: MapCfg = { levels: [{ id: "lv", from: "s" }] };
    // supplied out of order; collIdx should track the path-sorted position
    const notes = [
      mk("s/Charlie.md"),
      mk("s/Alpha.md"),
      mk("s/Bravo.md"),
    ];
    const { nodes } = collectNodes(cfg, notes);
    expect(nodes["s/Alpha.md"].collIdx).toBe(0);
    expect(nodes["s/Bravo.md"].collIdx).toBe(1);
    expect(nodes["s/Charlie.md"].collIdx).toBe(2);
  });

  it("collIdx counts position in the sorted source folder, including where-filtered notes", () => {
    // Alpha sorts first but is dropped by where; Bravo keeps collIdx 1 (its sorted position)
    const cfg: MapCfg = { levels: [{ id: "lv", from: "s", where: { parentId: null } }] };
    const notes = [
      mk("s/Bravo.md", {}),
      mk("s/Alpha.md", { parentId: "[[X]]" }),
    ];
    const { nodes } = collectNodes(cfg, notes);
    expect(nodes["s/Alpha.md"]).toBeUndefined();
    expect(nodes["s/Bravo.md"].collIdx).toBe(1);
  });
});
