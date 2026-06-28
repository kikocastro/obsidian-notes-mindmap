import type { MapCfg, NoteLike, Resolver } from "../src/graph";

// build a NoteLike from a path; basename = filename without .md
export const mk = (path: string, frontmatter: Record<string, any> = {}): NoteLike => ({
  path,
  basename: path.replace(/^.*\//, "").replace(/\.md$/, ""),
  frontmatter,
});

// an Obsidian-style resolver backed by an in-memory note list (basename match)
export const resolverFor = (notes: NoteLike[]): Resolver =>
  (key) => notes.find((n) => n.basename === key)?.path ?? null;

// the handoff's sketch vault: goals -> projects -> tasks
export const simpleNotes: NoteLike[] = [
  mk("g/Goal A.md", { title: "Goal A", kpi: "north star" }),
  mk("p/Proj 1.md", { title: "Proj 1", goal: "[[Goal A]]", status: "wip" }),
  mk("t/T1.md", { title: "T1", project: "[[Proj 1]]", status: "done", progress: 100 }),
];
export const simpleCfg: MapCfg = {
  levels: [
    { id: "goals", from: "g", label: "GOALS", card: { title: "title", sub: "kpi" } },
    { id: "projects", from: "p", label: "PROJECTS", card: { title: "title", meta: ["status"] } },
    { id: "tasks", from: "t", label: "TASKS", card: { title: "title", meta: ["status"], progress: "progress" } },
  ],
  edges: [
    { from: "goals", to: "projects", via: "goal" },
    { from: "projects", to: "tasks", via: "project" },
  ],
  filter: ["status"],
};
