import { describe, it, expect } from "vitest";
import {
  linkKey,
  asArray,
  getPath,
  fieldStr,
  fieldArr,
  num,
  countByCat,
  wrap,
  catColor,
  inFolder,
  matchesWhere,
  CATEGORY_COLORS,
  AUTO_COLORS,
} from "../src/graph";

describe("linkKey", () => {
  it("strips [[Note|alias]] to the target note", () => {
    expect(linkKey("[[Note|alias]]")).toBe("Note");
  });

  it("strips [[Note#heading]] to the target note", () => {
    expect(linkKey("[[Note#heading]]")).toBe("Note");
  });

  it("passes a plain string through", () => {
    expect(linkKey("Just a title")).toBe("Just a title");
  });

  it("trims surrounding whitespace", () => {
    expect(linkKey("  spaced  ")).toBe("spaced");
    expect(linkKey("[[ Inner Space ]]")).toBe("Inner Space");
  });

  it("turns null into an empty string", () => {
    expect(linkKey(null)).toBe("");
  });

  it("stringifies a number", () => {
    expect(linkKey(42)).toBe("42");
  });
});

describe("asArray", () => {
  it("passes an array through unchanged", () => {
    const arr = [1, 2, 3];
    expect(asArray(arr)).toBe(arr);
  });

  it("maps null to []", () => {
    expect(asArray(null)).toEqual([]);
  });

  it("maps empty string to []", () => {
    expect(asArray("")).toEqual([]);
  });

  it("maps undefined to []", () => {
    expect(asArray(undefined)).toEqual([]);
  });

  it("wraps a scalar in a single-element array", () => {
    expect(asArray("x")).toEqual(["x"]);
    expect(asArray(0)).toEqual([0]);
  });
});

describe("getPath", () => {
  it("reads a flat key", () => {
    expect(getPath({ a: 1 }, "a")).toBe(1);
  });

  it("reaches into a dotted nested path", () => {
    expect(getPath({ customFields: { serves: "x" } }, "customFields.serves")).toBe("x");
  });

  it("returns undefined for a missing path", () => {
    expect(getPath({ a: 1 }, "b.c")).toBeUndefined();
  });

  it("is null-safe mid-path", () => {
    expect(getPath({ customFields: null }, "customFields.serves")).toBeNull();
  });

  it("returns undefined when no key is given", () => {
    expect(getPath({ a: 1 }, undefined)).toBeUndefined();
  });
});

describe("fieldStr", () => {
  it("joins a list with ', ' and applies linkKey", () => {
    expect(fieldStr({ tags: ["[[A|x]]", "[[B#h]]"] }, "tags")).toBe("A, B");
  });

  it("renders a scalar value via linkKey", () => {
    expect(fieldStr({ goal: "[[Goal A]]" }, "goal")).toBe("Goal A");
  });

  it("returns '' for an undefined key", () => {
    expect(fieldStr({ a: 1 }, undefined)).toBe("");
  });
});

describe("fieldArr", () => {
  it("maps each entry through linkKey", () => {
    expect(fieldArr({ tags: ["[[A|x]]", "B"] }, "tags")).toEqual(["A", "B"]);
  });

  it("filters out falsy entries", () => {
    expect(fieldArr({ tags: ["A", "", null] }, "tags")).toEqual(["A"]);
  });

  it("returns [] for an undefined key", () => {
    expect(fieldArr({ a: 1 }, undefined)).toEqual([]);
  });
});

describe("num", () => {
  it("parses a numeric string", () => {
    expect(num("42")).toBe(42);
  });

  it("passes a number through", () => {
    expect(num(7)).toBe(7);
  });

  it("returns null for null", () => {
    expect(num(null)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(num("")).toBeNull();
  });

  it("returns null for a non-numeric string", () => {
    expect(num("abc")).toBeNull();
  });

  it("keeps 0 as 0 (not null)", () => {
    expect(num(0)).toBe(0);
    expect(num("0")).toBe(0);
  });
});

describe("countByCat", () => {
  it("categorises by trailing-parens text and sorts by count desc then name", () => {
    expect(
      countByCat({ d: ["Acme (client)", "X (client)", "Y (prospect)"] }, "d"),
    ).toEqual([
      ["client", 2],
      ["prospect", 1],
    ]);
  });

  it("uses the lowercased value itself when there are no trailing parens", () => {
    expect(countByCat({ d: ["Alpha", "alpha"] }, "d")).toEqual([["alpha", 2]]);
  });

  it("returns [] for an empty list", () => {
    expect(countByCat({ d: [] }, "d")).toEqual([]);
  });

  it("returns [] for a missing key", () => {
    expect(countByCat({ d: [] }, undefined)).toEqual([]);
  });
});

describe("wrap", () => {
  it("breaks long text across lines by approximate width", () => {
    const lines = wrap("one two three four five six", 80, 14, 5);
    expect(lines.length).toBeGreaterThan(1);
    // every original word is preserved across the wrapped lines
    expect(lines.join(" ").split(/\s+/).sort()).toEqual(
      ["five", "four", "one", "six", "three", "two"],
    );
  });

  it("never exceeds the max line count", () => {
    const lines = wrap("a b c d e f g h i j k l m n o p", 20, 14, 3);
    expect(lines.length).toBeLessThanOrEqual(3);
  });

  it("keeps short text on a single line", () => {
    expect(wrap("hi", 200, 14, 4)).toEqual(["hi"]);
  });
});

describe("catColor", () => {
  it("returns the configured colour for a known category", () => {
    expect(catColor("client", 0)).toBe(CATEGORY_COLORS.client);
    expect(catColor("prospect", 5)).toBe(CATEGORY_COLORS.prospect);
    expect(catColor("trial", 2)).toBe(CATEGORY_COLORS.trial);
  });

  it("cycles the auto palette by index for an unknown category", () => {
    expect(catColor("mystery", 0)).toBe(AUTO_COLORS[0]);
    expect(catColor("mystery", 1)).toBe(AUTO_COLORS[1]);
    // wraps around the palette length
    expect(catColor("mystery", AUTO_COLORS.length)).toBe(AUTO_COLORS[0]);
  });
});

describe("inFolder", () => {
  it("matches a note directly in the folder", () => {
    expect(inFolder("plan/a.md", "plan")).toBe(true);
  });

  it("matches a note in a subfolder", () => {
    expect(inFolder("plan/sub/a.md", "plan")).toBe(true);
  });

  it("matches everything when the folder is ''", () => {
    expect(inFolder("anything/x.md", "")).toBe(true);
  });

  it("tolerates leading and trailing slashes in the folder arg", () => {
    expect(inFolder("plan/a.md", "/plan/")).toBe(true);
  });

  it("does not match a sibling folder that shares a prefix", () => {
    expect(inFolder("planning/x.md", "plan")).toBe(false);
  });
});

describe("matchesWhere", () => {
  it("keeps a note whose key is null when where requires null", () => {
    expect(matchesWhere({ parentId: null }, { parentId: null })).toBe(true);
  });

  // null/empty/missing are equivalent for a { key: null } where (documented, load-bearing)
  it("keeps a note whose key is '' when where requires null", () => {
    expect(matchesWhere({ parentId: "" }, { parentId: null })).toBe(true);
  });

  it("keeps a note missing the key entirely when where requires null", () => {
    expect(matchesWhere({}, { parentId: null })).toBe(true);
  });

  it("drops a note with a real value when where requires null", () => {
    expect(matchesWhere({ parentId: "[[Parent]]" }, { parentId: null })).toBe(false);
  });

  it("compares a non-null value via fieldStr equality", () => {
    expect(matchesWhere({ status: "[[wip]]" }, { status: "wip" })).toBe(true);
    expect(matchesWhere({ status: "done" }, { status: "wip" })).toBe(false);
  });

  it("supports a dotted where key", () => {
    expect(matchesWhere({ customFields: { kind: "lead" } }, { "customFields.kind": "lead" })).toBe(true);
    expect(matchesWhere({ customFields: { kind: "lead" } }, { "customFields.kind": "x" })).toBe(false);
  });

  it("returns true when where is undefined", () => {
    expect(matchesWhere({ a: 1 }, undefined)).toBe(true);
  });
});
