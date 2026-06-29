import { describe, it, expect } from "vitest";
import {
  mindmapExportPath,
  mindmapExcalidrawPath,
  mapToExcalidraw,
} from "../src/graph";

describe("mindmapExportPath", () => {
  it("puts the .html next to the note, dropping the .md", () => {
    expect(mindmapExportPath("folder/Note.md")).toBe(
      "folder/Note mindmap.html"
    );
  });
  it("handles a note in the vault root", () => {
    expect(mindmapExportPath("Note.md")).toBe("Note mindmap.html");
  });
  it("strips only the trailing .md, keeping dots in the name", () => {
    expect(mindmapExportPath("d/My.Notes.md")).toBe("d/My.Notes mindmap.html");
  });
  it("keeps nested folders", () => {
    expect(mindmapExportPath("a/b/c/N.md")).toBe("a/b/c/N mindmap.html");
  });
});

describe("mindmapExcalidrawPath", () => {
  it("puts the .excalidraw next to the note, dropping the .md", () => {
    expect(mindmapExcalidrawPath("folder/Note.md")).toBe(
      "folder/Note mindmap.excalidraw"
    );
  });
});

describe("mapToExcalidraw", () => {
  const nodes = [
    { x: 0, y: 0, w: 100, h: 40, color: "#f00", text: "Root" },
    { x: 200, y: 0, w: 100, h: 40, color: "#0f0", text: "Child\nsub" },
  ];
  const edges = [{ x1: 100, y1: 20, x2: 200, y2: 20, color: "#f00" }];

  it("wraps a valid Excalidraw v2 file", () => {
    const f = mapToExcalidraw(nodes, edges);
    expect(f.type).toBe("excalidraw");
    expect(f.version).toBe(2);
    expect(Array.isArray(f.elements)).toBe(true);
  });

  it("emits a rectangle + bound text per node, plus an arrow per edge", () => {
    const f = mapToExcalidraw(nodes, edges);
    const byType = (t: string) => f.elements.filter((e) => e.type === t);
    expect(byType("rectangle")).toHaveLength(2);
    expect(byType("text")).toHaveLength(2);
    expect(byType("arrow")).toHaveLength(1);
  });

  it("places the rectangle at the node geometry with its color", () => {
    const r = mapToExcalidraw(nodes, edges).elements.find(
      (e) => e.type === "rectangle"
    )!;
    expect([r.x, r.y, r.width, r.height]).toEqual([0, 0, 100, 40]);
    expect(r.strokeColor).toBe("#f00");
  });

  it("binds each text to its rectangle both ways", () => {
    const els = mapToExcalidraw(nodes, edges).elements;
    const rect = els.find((e) => e.type === "rectangle")!;
    const text = els.find((e) => e.type === "text")!;
    expect(text.containerId).toBe(rect.id);
    expect(rect.boundElements).toContainEqual({ type: "text", id: text.id });
    expect(text.text).toBe("Root");
  });

  it("draws the arrow from edge start to end as relative points", () => {
    const a = mapToExcalidraw(nodes, edges).elements.find(
      (e) => e.type === "arrow"
    )!;
    expect([a.x, a.y]).toEqual([100, 20]);
    expect(a.points).toEqual([
      [0, 0],
      [100, 0],
    ]);
  });

  it("gives every element a unique id", () => {
    const ids = mapToExcalidraw(nodes, edges).elements.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
