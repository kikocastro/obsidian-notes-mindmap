import {
  App,
  Component,
  MarkdownPostProcessorContext,
  MarkdownRenderer,
  Modal,
  Plugin,
  TFile,
  parseYaml,
  stringifyYaml,
} from "obsidian";
import {
  AUTO_COLORS,
  MapCfg,
  MNode,
  NoteLike,
  Resolver,
  SavedViewCfg,
  collectNodes,
  buildEdges,
  isSecondary,
  siblings,
  filterOptions,
  focusVisible,
  resolveLayout,
  computeVisible,
  orderAndLayout,
  searchMatch,
  wrap,
  validateConfig,
} from "../graph";

// ============================================================================
// Markdown Mindmap — render a leveled left->right tree from note frontmatter links.
// One ```mindmap code block = one map. Config is inline YAML (see README).
// Pure logic lives in src/graph.ts; this file owns the SVG/DOM and the Modal.
// ============================================================================

const NS = "http://www.w3.org/2000/svg";

// a neighbour (parent/child/sibling), resolved for the note dialog's "Linked" section
interface LinkRow {
  id: string;
  title: string;
  levelLabel: string;
  color: string;
  secondary: boolean;
  relation: "parent" | "child" | "sibling";
}

export default class NotesMindmapPlugin extends Plugin {
  override async onload() {
    this.registerMarkdownCodeBlockProcessor("mindmap", (source, el, ctx) => {
      try {
        renderMindmap(this.app, this, source, el, ctx);
      } catch (e: any) {
        el.createEl("pre", {
          text: "Markdown Mindmap error:\n" + (e?.message || String(e)),
        });
      }
    });
  }
}

// ---- helpers -------------------------------------------------------------

const svgEl = (
  tag: string,
  attrs: Record<string, any>,
  parent: Element
): SVGElement => {
  const e = document.createElementNS(NS, tag) as SVGElement;
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  parent.appendChild(e);
  return e;
};

// ---- core ----------------------------------------------------------------

function renderMindmap(
  app: App,
  plugin: Plugin,
  source: string,
  host: HTMLElement,
  ctx: MarkdownPostProcessorContext
) {
  const cfg = parseYaml(source) as MapCfg;
  validateConfig(cfg);
  const titleLines = resolveLayout(cfg.layout).titleLines; // node-title lines before truncation

  // adapt the vault to the pure layer: plain NoteLike data + a TFile lookup for the modal
  const fileByPath: Record<string, TFile> = {};
  const notes: NoteLike[] = app.vault.getMarkdownFiles().map((f) => {
    fileByPath[f.path] = f;
    return {
      path: f.path,
      basename: f.basename,
      frontmatter: app.metadataCache.getFileCache(f)?.frontmatter || {},
    };
  });
  const resolveLink: Resolver = (key, fromPath) =>
    app.metadataCache.getFirstLinkpathDest(key, fromPath)?.path ?? null;

  // 1) collect nodes per level, 2) build edges (primary/secondary)
  const { nodes, byLevel } = collectNodes(cfg, notes);
  const edgeKind = buildEdges(cfg, nodes, byLevel, resolveLink);

  // ---- per-instance view state ----
  const collapsed = new Set<string>();
  const filters: Record<string, Set<string>> = {}; // prop -> selected values (empty = all)
  (cfg.filter || []).forEach((p) => (filters[p] = new Set()));
  let savedViews: SavedViewCfg[] = [...(cfg.views || [])];
  let selectedView = "";
  let searchTerm = "";
  const view = { x: 20, y: 8, k: 1 };
  let selected: string | null = null;
  let focused: string | null = null;

  // One initial layout pass gives filterOptions real x/y positions for toolbar order.
  orderAndLayout(
    cfg,
    nodes,
    byLevel,
    computeVisible(nodes, collapsed, filters, cfg)
  );
  const optionsByProp = filterOptions(nodes, cfg);
  const chipByPropValue: Record<string, Record<string, HTMLButtonElement>> = {};

  // ---- DOM scaffold ----
  host.empty();
  const wrapEl = host.createDiv({ cls: "mm-wrap" });
  if (cfg.height) wrapEl.style.height = cfg.height + "px";
  const toolbar = wrapEl.createDiv({ cls: "mm-toolbar" });
  if (cfg.title) toolbar.createSpan({ cls: "mm-title", text: cfg.title });

  // search box (Miro-style: highlights matching cards, dims the rest)
  const search = toolbar.createEl("input", {
    cls: "mm-search",
    attr: { type: "search", placeholder: "Search…" },
  });
  search.oninput = () => {
    searchTerm = search.value.trim().toLowerCase();
    reapply();
  };
  let viewSelect: HTMLSelectElement | null = null;
  let editViewBtn: HTMLButtonElement | null = null;
  let deleteViewBtn: HTMLButtonElement | null = null;

  // multiselect filters: one toggle-chip group per property (OR within a group, AND across groups)
  (cfg.filter || []).forEach((prop) => {
    const values = optionsByProp[prop] || [];
    if (!values.length) return;
    chipByPropValue[prop] = {};
    const grp = toolbar.createDiv({ cls: "mm-fltgroup" });
    grp.createSpan({
      cls: "mm-fltlabel",
      text: cfg.filterLabels?.[prop] ?? prop,
    });
    values.forEach((v) => {
      const chip = grp.createEl("button", { cls: "mm-chip", text: v });
      chipByPropValue[prop][v] = chip;
      chip.onclick = () => {
        if (filters[prop].has(v)) {
          filters[prop].delete(v);
          chip.removeClass("on");
        } else {
          filters[prop].add(v);
          chip.addClass("on");
        }
        selectedView = "";
        syncViewControls();
        draw();
        fit();
      };
    });
  });

  if ((cfg.filter || []).length) {
    const views = toolbar.createDiv({ cls: "mm-viewgroup" });
    viewSelect = views.createEl("select", { cls: "mm-viewselect" });
    viewSelect.onchange = () => {
      selectedView = viewSelect?.value || "";
      const saved = savedViews.find((v) => v.name === selectedView);
      if (saved) applyFilterSnapshot(saved.filters || {});
      else syncViewControls();
    };
    const saveView = views.createEl("button", { text: "Save current as…" });
    saveView.onclick = () => {
      const name = window.prompt("Save current filters as view:");
      if (!name?.trim()) return;
      const cleanName = name.trim();
      const existing = savedViews.findIndex((v) => v.name === cleanName);
      if (
        existing >= 0 &&
        !window.confirm(`Replace the saved view "${cleanName}"?`)
      )
        return;
      const nextView = { name: cleanName, filters: currentFilterSnapshot() };
      const nextViews =
        existing >= 0
          ? savedViews.map((v, i) => (i === existing ? nextView : v))
          : [...savedViews, nextView];
      persistViews(nextViews)
        .then(() => {
          selectedView = cleanName;
          syncViewControls();
        })
        .catch(reportViewError);
    };
    editViewBtn = views.createEl("button", { text: "Edit" });
    editViewBtn.onclick = () => {
      const current = savedViews.find((v) => v.name === selectedView);
      if (!current) return;
      const name = window.prompt(
        "Rename this view and update it to current filters:",
        current.name
      );
      if (!name?.trim()) return;
      const cleanName = name.trim();
      const duplicate = savedViews.some(
        (v) => v.name === cleanName && v.name !== current.name
      );
      if (duplicate) {
        window.alert(`A saved view named "${cleanName}" already exists.`);
        return;
      }
      const nextViews = savedViews.map((v) =>
        v.name === current.name
          ? { name: cleanName, filters: currentFilterSnapshot() }
          : v
      );
      persistViews(nextViews)
        .then(() => {
          selectedView = cleanName;
          syncViewControls();
        })
        .catch(reportViewError);
    };
    deleteViewBtn = views.createEl("button", { text: "Delete" });
    deleteViewBtn.onclick = () => {
      const current = savedViews.find((v) => v.name === selectedView);
      if (
        !current ||
        !window.confirm(`Delete the saved view "${current.name}"?`)
      )
        return;
      persistViews(savedViews.filter((v) => v.name !== current.name))
        .then(() => {
          selectedView = "";
          syncViewControls();
        })
        .catch(reportViewError);
    };
    syncViewControls();
  }

  toolbar.createSpan({ cls: "mm-spacer" });
  const fsBtn = toolbar.createEl("button", {
    cls: "mm-icon",
    text: "⛶",
    attr: { title: "Fullscreen" },
  });
  fsBtn.onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else wrapEl.requestFullscreen();
  };
  plugin.registerDomEvent(document, "fullscreenchange", () =>
    requestAnimationFrame(fit)
  );

  function currentFilterSnapshot(): Record<string, string[]> {
    const snapshot: Record<string, string[]> = {};
    (cfg.filter || []).forEach((prop) => {
      const values = (optionsByProp[prop] || []).filter((v) =>
        filters[prop]?.has(v)
      );
      if (values.length) snapshot[prop] = values;
    });
    return snapshot;
  }

  function updateFilterChips() {
    Object.entries(chipByPropValue).forEach(([prop, chips]) => {
      Object.entries(chips).forEach(([value, chip]) => {
        chip.toggleClass("on", filters[prop]?.has(value) || false);
      });
    });
  }

  function applyFilterSnapshot(snapshot: Record<string, string[]>) {
    (cfg.filter || []).forEach((prop) => filters[prop].clear());
    Object.entries(snapshot).forEach(([prop, values]) => {
      if (!filters[prop]) return;
      values.forEach((value) => filters[prop].add(value));
    });
    updateFilterChips();
    syncViewControls();
    draw();
    fit();
  }

  function syncViewControls() {
    if (!viewSelect) return;
    viewSelect.empty();
    const placeholder = viewSelect.createEl("option", { text: "Views" });
    placeholder.value = "";
    savedViews.forEach((viewCfg) => {
      const opt = viewSelect!.createEl("option", { text: viewCfg.name });
      opt.value = viewCfg.name;
    });
    viewSelect.value = selectedView;
    const hasSelection = savedViews.some((v) => v.name === selectedView);
    if (editViewBtn) editViewBtn.disabled = !hasSelection;
    if (deleteViewBtn) deleteViewBtn.disabled = !hasSelection;
  }

  function mindmapBlockRange(lines: string[]) {
    const section = ctx.getSectionInfo(host);
    if (!section) return null;
    let start = section.lineStart;
    while (start > 0 && !/^```mindmap\b/.test(lines[start])) start--;
    if (!/^```mindmap\b/.test(lines[start])) return null;
    let end = start + 1;
    while (end < lines.length && !/^```\s*$/.test(lines[end])) end++;
    return end < lines.length ? { start, end } : null;
  }

  async function persistViews(nextViews: SavedViewCfg[]) {
    const file = app.vault.getAbstractFileByPath(ctx.sourcePath);
    if (!(file instanceof TFile))
      throw new Error("Could not find the note that owns this mindmap block.");
    const raw = await app.vault.read(file);
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    const lines = raw.split(/\r?\n/);
    const range = mindmapBlockRange(lines);
    if (!range)
      throw new Error("Could not locate the source ```mindmap code block.");

    const nextCfg: MapCfg = { ...cfg };
    if (nextViews.length) nextCfg.views = nextViews;
    else delete nextCfg.views;
    const nextBlock = ["```mindmap", stringifyYaml(nextCfg).trimEnd(), "```"];
    lines.splice(range.start, range.end - range.start + 1, ...nextBlock);
    await app.vault.modify(file, lines.join(eol));
    savedViews = nextViews;
    cfg.views = nextViews.length ? nextViews : undefined;
  }

  function reportViewError(e: unknown) {
    window.alert(
      "Could not update mindmap views:\n" +
        (e instanceof Error ? e.message : String(e))
    );
  }

  const resetBtn = toolbar.createEl("button", { text: "Reset" });
  resetBtn.onclick = () => {
    collapsed.clear();
    selected = null;
    focused = null;
    selectedView = "";
    searchTerm = "";
    search.value = "";
    (cfg.filter || []).forEach((p) => filters[p].clear());
    updateFilterChips();
    syncViewControls();
    draw();
    fit();
  };

  const stage = wrapEl.createDiv({ cls: "mm-stage" });
  const svg = svgEl("svg", {}, stage) as SVGSVGElement;
  const rootG = svgEl("g", {}, svg);

  // ---- adjacency for hover-highlight (built from currently drawn edges) ----
  let upAdj: Record<string, Set<string>> = {},
    dnAdj: Record<string, Set<string>> = {};
  let links: { el: SVGElement; a: string; b: string }[] = [];
  let nodeEls: Record<string, SVGElement> = {};

  function highlight(id: string) {
    const keep = new Set([id]);
    const walk = (adj: Record<string, Set<string>>, start: string) => {
      const q = [start];
      while (q.length) {
        const n = q.shift()!;
        (adj[n] ? [...adj[n]] : []).forEach((m) => {
          if (!keep.has(m)) {
            keep.add(m);
            q.push(m);
          }
        });
      }
    };
    walk(upAdj, id);
    walk(dnAdj, id);
    links.forEach((lk) => {
      const hot = keep.has(lk.a) && keep.has(lk.b);
      lk.el.classList.toggle("mm-hot", hot);
      lk.el.classList.toggle("mm-dim", !hot);
    });
    Object.keys(nodeEls).forEach((n) => {
      nodeEls[n].classList.toggle("mm-dim", !keep.has(n));
      nodeEls[n].classList.remove("mm-hit");
    });
  }
  function applySearch() {
    Object.keys(nodeEls).forEach((id) => {
      const hit = searchMatch(nodes[id], searchTerm);
      nodeEls[id].classList.toggle("mm-hit", hit);
      nodeEls[id].classList.toggle("mm-dim", !hit);
    });
    links.forEach((lk) => {
      lk.el.classList.remove("mm-hot");
      lk.el.classList.add("mm-dim");
    });
  }
  function clearHi() {
    links.forEach((lk) => lk.el.classList.remove("mm-hot", "mm-dim"));
    Object.values(nodeEls).forEach((g) =>
      g.classList.remove("mm-dim", "mm-hit")
    );
  }
  // sticky overlay after any redraw / on mouseleave: search wins, then a selected node, else clear
  function reapply() {
    if (searchTerm) applySearch();
    else if (selected && nodeEls[selected]) highlight(selected);
    else clearHi();
  }

  // parents + children of a node, resolved for the dialog's "Linked" section
  function linksFor(n: MNode): LinkRow[] {
    const row = (id: string, relation: "parent" | "child"): LinkRow => {
      const o = nodes[id];
      const sec =
        relation === "parent"
          ? isSecondary(edgeKind, id, n.id)
          : isSecondary(edgeKind, n.id, id);
      return {
        id,
        title: o.title,
        levelLabel: o.levelLabel,
        color: o.color,
        secondary: sec,
        relation,
      };
    };
    const sibRow = (id: string): LinkRow => {
      const o = nodes[id];
      return {
        id,
        title: o.title,
        levelLabel: o.levelLabel,
        color: o.color,
        secondary: false,
        relation: "sibling",
      };
    };
    return [
      ...[...n.parents].map((p) => row(p, "parent")),
      ...siblings(nodes, n.id).map(sibRow),
      ...[...n.children].map((c) => row(c, "child")),
    ];
  }
  function openNode(id: string) {
    selected = id;
    reapply();
    const n = nodes[id];
    new NoteModal(
      app,
      n,
      linksFor(n),
      fileByPath[n.path],
      openNode,
      (focusId) => {
        focused = focusId;
        selected = null;
        draw();
        fit();
      },
      cfg.properties === true
    ).open();
  }

  // ---- layout + draw (re-runnable) ----
  let contentBottom = 64,
    contentRight = 0;
  function draw() {
    while (rootG.firstChild) rootG.removeChild(rootG.firstChild);
    links = [];
    nodeEls = {};
    upAdj = {};
    dnAdj = {};

    const baseVis = computeVisible(nodes, collapsed, filters, cfg);
    const focusVis = focusVisible(nodes, focused);
    const vis = focused
      ? new Set([...baseVis].filter((id) => focusVis.has(id)))
      : baseVis;
    const visN = (id: string) => vis.has(id);
    const {
      order,
      levelX,
      contentBottom: cb,
      contentRight: cr,
    } = orderAndLayout(cfg, nodes, byLevel, vis);
    contentBottom = cb;
    contentRight = cr;

    const linkLayer = svgEl("g", {}, rootG),
      nodeLayer = svgEl("g", {}, rootG);

    // column headers
    cfg.levels.forEach((lvl, li) => {
      if (lvl.label)
        svgEl(
          "text",
          { class: "mm-colhead", x: levelX[li], y: 36 },
          rootG
        ).textContent = lvl.label;
    });

    // edges (parent right-mid -> child left-mid); secondary links draw dashed + fainter
    Object.values(nodes).forEach((p) => {
      if (!visN(p.id)) return;
      [...p.children].filter(visN).forEach((cid) => {
        const c = nodes[cid];
        const sec = isSecondary(edgeKind, p.id, cid);
        const x1 = p.x! + p.w!,
          y1 = p.y! + p.h! / 2,
          x2 = c.x!,
          y2 = c.y! + c.h! / 2,
          mx = (x1 + x2) / 2;
        const path = svgEl(
          "path",
          {
            class: "mm-link" + (sec ? " mm-also" : ""),
            d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`,
            stroke: p.color,
            "stroke-width": 2.5,
          },
          linkLayer
        );
        links.push({ el: path, a: p.id, b: c.id });
        (dnAdj[p.id] = dnAdj[p.id] || new Set()).add(c.id);
        (upAdj[c.id] = upAdj[c.id] || new Set()).add(p.id);
      });
    });

    // nodes
    cfg.levels.forEach((_, li) =>
      order[li].forEach((id) => {
        const n = nodes[id];
        const hasKids = n.children.size > 0;
        const hasBar = n.progress != null || n.bars.length > 0;
        const g = svgEl("g", { class: "mm-node" }, nodeLayer);
        svgEl(
          "rect",
          {
            class: "mm-box",
            x: n.x,
            y: n.y,
            width: n.w,
            height: n.h,
            rx: 9,
            fill: "var(--background-secondary)",
            stroke: n.color,
          },
          g
        );

        // text block: padded from top/bottom, with bars/labels reserved at the bottom
        const padR = hasKids ? 42 : 16;
        const labelH = n.labels.length ? 24 : 0;
        const barH = hasBar ? 20 : 0;
        const textPadTop = 14;
        const textPadBottom = 14;
        const lines: { t: string; cls: string; size: number; lh: number }[] =
          [];
        let truncated = false;
        const titleWrapped = wrap(n.title, n.w! - 14 - padR, 12, titleLines);
        if (
          titleWrapped.join(" ").length <
          n.title.replace(/\s+/g, " ").trim().length
        )
          truncated = true;
        titleWrapped.forEach((t) =>
          lines.push({ t, cls: "mm-t1", size: 12, lh: 16 })
        );
        if (n.sub) {
          if (n.sub.length > 46) truncated = true;
          lines.push({
            t: n.sub.length > 46 ? n.sub.slice(0, 45) + "…" : n.sub,
            cls: "mm-t2",
            size: 10.5,
            lh: 15,
          });
        }
        if (n.meta)
          lines.push({ t: n.meta, cls: "mm-meta", size: 9.5, lh: 14 });
        const totalH = lines.reduce((s, b) => s + b.lh, 0);
        const firstSize = lines[0]?.size || 12;
        const textTop = n.y! + textPadTop;
        const textBottom = n.y! + n.h! - textPadBottom - barH - labelH;
        const freeH = Math.max(totalH, textBottom - textTop);
        let ty =
          hasBar || labelH
            ? textTop + firstSize
            : textTop + (freeH - totalH) / 2 + firstSize;
        lines.forEach((b) => {
          svgEl(
            "text",
            { class: b.cls, x: n.x! + 14, y: ty, "font-size": b.size },
            g
          ).textContent = b.t;
          ty += b.lh;
        });

        // native tooltip with the full text when title/subtitle was clipped
        if (truncated)
          svgEl("title", {}, g).textContent =
            n.title + (n.sub ? "\n" + n.sub : "");

        // bottom strip: progress/category bar first, then label pills last
        if (hasBar) drawBar(g, n);
        if (labelH) drawLabels(g, n);

        // collapse toggle in the top-right corner (clear of the right-edge link connector)
        if (hasKids) {
          const cx = n.x! + n.w! - 16,
            cy = n.y! + 15,
            isC = collapsed.has(n.id);
          // collapsed toggles get a distinct class + bigger circle so contracted subtrees stand out
          const tg = svgEl(
            "g",
            { class: "mm-toggle" + (isC ? " mm-collapsed" : "") },
            g
          );
          svgEl("circle", { cx, cy, r: isC ? 9 : 8 }, tg);
          svgEl("text", { x: cx, y: cy + 4 }, tg).textContent = isC ? "+" : "−";
          tg.addEventListener("click", (ev) => {
            ev.stopPropagation();
            if (isC) collapsed.delete(n.id);
            else collapsed.add(n.id);
            draw();
          });
        }

        g.addEventListener("mouseenter", () => {
          if (!searchTerm) highlight(n.id);
        });
        g.addEventListener("mouseleave", reapply);
        g.addEventListener("click", (ev) => {
          ev.stopPropagation();
          openNode(n.id);
        });
        nodeEls[n.id] = g;
      })
    );

    apply();
    reapply();
  }

  // small value pills along the card's bottom strip; drops any that don't fit on one row
  function drawLabels(g: SVGElement, n: MNode) {
    const top = n.y! + n.h! - 20,
      h = 15,
      size = 9,
      pad = 11;
    const maxX = n.x! + n.w! - 12;
    let bx = n.x! + 12;
    for (let i = 0; i < n.labels.length; i++) {
      const t = n.labels[i];
      // ponytail: width estimated from char count — SVG has no cheap text metrics, fine for short labels
      const w = Math.ceil(t.length * size * 0.62) + pad * 2;
      if (bx + w > maxX) break;
      const color = n.labelColors[i] || AUTO_COLORS[i % AUTO_COLORS.length];
      svgEl(
        "rect",
        {
          class: "mm-label",
          x: bx,
          y: top,
          width: w,
          height: h,
          rx: 7,
          fill: color,
          "fill-opacity": 0.14,
          stroke: color,
        },
        g
      );
      svgEl(
        "text",
        {
          class: "mm-label-t",
          x: bx + w / 2,
          y: top + 11,
          "font-size": size,
          fill: color,
        },
        g
      ).textContent = t;
      bx += w + 5;
    }
  }

  // progress bar (0-100) and/or stacked category bar, pinned to the card's lower strip
  function drawBar(g: SVGElement, n: MNode) {
    const x = n.x! + 14,
      w = n.w! - 28,
      y = n.y! + n.h! - (n.labels.length ? 38 : 14);
    if (n.progress != null) {
      const p = Math.max(0, Math.min(100, n.progress));
      svgEl("rect", { class: "mm-track", x, y, width: w, height: 6, rx: 3 }, g);
      svgEl(
        "rect",
        { x, y, width: (w * p) / 100, height: 6, rx: 3, fill: n.color },
        g
      );
      svgEl(
        "text",
        { class: "mm-barlbl", x: x + w, y: y - 3, "text-anchor": "end" },
        g
      ).textContent = p + "%";
    } else if (n.bars.length) {
      const total = n.bars.reduce((s, [, c]) => s + c, 0) || 1;
      let bx = x;
      n.bars.forEach(([cat, c, color]) => {
        const seg = (w * c) / total;
        const r = svgEl(
          "rect",
          {
            x: bx,
            y,
            width: Math.max(0, seg - 1.5),
            height: 7,
            rx: 2,
            fill: color,
          },
          g
        );
        svgEl("title", {}, r).textContent = `${c} ${cat}`;
        bx += seg;
      });
      svgEl(
        "text",
        { class: "mm-barlbl", x: x + w, y: y - 3, "text-anchor": "end" },
        g
      ).textContent = String(total);
    }
  }

  // ---- pan / zoom / fit ----
  const apply = () =>
    rootG.setAttribute(
      "transform",
      `translate(${view.x},${view.y}) scale(${view.k})`
    );
  function fit() {
    const w = svg.clientWidth || wrapEl.clientWidth,
      h = svg.clientHeight || 600;
    view.k =
      Math.min(w / (contentRight + 40), h / (contentBottom + 40), 1.4) || 1;
    view.x = 20;
    view.y = 8;
    apply();
  }
  let drag: { x: number; y: number } | null = null;
  stage.addEventListener("mousedown", (e) => {
    drag = { x: e.clientX - view.x, y: e.clientY - view.y };
    stage.classList.add("mm-drag");
  });
  plugin.registerDomEvent(window, "mousemove", (e: MouseEvent) => {
    if (drag) {
      view.x = e.clientX - drag.x;
      view.y = e.clientY - drag.y;
      apply();
    }
  });
  plugin.registerDomEvent(window, "mouseup", () => {
    drag = null;
    stage.classList.remove("mm-drag");
  });
  stage.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const step = Math.min(0.06, Math.abs(e.deltaY) * 0.0009),
        f = e.deltaY < 0 ? 1 + step : 1 / (1 + step);
      const nk = Math.max(0.2, Math.min(3, view.k * f)),
        r = nk / view.k;
      const rect = stage.getBoundingClientRect(),
        px = e.clientX - rect.left,
        py = e.clientY - rect.top;
      view.x = px - (px - view.x) * r;
      view.y = py - (py - view.y) * r;
      view.k = nk;
      apply();
    },
    { passive: false }
  );
  stage.addEventListener("click", () => {
    const hadFocus = focused != null;
    focused = null;
    selected = null;
    if (hadFocus) {
      draw();
      fit();
    } else reapply();
  });

  draw();
  // first fit after the element has real dimensions
  requestAnimationFrame(fit);
}

// ---- note dialog ---------------------------------------------------------

class NoteModal extends Modal {
  private comp = new Component();
  constructor(
    app: App,
    private node: MNode,
    private links: LinkRow[],
    private file: TFile,
    private nav: (id: string) => void,
    private focus: (id: string) => void,
    private showProperties: boolean
  ) {
    super(app);
  }

  override async onOpen() {
    this.comp.load();
    const { contentEl, modalEl } = this;
    // ponytail: in fullscreen the modal mounts on document.body, which the fullscreen layer hides;
    // re-home its container inside the fullscreen element so the dialog is actually visible.
    if (document.fullscreenElement)
      document.fullscreenElement.appendChild(this.containerEl);
    modalEl.addClass("mm-modal");
    contentEl.empty();
    const n = this.node;

    // header: title, level badge, sub/meta, progress/demand breakdown
    const head = contentEl.createDiv({ cls: "mm-note-head" });
    head.style.setProperty("--mm-accent", n.color);
    const badges = head.createDiv({ cls: "mm-note-badges" });
    badges.createSpan({ cls: "mm-badge", text: n.levelLabel });
    if (n.progress != null)
      badges.createSpan({
        cls: "mm-badge",
        text: `progress ${Math.round(n.progress)}%`,
      });
    head.createEl("h2", { cls: "mm-note-title", text: n.title });
    // the underlying note's file name, when the card title is an alias for it
    if (n.basename && n.basename !== n.title)
      head.createDiv({ cls: "mm-note-file", text: n.basename });
    if (n.sub) head.createDiv({ cls: "mm-note-sub", text: n.sub });
    if (n.meta) head.createDiv({ cls: "mm-note-meta", text: n.meta });
    if (n.bars.length) {
      const br = head.createDiv({ cls: "mm-note-bars" });
      n.bars.forEach(([cat, c, color]) => {
        const pill = br.createSpan({
          cls: "mm-note-pill",
          text: `${c} ${cat}`,
        });
        pill.style.setProperty("--mm-cat", color);
      });
    }

    const actions = head.createDiv({ cls: "mm-note-actions" });
    const open = actions.createEl("button", {
      cls: "mm-note-open",
      text: "Open note ↗",
    });
    open.onclick = () => {
      this.app.workspace.getLeaf("tab").openFile(this.file);
      this.close();
    };
    const focus = actions.createEl("button", {
      cls: "mm-note-focus",
      text: "Focus",
    });
    focus.onclick = () => {
      this.focus(n.id);
      this.close();
    };

    // linked nodes: parents and children, click to jump the dialog to that note
    this.renderLinks(contentEl);
    if (this.showProperties) this.renderProperties(contentEl);

    const body = contentEl.createDiv({ cls: "mm-note markdown-rendered" });
    const content = await this.app.vault.cachedRead(this.file);
    await MarkdownRenderer.render(
      this.app,
      content,
      body,
      this.file.path,
      this.comp
    );
  }

  private renderProperties(contentEl: HTMLElement) {
    const entries = Object.entries(this.node.fm || {});
    if (!entries.length) return;
    const wrapEl = contentEl.createDiv({ cls: "mm-note-props" });
    wrapEl.createDiv({ cls: "mm-note-props-title", text: "Properties" });
    const table = wrapEl.createEl("table");
    const tbody = table.createEl("tbody");
    entries.forEach(([key, value]) => {
      const row = tbody.createEl("tr");
      row.createEl("th", { text: key });
      row.createEl("td", { text: this.formatPropertyValue(value) });
    });
  }

  private formatPropertyValue(value: unknown): string {
    if (Array.isArray(value))
      return value.map((v) => this.formatPropertyValue(v)).join(", ");
    if (value && typeof value === "object") {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }
    if (value == null || value === "") return "—";
    return String(value);
  }

  private renderLinks(contentEl: HTMLElement) {
    if (!this.links.length) return;
    const wrapEl = contentEl.createDiv({ cls: "mm-note-links" });
    (
      [
        ["Parents", "parent"],
        ["Siblings", "sibling"],
        ["Children", "child"],
      ] as const
    ).forEach(([label, rel]) => {
      const rows = this.links.filter((l) => l.relation === rel);
      if (!rows.length) return;
      const grp = wrapEl.createDiv({ cls: "mm-note-linkgroup" });
      grp.createDiv({
        cls: "mm-note-linklabel",
        text: `${label} (${rows.length})`,
      });
      rows.forEach((l) => {
        const btn = grp.createEl("button", {
          cls: "mm-link-row" + (l.secondary ? " mm-link-sec" : ""),
        });
        btn.style.setProperty("--mm-accent", l.color);
        btn.createSpan({ cls: "mm-link-lvl", text: l.levelLabel });
        btn.createSpan({ cls: "mm-link-title", text: l.title });
        if (l.secondary) btn.createSpan({ cls: "mm-link-tag", text: "also" });
        btn.onclick = () => {
          this.close();
          this.nav(l.id);
        };
      });
    });
  }

  override onClose() {
    this.comp.unload();
    this.contentEl.empty();
  }
}
