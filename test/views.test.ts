import { describe, it, expect } from "vitest";
import { upsertView, viewNameTaken } from "../src/graph";
import type { SavedViewCfg } from "../src/graph";

// the saved-views toolbar (Save current as… / Edit / Delete) leans on these pure
// list ops; the adapter only adds the prompt + YAML persistence. Pin the behaviour
// here so a broken prompt is the only thing that can stop a save (it was: Electron
// has no window.prompt, so the old code bailed every time).

const v = (
  name: string,
  filters: Record<string, string[]> = {}
): SavedViewCfg => ({
  name,
  filters,
});

describe("upsertView", () => {
  it("appends a new view when the name is unused", () => {
    const views = [v("Active")];
    const next = upsertView(views, v("Done", { status: ["done"] }));
    expect(next.map((x) => x.name)).toEqual(["Active", "Done"]);
    expect(views).toHaveLength(1); // does not mutate the input
  });

  it("replaces the same-named view in place (no duplicate)", () => {
    const views = [v("Active", { status: ["todo"] }), v("Done")];
    const next = upsertView(views, v("Active", { status: ["doing"] }));
    expect(next.map((x) => x.name)).toEqual(["Active", "Done"]);
    expect(next[0].filters).toEqual({ status: ["doing"] });
  });
});

describe("viewNameTaken", () => {
  it("is true when another view already uses the name", () => {
    expect(viewNameTaken([v("Active"), v("Done")], "Done")).toBe(true);
  });

  it("ignores the view being renamed (exceptName)", () => {
    // renaming "Active" -> "Active" must not count as a collision
    expect(viewNameTaken([v("Active"), v("Done")], "Active", "Active")).toBe(
      false
    );
    // but renaming "Active" -> "Done" still collides
    expect(viewNameTaken([v("Active"), v("Done")], "Done", "Active")).toBe(
      true
    );
  });

  it("is false for a fresh name", () => {
    expect(viewNameTaken([v("Active")], "Backlog")).toBe(false);
  });
});
