// ============================================================================
// Markdown Mindmap — pure logic, Obsidian-free.
// Everything here operates on plain data (NoteLike + a link Resolver) so it can
// be unit-tested without an Obsidian runtime. main.ts owns the DOM/SVG/Modal and
// just feeds these functions and draws what they return. Keep this side-effect free.
// ============================================================================

// flatuicolors.com/palette/defo — the original Flat UI palette
export const AUTO_COLORS = [
  "#1abc9c",
  "#3498db",
  "#9b59b6",
  "#e67e22",
  "#e74c3c",
  "#f1c40f",
  "#16a085",
  "#2980b9",
  "#8e44ad",
  "#d35400",
];
// bar-chart category -> colour, with a sensible default for client/prospect/trial
export const CATEGORY_COLORS: Record<string, string> = {
  client: "#2ecc71",
  prospect: "#f39c12",
  trial: "#3498db",
  customer: "#2ecc71",
  prospect_: "#f39c12",
};

// layout defaults (each overridable per-map via cfg.layout)
export const CARD_W = 270,
  NODE_H = 80,
  V_GAP = 12,
  COL_GAP = 150,
  TOP = 64;

// per-map layout overrides (YAML `layout:`); omitted keys fall back to the defaults above
export interface LayoutCfg {
  cardWidth?: number;
  cardHeight?: number;
  columnGap?: number;
  rowGap?: number;
  top?: number;
  titleLines?: number;
  subLines?: number;
}
export interface ResolvedLayout {
  cardW: number;
  nodeH: number;
  colGap: number;
  vGap: number;
  top: number;
  titleLines: number;
  subLines: number;
}
export const resolveLayout = (l?: LayoutCfg): ResolvedLayout => ({
  cardW: l?.cardWidth ?? CARD_W,
  nodeH: l?.cardHeight ?? NODE_H,
  colGap: l?.columnGap ?? COL_GAP,
  vGap: l?.rowGap ?? V_GAP,
  top: l?.top ?? TOP,
  titleLines: l?.titleLines ?? 2, // node-title lines before truncating (set 3 for a taller card)
  subLines: l?.subLines ?? 1, // subtitle lines before truncating (set 2+ to wrap the sub)
});

// bar chart: a field-name string (legacy) or an object with category mode + colours
export interface BarCfg {
  field: string;
  category?: "parens" | "value";
  colors?: Record<string, string>;
}
export interface CardCfg {
  title?: string;
  sub?: string;
  meta?: string[];
  progress?: string;
  bars?: string | BarCfg;
  labels?: string[];
}
export interface LevelCfg {
  id: string;
  label?: string;
  from: string;
  color?: string;
  card?: CardCfg;
  where?: Record<string, unknown>;
}
export interface EdgeCfg {
  from: string;
  to: string;
  via: string;
  reverse?: boolean;
  secondary?: boolean;
}
export interface SavedViewCfg {
  name: string;
  filters?: Record<string, string[]>;
}
export interface MapCfg {
  title?: string;
  height?: number;
  levels: LevelCfg[];
  edges?: EdgeCfg[];
  filter?: string[];
  filterLabels?: Record<string, string>; // property -> display name for its filter group
  layout?: LayoutCfg;
  properties?: boolean;
  views?: SavedViewCfg[];
  activeView?: string; // name of the saved view to auto-select on (re)render
}

// the minimal note shape the pure logic needs (a TFile-free stand-in)
export interface NoteLike {
  path: string;
  basename: string;
  frontmatter: Record<string, unknown>;
}
// wikilink key + the path it was found in -> resolved note path, or null
export interface Resolver {
  (key: string, fromPath: string): string | null;
}

export interface MNode {
  id: string; // file path (unique key)
  levelIdx: number;
  path: string;
  basename: string;
  fm: Record<string, unknown>;
  title: string;
  sub: string;
  meta: string;
  labels: string[]; // small pill values rendered on the card (card.labels)
  labelColors: string[]; // stable color per configured label field index
  color: string;
  levelLabel: string;
  progress: number | null; // 0-100, or null
  bars: [string, number, string][]; // category -> count -> resolved colour
  collIdx: number; // order within its source folder (layout tiebreak)
  parents: Set<string>;
  children: Set<string>;
  primaryParent: string | null; // the one solid parent (secondary links don't set this)
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

// ---- helpers -------------------------------------------------------------

export const inFolder = (path: string, folder: string): boolean => {
  const f = folder.replace(/^\/+|\/+$/g, "");
  return f === "" ? true : path.startsWith(`${f}/`);
};

// stringify a scalar frontmatter value; null/objects/arrays -> "" (links, categories
// and filter targets are always YAML scalars). Keeps String() off bare `unknown`,
// which would otherwise risk an "[object Object]" stringification.
export const scalarStr = (v: unknown): string =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean"
    ? String(v)
    : "";

// "[[Note|alias]]" / "[[Note#hd]]" / "Title" -> the lookup key (Note / Title)
export const linkKey = (raw: unknown): string => {
  const s = scalarStr(raw).trim();
  const m = s.match(/\[\[([^\]|#]+)/);
  return (m ? m[1] : s).trim();
};

export const asArray = (v: unknown): unknown[] =>
  Array.isArray(v) ? (v as unknown[]) : v == null || v === "" ? [] : [v];

export const wrap = (
  s: string,
  width: number,
  size: number,
  max: number
): string[] => {
  const cpl = Math.max(8, Math.floor(width / (size * 0.55)));
  const words = String(s).split(/\s+/),
    out: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > cpl) {
      out.push(cur);
      cur = w;
    } else cur = (cur + " " + w).trim();
  }
  if (cur) out.push(cur);
  return out.slice(0, max);
};

// card height that hugs its content. Mirrors the vertical metrics both adapters
// draw with (pad 14/14, title 16, sub 15, meta 14, bar 20, label strip 24).
// ponytail: these numbers are duplicated as draw constants in the adapters; if you
// retune card spacing, change both. cardHeight config acts as a minimum floor.
export const MIN_H = 44;
// sub line sits below the collapse toggle, so it gets the full text width (only the
// left/right text padding reserved), unlike the title which reserves padR for the toggle.
export const subWidth = (cardW: number) => cardW - 14 - 16;
export const cardContentHeight = (
  n: MNode,
  cardW: number,
  titleLines: number,
  subLines: number
): number => {
  const padR = n.children.size > 0 ? 42 : 16;
  const tLines = wrap(n.title, cardW - 14 - padR, 12, titleLines).length || 1;
  const sLines = n.sub
    ? wrap(n.sub, subWidth(cardW), 10.5, subLines).length || 1
    : 0;
  const hasBar = n.progress != null || n.bars.length > 0;
  return (
    14 +
    tLines * 16 +
    sLines * 15 +
    (n.meta ? 14 : 0) +
    (hasBar ? 20 : 0) +
    (n.labels.length ? 24 : 0) +
    14
  );
};

// dotted access so `via`/card fields can reach nested frontmatter (e.g. customFields.serves)
export const getPath = (fm: Record<string, unknown>, key?: string): unknown => {
  if (!fm || !key) return undefined;
  if (key.indexOf(".") < 0) return fm[key];
  return key
    .split(".")
    .reduce<unknown>(
      (o, k) => (o == null ? o : (o as Record<string, unknown>)[k]),
      fm
    );
};

export const fieldStr = (fm: Record<string, unknown>, key?: string): string =>
  key ? asArray(getPath(fm, key)).map(linkKey).join(", ") : "";

export const fieldArr = (
  fm: Record<string, unknown>,
  key?: string
): string[] =>
  key ? asArray(getPath(fm, key)).map(linkKey).filter(Boolean) : [];

// per-level include filter, e.g. { parentId: null } keeps only top-level roadmap tasks.
// a `null` target matches null, missing, OR empty (stringifies to "") — the strategy map relies on this.
export const matchesWhere = (
  fm: Record<string, unknown>,
  where?: Record<string, unknown>
): boolean =>
  !where ||
  Object.keys(where).every((k) =>
    where[k] === null
      ? fieldStr(fm, k) === ""
      : fieldStr(fm, k) === scalarStr(where[k])
  );

// list field -> [category, count]. mode "parens" (default): category = text in
// trailing parens, else the value. mode "value": category = the whole value.
export const countByCat = (
  fm: Record<string, unknown>,
  key?: string,
  mode: "parens" | "value" = "parens"
): [string, number][] => {
  if (!key) return [];
  const counts: Record<string, number> = {};
  asArray(getPath(fm, key)).forEach((raw) => {
    const s = scalarStr(raw).trim();
    if (!s) return;
    const m = mode === "value" ? null : s.match(/\(([^)]+)\)\s*$/);
    const cat = (m ? m[1] : s).trim().toLowerCase();
    counts[cat] = (counts[cat] || 0) + 1;
  });
  return Object.entries(counts).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  );
};

// card.bars may be a field-name string (legacy) or a BarCfg object; null when absent/invalid
export const normalizeBars = (bars?: string | BarCfg): BarCfg | null =>
  !bars
    ? null
    : typeof bars === "string"
      ? { field: bars }
      : bars.field
        ? bars
        : null;

export const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
};

// colour for a bar category: configured `colors` map (defaults to CATEGORY_COLORS), else cycle AUTO_COLORS
export const catColor = (
  cat: string,
  i: number,
  colors: Record<string, string> = CATEGORY_COLORS
): string => colors[cat] || AUTO_COLORS[i % AUTO_COLORS.length];

// children this node is the solid (primary) parent of — used by layout + collapse
export const primKids = (nodes: Record<string, MNode>, id: string): string[] =>
  [...nodes[id].children].filter((c) => nodes[c].primaryParent === id);

// throws the documented error when the map has no levels (the code-block processor catches it)
export function validateConfig(
  cfg: MapCfg | null | undefined
): asserts cfg is MapCfg {
  if (!cfg || !Array.isArray(cfg.levels) || !cfg.levels.length)
    throw new Error("config needs a non-empty `levels:` list.");
}

// ---- node collection -----------------------------------------------------

// Folders -> columns. A note lands in its FIRST matching level only; `where`
// filters per level; card fields are extracted into the MNode.
export function collectNodes(
  cfg: MapCfg,
  notes: NoteLike[]
): { nodes: Record<string, MNode>; byLevel: MNode[][] } {
  const nodes: Record<string, MNode> = {};
  const byLevel: MNode[][] = cfg.levels.map(() => []);
  cfg.levels.forEach((lvl, li) => {
    const color = lvl.color || AUTO_COLORS[li % AUTO_COLORS.length];
    const files = notes
      .filter((f) => inFolder(f.path, lvl.from))
      .sort((a, b) => a.path.localeCompare(b.path));
    files.forEach((file, ci) => {
      if (nodes[file.path]) return; // a note appears in its first matching level only
      const fm = file.frontmatter || {};
      if (!matchesWhere(fm, lvl.where)) return; // per-level frontmatter filter (e.g. {parentId: null})
      const card = lvl.card || {};
      const bar = normalizeBars(card.bars);
      const labelEntries = (card.labels || [])
        .map((k, i) => ({
          text: fieldStr(fm, k),
          color: AUTO_COLORS[i % AUTO_COLORS.length],
        }))
        .filter((l) => l.text);
      const n: MNode = {
        id: file.path,
        levelIdx: li,
        path: file.path,
        basename: file.basename,
        fm,
        color,
        collIdx: ci,
        levelLabel: lvl.label || lvl.id,
        title: fieldStr(fm, card.title) || file.basename,
        sub: fieldStr(fm, card.sub),
        meta: (card.meta || [])
          .map((k) => fieldStr(fm, k))
          .filter(Boolean)
          .join("  ·  "),
        labels: labelEntries.map((l) => l.text),
        labelColors: labelEntries.map((l) => l.color),
        progress: num(getPath(fm, card.progress)),
        bars: bar
          ? countByCat(fm, bar.field, bar.category).map(
              ([cat, c], i): [string, number, string] => [
                cat,
                c,
                catColor(cat, i, bar.colors),
              ]
            )
          : [],
        parents: new Set(),
        children: new Set(),
        primaryParent: null,
      };
      nodes[file.path] = n;
      byLevel[li].push(n);
    });
  });
  return { nodes, byLevel };
}

// ---- edges ---------------------------------------------------------------

// Walk cfg.edges, resolve each `via` value to a node in the parent level, and
// record parent/child links. Returns edgeKind: "primary" (solid) vs "secondary"
// (dashed). A node's primaryParent is its FIRST non-secondary parent.
export function buildEdges(
  cfg: MapCfg,
  nodes: Record<string, MNode>,
  byLevel: MNode[][],
  resolveLink?: Resolver
): Map<string, string> {
  // index each level by basename and by `title` frontmatter for link resolution
  const levelIndex = byLevel.map((arr) => {
    const byBase: Record<string, string> = {},
      byTitle: Record<string, string> = {};
    arr.forEach((n) => {
      byBase[n.basename] = n.id;
      const t = scalarStr(n.fm.title).trim();
      if (t) byTitle[t] = n.id;
    });
    return { byBase, byTitle };
  });
  const levelByIdNum: Record<string, number> = {};
  cfg.levels.forEach((l, i) => (levelByIdNum[l.id] = i));

  const edgeKind = new Map<string, string>();
  const link = (parentId: string, childId: string, secondary?: boolean) => {
    if (!nodes[parentId] || !nodes[childId] || parentId === childId) return;
    nodes[parentId].children.add(childId);
    nodes[childId].parents.add(parentId);
    const key = parentId + "|" + childId;
    if (!secondary) {
      edgeKind.set(key, "primary");
      if (!nodes[childId].primaryParent)
        nodes[childId].primaryParent = parentId;
    } else if (!edgeKind.has(key)) {
      edgeKind.set(key, "secondary");
    }
  };
  // resolution order: injected link resolver (e.g. Obsidian wikilink) -> basename -> `title`
  const resolveInLevel = (
    li: number,
    raw: unknown,
    sourcePath: string
  ): string | null => {
    const key = linkKey(raw);
    const dest = resolveLink ? resolveLink(key, sourcePath) : null;
    if (dest && nodes[dest] && nodes[dest].levelIdx === li) return dest;
    return levelIndex[li].byBase[key] || levelIndex[li].byTitle[key] || null;
  };
  (cfg.edges || []).forEach((e) => {
    const fi = levelByIdNum[e.from],
      ti = levelByIdNum[e.to];
    if (fi == null || ti == null) return;
    if (!e.reverse) {
      // `via` is a property on the `to` notes pointing up to a `from` note
      byLevel[ti].forEach((to) =>
        asArray(getPath(to.fm, e.via)).forEach((raw) => {
          const fromId = resolveInLevel(fi, raw, to.path);
          if (fromId) link(fromId, to.id, e.secondary);
        })
      );
    } else {
      // `via` is a property on the `from` notes pointing down to `to` notes
      byLevel[fi].forEach((from) =>
        asArray(getPath(from.fm, e.via)).forEach((raw) => {
          const toId = resolveInLevel(ti, raw, from.path);
          if (toId) link(from.id, toId, e.secondary);
        })
      );
    }
  });
  return edgeKind;
}

export const isSecondary = (
  edgeKind: Map<string, string>,
  p: string,
  c: string
): boolean => edgeKind.get(p + "|" + c) === "secondary";

// ---- visibility (filters + collapse) -------------------------------------

// a filter only constrains nodes that HAVE the property; multi-select is OR within a property, AND across
export const passesFilters = (
  n: MNode,
  filters: Record<string, Set<string>>,
  cfg: MapCfg
): boolean =>
  (cfg.filter || []).every((p) => {
    const sel = filters[p];
    if (!sel || !sel.size) return true;
    const own = fieldArr(n.fm, p);
    if (!own.length) return true;
    return own.some((v) => sel.has(v));
  });

// collapsed nodes hide their primary subtree (keep self); filtered-out nodes hide self + primary subtree
export function computeVisible(
  nodes: Record<string, MNode>,
  collapsed: Set<string>,
  filters: Record<string, Set<string>>,
  cfg: MapCfg
): Set<string> {
  const excluded = new Set<string>();
  Object.values(nodes).forEach((n) => {
    if (!passesFilters(n, filters, cfg)) excluded.add(n.id);
  });
  const hidden = new Set<string>(excluded);
  [...collapsed, ...excluded].forEach((rid) => {
    if (!nodes[rid]) return;
    const stack = [...primKids(nodes, rid)];
    while (stack.length) {
      const x = stack.pop()!;
      if (!hidden.has(x)) {
        hidden.add(x);
        stack.push(...primKids(nodes, x));
      }
    }
  });
  const vis = new Set<string>();
  Object.values(nodes).forEach((n) => {
    if (!hidden.has(n.id)) vis.add(n.id);
  });
  return vis;
}

// Focus is a pure tree filter over primary layout links. Null, empty, or stale
// ids mean no focus, so callers can clear stale UI state without hiding the map.
export function focusVisible(
  nodes: Record<string, MNode>,
  id: string | null | undefined
): Set<string> {
  const all = new Set(Object.keys(nodes));
  if (!id || !nodes[id]) return all;

  const vis = new Set<string>();
  const seenAncestors = new Set<string>();
  let current: string | null = id;
  while (current && nodes[current] && !seenAncestors.has(current)) {
    vis.add(current);
    seenAncestors.add(current);
    current = nodes[current].primaryParent;
  }

  const stack = [...primKids(nodes, id)];
  while (stack.length) {
    const child = stack.pop()!;
    if (!nodes[child] || vis.has(child)) continue;
    vis.add(child);
    stack.push(...primKids(nodes, child));
  }

  return vis;
}

// nodes that share at least one parent with `id` (primary or secondary), excluding itself,
// ordered by level then layout/collection order so the dialog lists them predictably.
export function siblings(nodes: Record<string, MNode>, id: string): string[] {
  const self = nodes[id];
  if (!self) return [];
  const out = new Set<string>();
  self.parents.forEach((p) =>
    nodes[p]?.children.forEach((c) => {
      if (c !== id && nodes[c]) out.add(c);
    })
  );
  return [...out].sort(
    (a, b) =>
      nodes[a].levelIdx - nodes[b].levelIdx ||
      nodes[a].collIdx - nodes[b].collIdx ||
      a.localeCompare(b)
  );
}

// ---- ordering + layout ---------------------------------------------------

// DFS by primary parent so siblings stay contiguous, then place right->left so a
// parent centres on its visible primary children. Mutates x/y/w/h on each node.
export function orderAndLayout(
  cfg: MapCfg,
  nodes: Record<string, MNode>,
  byLevel: MNode[][],
  vis: Set<string>
): {
  order: string[][];
  levelX: number[];
  contentBottom: number;
  contentRight: number;
} {
  const visN = (id: string) => vis.has(id);
  const {
    cardW,
    colGap,
    vGap,
    top: TOP,
    titleLines,
    subLines,
  } = resolveLayout(cfg.layout);
  const floor = cfg.layout?.cardHeight ?? MIN_H;
  const levelX = cfg.levels.map((_, i) => 40 + i * (cardW + colGap));

  const order: string[][] = cfg.levels.map(() => []);
  const seen = new Set<string>();
  const childrenSorted = (n: MNode) =>
    primKids(nodes, n.id)
      .filter(visN)
      .map((id) => nodes[id])
      .sort((a, b) => a.collIdx - b.collIdx);
  const dfs = (n: MNode) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    order[n.levelIdx].push(n.id);
    childrenSorted(n).forEach(dfs);
  };
  byLevel[0].filter((n) => visN(n.id)).forEach(dfs);
  // any visible node not reached from a root (parent filtered/collapsed/secondary-only) — append to its level
  cfg.levels.forEach((_, li) =>
    byLevel[li].forEach((n) => {
      if (visN(n.id) && !seen.has(n.id)) {
        seen.add(n.id);
        order[li].push(n.id);
      }
    })
  );

  const cursor = cfg.levels.map(() => TOP);
  for (let li = cfg.levels.length - 1; li >= 0; li--) {
    for (const id of order[li]) {
      const n = nodes[id];
      const kids = primKids(nodes, id)
        .filter((c) => visN(c) && nodes[c].levelIdx === li + 1)
        .map((c) => nodes[c]);
      n.w = cardW;
      n.h = Math.max(floor, cardContentHeight(n, cardW, titleLines, subLines));
      n.x = levelX[li];
      if (kids.length) {
        const top = Math.min(...kids.map((k) => k.y!)),
          bot = Math.max(...kids.map((k) => k.y! + k.h!));
        n.y = Math.max(cursor[li], (top + bot) / 2 - n.h / 2);
      } else n.y = cursor[li];
      cursor[li] = n.y + n.h + vGap;
    }
  }
  const contentBottom = Math.max(TOP, ...cfg.levels.map((_, li) => cursor[li]));
  const contentRight = levelX[cfg.levels.length - 1] + cardW;
  return { order, levelX, contentBottom, contentRight };
}

export function filterOptions(
  nodes: Record<string, MNode>,
  cfg: MapCfg
): Record<string, string[]> {
  const all = Object.values(nodes);
  const options: Record<string, string[]> = {};
  (cfg.filter || []).forEach((prop) => {
    const seen = new Set<string>();
    all.forEach((n) => fieldArr(n.fm, prop).forEach((v) => seen.add(v)));
    options[prop] = [...seen].sort((a, b) => a.localeCompare(b));
  });
  return options;
}

// ---- saved views ---------------------------------------------------------
// Pure list ops behind the views toolbar. The adapter owns the name prompt and
// writing `views:` back into the code block; here we just decide the next list.

// "Save current as…": replace a same-named view in place, otherwise append.
export const upsertView = (
  views: SavedViewCfg[],
  view: SavedViewCfg
): SavedViewCfg[] => {
  const i = views.findIndex((v) => v.name === view.name);
  return i >= 0 ? views.map((v, j) => (j === i ? view : v)) : [...views, view];
};

// guard rename collisions: is `name` used by a view other than `exceptName`?
export const viewNameTaken = (
  views: SavedViewCfg[],
  name: string,
  exceptName?: string
): boolean => views.some((v) => v.name === name && v.name !== exceptName);

// The saved view to restore on (re)render, or null if activeView is unset or
// names a deleted view (stale guard). In-memory active state is gone after an
// Obsidian reload, so this is what keeps the picked view selected.
export const initialView = (cfg: MapCfg): SavedViewCfg | null =>
  (cfg.activeView && cfg.views?.find((v) => v.name === cfg.activeView)) || null;

// ---- search --------------------------------------------------------------

// case-insensitive match across title + sub + meta; empty term matches everything
export const searchMatch = (n: MNode, term: string): boolean =>
  (n.title + " " + n.sub + " " + n.meta)
    .toLowerCase()
    .includes(term.toLowerCase());

// ---- export --------------------------------------------------------------

// HTML export destination: sibling of the note, ".md" swapped for " mindmap.html".
// ponytail: multiple mindmap blocks in one note share this path; later exports overwrite.
export const mindmapExportPath = (notePath: string): string =>
  notePath.replace(/\.md$/i, "") + " mindmap.html";

// ---- Excalidraw export ---------------------------------------------------

// Minimal geometry the builder needs; both adapters already have it.
export interface ExNode {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  text: string;
}
export interface ExEdge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  // node indices into the nodes[] array; when both set the arrow binds to
  // those rectangles so dragging a node re-routes the arrow in Excalidraw.
  source?: number;
  target?: number;
}

// Pure data->data builder for an Excalidraw v2 file. Each node becomes a
// rounded rectangle with a bound (centered) text label; each edge a straight
// arrow. ids are deterministic (test-stable); seeds are constant (Excalidraw
// tolerates duplicates). v1 is lossy by design:
// ponytail: straight arrows (no bezier), no label pills / progress bars /
// column headers. Arrows bind to boxes when the edge carries source/target.
export const mapToExcalidraw = (
  nodes: ExNode[],
  edges: ExEdge[]
): {
  type: "excalidraw";
  version: 2;
  source: string;
  elements: Record<string, unknown>[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
} => {
  let n = 0;
  const id = () => "mm-" + n++;
  const base = (i: number) => ({
    angle: 0,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    seed: 1 + i,
    version: 1,
    versionNonce: 1 + i,
    isDeleted: false,
    updated: 1,
    link: null,
    locked: false,
  });

  const elements: Record<string, unknown>[] = [];
  // rect element per node index, so edges can bind to them after the fact.
  const rects: { id: string; boundElements: { type: string; id: string }[] }[] =
    [];
  nodes.forEach((node, i) => {
    const rectId = id();
    const textId = id();
    const boundElements: { type: string; id: string }[] = [
      { type: "text", id: textId },
    ];
    const rect = {
      ...base(i),
      id: rectId,
      type: "rectangle",
      x: node.x,
      y: node.y,
      width: node.w,
      height: node.h,
      strokeColor: node.color,
      roundness: { type: 3 },
      boundElements,
    };
    rects[i] = { id: rectId, boundElements };
    elements.push(rect);
    elements.push({
      ...base(i),
      id: textId,
      type: "text",
      x: node.x,
      y: node.y,
      width: node.w,
      height: node.h,
      strokeColor: "#1e1e1e",
      roundness: null,
      boundElements: [],
      text: node.text,
      originalText: node.text,
      fontSize: 16,
      fontFamily: 1,
      textAlign: "center",
      verticalAlign: "middle",
      lineHeight: 1.25,
      containerId: rectId,
    });
  });
  edges.forEach((e, i) => {
    const arrowId = id();
    const start = e.source != null ? rects[e.source] : undefined;
    const end = e.target != null ? rects[e.target] : undefined;
    // focus 0 (box center) + small gap; Excalidraw recomputes exact attach
    // points on load and on every drag.
    const bind = (r: typeof start) =>
      r ? { elementId: r.id, focus: 0, gap: 4 } : null;
    if (start) start.boundElements.push({ type: "arrow", id: arrowId });
    if (end) end.boundElements.push({ type: "arrow", id: arrowId });
    elements.push({
      ...base(nodes.length + i),
      id: arrowId,
      type: "arrow",
      x: e.x1,
      y: e.y1,
      width: e.x2 - e.x1,
      height: e.y2 - e.y1,
      strokeColor: e.color,
      roundness: { type: 2 },
      boundElements: [],
      points: [
        [0, 0],
        [e.x2 - e.x1, e.y2 - e.y1],
      ],
      lastCommittedPoint: null,
      startBinding: bind(start),
      endBinding: bind(end),
      startArrowhead: null,
      endArrowhead: "arrow",
    });
  });

  return {
    type: "excalidraw",
    version: 2,
    source: "markdown-mindmap",
    elements,
    appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
    files: {},
  };
};

// Excalidraw export destination: sibling of the note, ".md" -> ".excalidraw".
export const mindmapExcalidrawPath = (notePath: string): string =>
  notePath.replace(/\.md$/i, "") + " mindmap.excalidraw";
