// ============================================================================
// Notes Mindmap — pure logic, Obsidian-free.
// Everything here operates on plain data (NoteLike + a link Resolver) so it can
// be unit-tested without an Obsidian runtime. main.ts owns the DOM/SVG/Modal and
// just feeds these functions and draws what they return. Keep this side-effect free.
// ============================================================================

// flatuicolors.com/palette/defo — the original Flat UI palette
export const AUTO_COLORS = ["#1abc9c", "#3498db", "#9b59b6", "#e67e22", "#e74c3c", "#f1c40f", "#16a085", "#2980b9", "#8e44ad", "#d35400"];
// bar-chart category -> colour, with a sensible default for client/prospect/trial
export const CATEGORY_COLORS: Record<string, string> = { client: "#2ecc71", prospect: "#f39c12", trial: "#3498db", customer: "#2ecc71", prospect_: "#f39c12" };

// layout constants
export const CARD_W = 270, NODE_H = 80, V_GAP = 12, COL_GAP = 150, TOP = 64;

export interface CardCfg { title?: string; sub?: string; meta?: string[]; progress?: string; bars?: string; }
export interface LevelCfg { id: string; label?: string; from: string; color?: string; card?: CardCfg; where?: Record<string, any>; }
export interface EdgeCfg { from: string; to: string; via: string; reverse?: boolean; secondary?: boolean; }
export interface MapCfg { title?: string; height?: number; levels: LevelCfg[]; edges?: EdgeCfg[]; filter?: string[]; }

// the minimal note shape the pure logic needs (a TFile-free stand-in)
export interface NoteLike { path: string; basename: string; frontmatter: Record<string, any>; }
// wikilink key + the path it was found in -> resolved note path, or null
export interface Resolver { (key: string, fromPath: string): string | null; }

export interface MNode {
  id: string;          // file path (unique key)
  levelIdx: number;
  path: string;
  basename: string;
  fm: Record<string, any>;
  title: string;
  sub: string;
  meta: string;
  color: string;
  levelLabel: string;
  progress: number | null;       // 0-100, or null
  bars: [string, number][];      // category -> count
  collIdx: number;     // order within its source folder (layout tiebreak)
  parents: Set<string>;
  children: Set<string>;
  primaryParent: string | null;  // the one solid parent (secondary links don't set this)
  x?: number; y?: number; w?: number; h?: number;
}

// ---- helpers -------------------------------------------------------------

export const inFolder = (path: string, folder: string): boolean => {
  const f = folder.replace(/^\/+|\/+$/g, "");
  return f === "" ? true : path.startsWith(`${f}/`);
};

// "[[Note|alias]]" / "[[Note#hd]]" / "Title" -> the lookup key (Note / Title)
export const linkKey = (raw: any): string => {
  const s = String(raw ?? "").trim();
  const m = s.match(/\[\[([^\]|#]+)/);
  return (m ? m[1] : s).trim();
};

export const asArray = (v: any): any[] => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);

export const wrap = (s: string, width: number, size: number, max: number): string[] => {
  const cpl = Math.max(8, Math.floor(width / (size * 0.55)));
  const words = String(s).split(/\s+/), out: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > cpl) { out.push(cur); cur = w; }
    else cur = (cur + " " + w).trim();
  }
  if (cur) out.push(cur);
  return out.slice(0, max);
};

// dotted access so `via`/card fields can reach nested frontmatter (e.g. customFields.serves)
export const getPath = (fm: Record<string, any>, key?: string): any => {
  if (!fm || !key) return undefined;
  if (key.indexOf(".") < 0) return fm[key];
  return key.split(".").reduce((o: any, k) => (o == null ? o : o[k]), fm);
};

export const fieldStr = (fm: Record<string, any>, key?: string): string =>
  key ? asArray(getPath(fm, key)).map(linkKey).join(", ") : "";

export const fieldArr = (fm: Record<string, any>, key?: string): string[] =>
  key ? asArray(getPath(fm, key)).map(linkKey).filter(Boolean) : [];

// per-level include filter, e.g. { parentId: null } keeps only top-level roadmap tasks.
// a `null` target matches null, missing, OR empty (stringifies to "") — the strategy map relies on this.
export const matchesWhere = (fm: Record<string, any>, where?: Record<string, any>): boolean =>
  !where || Object.keys(where).every((k) =>
    where[k] === null ? fieldStr(fm, k) === "" : fieldStr(fm, k) === String(where[k]));

// list field -> [category, count]; category = text in trailing parens, else the value itself
export const countByCat = (fm: Record<string, any>, key?: string): [string, number][] => {
  if (!key) return [];
  const counts: Record<string, number> = {};
  asArray(getPath(fm, key)).forEach((raw) => {
    const s = String(raw).trim();
    if (!s) return;
    const m = s.match(/\(([^)]+)\)\s*$/);
    const cat = (m ? m[1] : s).trim().toLowerCase();
    counts[cat] = (counts[cat] || 0) + 1;
  });
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};

export const num = (v: any): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
};

export const catColor = (cat: string, i: number): string => CATEGORY_COLORS[cat] || AUTO_COLORS[i % AUTO_COLORS.length];

// children this node is the solid (primary) parent of — used by layout + collapse
export const primKids = (nodes: Record<string, MNode>, id: string): string[] =>
  [...nodes[id].children].filter((c) => nodes[c].primaryParent === id);

// throws the documented error when the map has no levels (the code-block processor catches it)
export function validateConfig(cfg: MapCfg | null | undefined): asserts cfg is MapCfg {
  if (!cfg || !Array.isArray(cfg.levels) || !cfg.levels.length)
    throw new Error("config needs a non-empty `levels:` list.");
}

// ---- node collection -----------------------------------------------------

// Folders -> columns. A note lands in its FIRST matching level only; `where`
// filters per level; card fields are extracted into the MNode.
export function collectNodes(cfg: MapCfg, notes: NoteLike[]): { nodes: Record<string, MNode>; byLevel: MNode[][] } {
  const nodes: Record<string, MNode> = {};
  const byLevel: MNode[][] = cfg.levels.map(() => []);
  cfg.levels.forEach((lvl, li) => {
    const color = lvl.color || AUTO_COLORS[li % AUTO_COLORS.length];
    const files = notes.filter((f) => inFolder(f.path, lvl.from)).sort((a, b) => a.path.localeCompare(b.path));
    files.forEach((file, ci) => {
      if (nodes[file.path]) return; // a note appears in its first matching level only
      const fm = file.frontmatter || {};
      if (!matchesWhere(fm, lvl.where)) return; // per-level frontmatter filter (e.g. {parentId: null})
      const card = lvl.card || {};
      const n: MNode = {
        id: file.path, levelIdx: li, path: file.path, basename: file.basename, fm, color, collIdx: ci,
        levelLabel: lvl.label || lvl.id,
        title: fieldStr(fm, card.title) || file.basename,
        sub: fieldStr(fm, card.sub),
        meta: (card.meta || []).map((k) => fieldStr(fm, k)).filter(Boolean).join("  ·  "),
        progress: num(getPath(fm, card.progress)),
        bars: countByCat(fm, card.bars),
        parents: new Set(), children: new Set(), primaryParent: null,
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
export function buildEdges(cfg: MapCfg, nodes: Record<string, MNode>, byLevel: MNode[][], resolveLink?: Resolver): Map<string, string> {
  // index each level by basename and by `title` frontmatter for link resolution
  const levelIndex = byLevel.map((arr) => {
    const byBase: Record<string, string> = {}, byTitle: Record<string, string> = {};
    arr.forEach((n) => { byBase[n.basename] = n.id; if (n.fm.title) byTitle[String(n.fm.title).trim()] = n.id; });
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
      if (!nodes[childId].primaryParent) nodes[childId].primaryParent = parentId;
    } else if (!edgeKind.has(key)) {
      edgeKind.set(key, "secondary");
    }
  };
  // resolution order: injected link resolver (e.g. Obsidian wikilink) -> basename -> `title`
  const resolveInLevel = (li: number, raw: any, sourcePath: string): string | null => {
    const key = linkKey(raw);
    const dest = resolveLink ? resolveLink(key, sourcePath) : null;
    if (dest && nodes[dest] && nodes[dest].levelIdx === li) return dest;
    return levelIndex[li].byBase[key] || levelIndex[li].byTitle[key] || null;
  };
  (cfg.edges || []).forEach((e) => {
    const fi = levelByIdNum[e.from], ti = levelByIdNum[e.to];
    if (fi == null || ti == null) return;
    if (!e.reverse) {
      // `via` is a property on the `to` notes pointing up to a `from` note
      byLevel[ti].forEach((to) => asArray(getPath(to.fm, e.via)).forEach((raw) => {
        const fromId = resolveInLevel(fi, raw, to.path);
        if (fromId) link(fromId, to.id, e.secondary);
      }));
    } else {
      // `via` is a property on the `from` notes pointing down to `to` notes
      byLevel[fi].forEach((from) => asArray(getPath(from.fm, e.via)).forEach((raw) => {
        const toId = resolveInLevel(ti, raw, from.path);
        if (toId) link(from.id, toId, e.secondary);
      }));
    }
  });
  return edgeKind;
}

export const isSecondary = (edgeKind: Map<string, string>, p: string, c: string): boolean =>
  edgeKind.get(p + "|" + c) === "secondary";

// ---- visibility (filters + collapse) -------------------------------------

// a filter only constrains nodes that HAVE the property; multi-select is OR within a property, AND across
export const passesFilters = (n: MNode, filters: Record<string, Set<string>>, cfg: MapCfg): boolean =>
  (cfg.filter || []).every((p) => {
    const sel = filters[p]; if (!sel || !sel.size) return true;
    const own = fieldArr(n.fm, p); if (!own.length) return true;
    return own.some((v) => sel.has(v));
  });

// collapsed nodes hide their primary subtree (keep self); filtered-out nodes hide self + primary subtree
export function computeVisible(nodes: Record<string, MNode>, collapsed: Set<string>, filters: Record<string, Set<string>>, cfg: MapCfg): Set<string> {
  const excluded = new Set<string>();
  Object.values(nodes).forEach((n) => { if (!passesFilters(n, filters, cfg)) excluded.add(n.id); });
  const hidden = new Set<string>(excluded);
  [...collapsed, ...excluded].forEach((rid) => {
    if (!nodes[rid]) return;
    const stack = [...primKids(nodes, rid)];
    while (stack.length) { const x = stack.pop()!; if (!hidden.has(x)) { hidden.add(x); stack.push(...primKids(nodes, x)); } }
  });
  const vis = new Set<string>();
  Object.values(nodes).forEach((n) => { if (!hidden.has(n.id)) vis.add(n.id); });
  return vis;
}

// ---- ordering + layout ---------------------------------------------------

// DFS by primary parent so siblings stay contiguous, then place right->left so a
// parent centres on its visible primary children. Mutates x/y/w/h on each node.
export function orderAndLayout(
  cfg: MapCfg, nodes: Record<string, MNode>, byLevel: MNode[][], vis: Set<string>,
): { order: string[][]; levelX: number[]; contentBottom: number; contentRight: number } {
  const visN = (id: string) => vis.has(id);
  const levelX = cfg.levels.map((_, i) => 40 + i * (CARD_W + COL_GAP));

  const order: string[][] = cfg.levels.map(() => []);
  const seen = new Set<string>();
  const childrenSorted = (n: MNode) => primKids(nodes, n.id).filter(visN).map((id) => nodes[id]).sort((a, b) => a.collIdx - b.collIdx);
  const dfs = (n: MNode) => {
    if (seen.has(n.id)) return; seen.add(n.id);
    order[n.levelIdx].push(n.id);
    childrenSorted(n).forEach(dfs);
  };
  byLevel[0].filter((n) => visN(n.id)).forEach(dfs);
  // any visible node not reached from a root (parent filtered/collapsed/secondary-only) — append to its level
  cfg.levels.forEach((_, li) => byLevel[li].forEach((n) => { if (visN(n.id) && !seen.has(n.id)) { seen.add(n.id); order[li].push(n.id); } }));

  const cursor = cfg.levels.map(() => TOP);
  for (let li = cfg.levels.length - 1; li >= 0; li--) {
    for (const id of order[li]) {
      const n = nodes[id];
      const kids = primKids(nodes, id).filter((c) => visN(c) && nodes[c].levelIdx === li + 1).map((c) => nodes[c]);
      n.w = CARD_W; n.h = NODE_H; n.x = levelX[li];
      if (kids.length) {
        const top = Math.min(...kids.map((k) => k.y!)), bot = Math.max(...kids.map((k) => k.y! + k.h!));
        n.y = Math.max(cursor[li], (top + bot) / 2 - NODE_H / 2);
      } else n.y = cursor[li];
      cursor[li] = n.y + NODE_H + V_GAP;
    }
  }
  const contentBottom = Math.max(TOP, ...cfg.levels.map((_, li) => cursor[li]));
  const contentRight = levelX[cfg.levels.length - 1] + CARD_W;
  return { order, levelX, contentBottom, contentRight };
}

// ---- search --------------------------------------------------------------

// case-insensitive match across title + sub + meta; empty term matches everything
export const searchMatch = (n: MNode, term: string): boolean =>
  (n.title + " " + n.sub + " " + n.meta).toLowerCase().includes(term.toLowerCase());
