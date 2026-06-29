import {
  App,
  MarkdownPostProcessorContext,
  Notice,
  Plugin,
  TFile,
  parseYaml,
  stringifyYaml,
} from "obsidian";
import { svgEl } from "./svg";
import {
  LinkRow,
  HelpModal,
  NoteModal,
  promptText,
  confirmModal,
} from "./modals";
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
  upsertView,
  viewNameTaken,
  initialView,
  wrap,
  subWidth,
  validateConfig,
  mindmapExportPath,
  mindmapExcalidrawPath,
  mapToExcalidraw,
} from "../graph";

// ============================================================================
// Markdown Mindmap — render a leveled left->right tree from note frontmatter links.
// One ```mindmap code block = one map. Config is inline YAML (see README).
// Pure logic lives in src/graph.ts; SVG/DOM helpers in ./svg, Modals in ./modals.
// ============================================================================

export default class NotesMindmapPlugin extends Plugin {
  override async onload() {
    this.registerMarkdownCodeBlockProcessor("mindmap", (source, el, ctx) => {
      try {
        renderMindmap(this.app, this, source, el, ctx);
      } catch (e) {
        const msg = e instanceof Error ? e.message : JSON.stringify(e);
        el.createEl("pre", {
          text: "Markdown Mindmap error:\n" + msg,
        });
        el.createEl("button", { text: "Mindmap help" }).onclick = () =>
          new HelpModal(this.app).open();
      }
    });
  }
}

// ---- core ----------------------------------------------------------------

// The active view + filter selection, so a save keeps its filters applied (the persist
// re-render would otherwise reset them) and returning to a note reopens its last view.
// ponytail: in-memory, keyed by sourcePath; resets on Obsidian restart, collides if a note
// has two mindmap blocks. Persist to plugin data if either bites.
const activeState = new Map<
  string,
  { view: string; filters: Record<string, string[]> }
>();

function renderMindmap(
  app: App,
  plugin: Plugin,
  source: string,
  host: HTMLElement,
  ctx: MarkdownPostProcessorContext
) {
  const cfg = parseYaml(source) as MapCfg;
  validateConfig(cfg);
  const { titleLines, subLines } = resolveLayout(cfg.layout); // lines shown before truncation

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
  // hide sub/meta/bars/labels on cards, show only the title.
  // ponytail: card heights come from orderAndLayout (core), which still reserves the label
  // strip, so label-bearing cards stay 24px taller in this mode. Recompute layout per-toggle if it bugs you.
  let titleOnly = false;
  // a note-write while fullscreen makes Obsidian re-render the block and tear down the
  // fullscreen element, so we stash the latest cfg here and flush it on fullscreen exit.
  let pendingWrite: MapCfg | null = null;

  const optionsByProp = filterOptions(nodes, cfg);
  const chipByPropValue: Record<string, Record<string, HTMLButtonElement>> = {};

  // ---- DOM scaffold ----
  host.empty();
  const wrapEl = host.createDiv({ cls: "mm-wrap" });
  if (cfg.height) wrapEl.setCssStyles({ height: cfg.height + "px" });
  const toolbar = wrapEl.createDiv({ cls: "mm-toolbar" });
  // header row: title left, collapse control right. The whole rail collapses to just
  // this header (see .mm-bar-collapsed), so the toggle lives inside it.
  const head = toolbar.createDiv({ cls: "mm-head" });
  if (cfg.title) head.createSpan({ cls: "mm-title", text: cfg.title });
  const barToggle = head.createEl("button", {
    cls: "mm-icon mm-bartoggle",
    text: "«",
    attr: { title: "Collapse sidebar" },
  });
  barToggle.onclick = () => {
    const collapsedBar = toolbar.classList.toggle("mm-bar-collapsed");
    barToggle.setText(collapsedBar ? "☰" : "«");
    barToggle.setAttr(
      "title",
      collapsedBar ? "Expand sidebar" : "Collapse sidebar"
    );
    fit();
  };

  // search box (Miro-style: highlights matching cards, dims the rest)
  const search = toolbar.createEl("input", {
    cls: "mm-search",
    attr: { type: "search", placeholder: "Search…" },
  });
  search.oninput = () => {
    searchTerm = search.value.trim().toLowerCase();
    reapply();
  };

  // focus banner: a dismissible chip at the top of the rail showing the active focus.
  // Focus persists (panning/clicking no longer drops it); only the ✕ clears it.
  const focusTicket = toolbar.createEl("button", {
    cls: "mm-focus-ticket mm-hidden",
    attr: { title: "Clear focus" },
  });
  const focusLabel = focusTicket.createSpan({ cls: "mm-focus-label" });
  focusTicket.createSpan({ cls: "mm-focus-x", text: "✕" });
  focusTicket.onclick = () => setFocus(null);

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
    views.createSpan({ cls: "mm-fltlabel", text: "Saved views" });
    viewSelect = views.createEl("select", { cls: "mm-viewselect" });
    viewSelect.onchange = () => {
      selectedView = viewSelect?.value || "";
      const saved = savedViews.find((v) => v.name === selectedView);
      if (saved) applyFilterSnapshot(saved.filters || {});
      else syncViewControls();
      persistActiveView(selectedView).catch(reportViewError);
    };
    const saveView = views.createEl("button", {
      cls: "mm-viewsave",
      text: "Save current as…",
    });
    saveView.onclick = async () => {
      // Electron has no window.prompt, so a Modal is the only way to read a name.
      const name = await promptText(
        app,
        "Save current filters as a view",
        defaultViewName()
      );
      if (!name?.trim()) return;
      const cleanName = name.trim();
      if (
        viewNameTaken(savedViews, cleanName) &&
        !(await confirmModal(app, `Replace the saved view "${cleanName}"?`))
      )
        return;
      const nextViews = upsertView(savedViews, {
        name: cleanName,
        filters: currentFilterSnapshot(),
      });
      try {
        await persistViews(nextViews);
        selectedView = cleanName;
        rememberActive(); // keep this view active across the persist re-render
        syncViewControls();
      } catch (e) {
        reportViewError(e);
      }
    };
    editViewBtn = views.createEl("button", { text: "Edit" });
    editViewBtn.onclick = async () => {
      const current = savedViews.find((v) => v.name === selectedView);
      if (!current) return;
      const name = await promptText(
        app,
        "Rename this view and update it to current filters",
        current.name
      );
      if (!name?.trim()) return;
      const cleanName = name.trim();
      if (viewNameTaken(savedViews, cleanName, current.name)) {
        new Notice(`A saved view named "${cleanName}" already exists.`);
        return;
      }
      const nextViews = savedViews.map((v) =>
        v.name === current.name
          ? { name: cleanName, filters: currentFilterSnapshot() }
          : v
      );
      try {
        await persistViews(nextViews);
        selectedView = cleanName;
        rememberActive();
        syncViewControls();
      } catch (e) {
        reportViewError(e);
      }
    };
    deleteViewBtn = views.createEl("button", { text: "Delete" });
    deleteViewBtn.onclick = async () => {
      const current = savedViews.find((v) => v.name === selectedView);
      if (
        !current ||
        !(await confirmModal(app, `Delete the saved view "${current.name}"?`))
      )
        return;
      try {
        await persistViews(savedViews.filter((v) => v.name !== current.name));
        selectedView = "";
        rememberActive();
        syncViewControls();
      } catch (e) {
        reportViewError(e);
      }
    };
    syncViewControls();
  }

  // footer: utilities pinned to the bottom of the rail, grouped into labelled
  // clusters (Display / Export / global row) so it reads with the same grammar
  // as the filter groups above instead of a flat stack of mixed actions.
  const foot = toolbar.createDiv({ cls: "mm-foot" });

  const displayGroup = foot.createDiv({ cls: "mm-actiongroup" });
  displayGroup.createSpan({ cls: "mm-fltlabel", text: "Display" });
  const titlesBtn = displayGroup.createEl("button", {
    text: "Titles only",
    attr: { title: "Show only node titles" },
  });
  titlesBtn.onclick = () => {
    titleOnly = !titleOnly;
    titlesBtn.toggleClass("on", titleOnly);
    draw();
  };
  const fsBtn = displayGroup.createEl("button", {
    text: "Fullscreen",
    attr: { title: "Toggle fullscreen" },
  });
  fsBtn.onclick = () => {
    if (activeDocument.fullscreenElement) void activeDocument.exitFullscreen();
    else void wrapEl.requestFullscreen();
  };

  const exportGroup = foot.createDiv({ cls: "mm-actiongroup" });
  exportGroup.createSpan({ cls: "mm-fltlabel", text: "Export" });
  const exportBtn = exportGroup.createEl("button", {
    text: "HTML",
    attr: { title: "Save this map as a standalone .html next to the note" },
  });
  exportBtn.onclick = exportHtml;
  const exportExBtn = exportGroup.createEl("button", {
    text: "Excalidraw",
    attr: {
      title: "Save this map as an editable .excalidraw next to the note",
    },
  });
  exportExBtn.onclick = exportExcalidraw;

  // global utilities share one bottom row: Reset hugs the left, Help the right
  const footUtil = foot.createDiv({ cls: "mm-utilrow" });

  plugin.registerDomEvent(activeDocument, "fullscreenchange", () => {
    fsBtn.toggleClass("on", activeDocument.fullscreenElement === wrapEl);
    window.requestAnimationFrame(fit);
    // left fullscreen with a deferred persist queued -> flush it now
    if (activeDocument.fullscreenElement !== wrapEl && pendingWrite) {
      const cfgToWrite = pendingWrite;
      pendingWrite = null;
      writeBlock(cfgToWrite).catch(reportViewError);
    }
  });

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

  function rememberActive() {
    activeState.set(ctx.sourcePath, {
      view: selectedView,
      filters: currentFilterSnapshot(),
    });
  }

  // default a new view's name to its enabled filter values, capped so the select
  // never shows a severed word, e.g. "now · in-progress · 2026 Q1".
  function defaultViewName(): string {
    const snap = currentFilterSnapshot();
    const name = (cfg.filter || [])
      .flatMap((prop) => snap[prop] || [])
      .join(" · ");
    return name.length > 32 ? name.slice(0, 31).trimEnd() + "…" : name;
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
    const placeholder = viewSelect.createEl("option", { text: "Select…" });
    placeholder.value = "";
    savedViews.forEach((viewCfg) => {
      const opt = viewSelect.createEl("option", { text: viewCfg.name });
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

  async function writeBlock(nextCfg: MapCfg) {
    // Defer while fullscreen: the write would re-render the block and drop us out of
    // fullscreen. The UI already reflects the change in-place; only persistence waits.
    if (activeDocument.fullscreenElement === wrapEl) {
      pendingWrite = nextCfg;
      return;
    }
    const file = app.vault.getAbstractFileByPath(ctx.sourcePath);
    if (!(file instanceof TFile))
      throw new Error("Could not find the note that owns this mindmap block.");
    const raw = await app.vault.read(file);
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    const lines = raw.split(/\r?\n/);
    const range = mindmapBlockRange(lines);
    if (!range)
      throw new Error("Could not locate the source ```mindmap code block.");
    const nextBlock = ["```mindmap", stringifyYaml(nextCfg).trimEnd(), "```"];
    lines.splice(range.start, range.end - range.start + 1, ...nextBlock);
    await app.vault.modify(file, lines.join(eol));
  }

  async function persistViews(nextViews: SavedViewCfg[]) {
    const nextCfg: MapCfg = { ...cfg };
    if (nextViews.length) nextCfg.views = nextViews;
    else delete nextCfg.views;
    // a deleted/renamed active view must not linger as a dangling pointer
    if (
      nextCfg.activeView &&
      !nextViews.some((v) => v.name === nextCfg.activeView)
    )
      delete nextCfg.activeView;
    await writeBlock(nextCfg);
    savedViews = nextViews;
    cfg.views = nextViews.length ? nextViews : undefined;
    cfg.activeView = nextCfg.activeView;
  }

  // the picked view is restored after an Obsidian reload (see initialView). Raw
  // chip toggles aren't persisted — too chatty to rewrite the note per click.
  async function persistActiveView(name: string) {
    const nextCfg: MapCfg = { ...cfg };
    if (name) nextCfg.activeView = name;
    else delete nextCfg.activeView;
    await writeBlock(nextCfg);
    cfg.activeView = name || undefined;
  }

  function reportViewError(e: unknown) {
    new Notice(
      "Could not update mindmap views:\n" +
        (e instanceof Error ? e.message : String(e))
    );
  }

  const resetBtn = footUtil.createEl("button", { text: "Reset" });
  resetBtn.onclick = () => {
    collapsed.clear();
    selected = null;
    focused = null;
    selectedView = "";
    searchTerm = "";
    search.value = "";
    titleOnly = false;
    titlesBtn.toggleClass("on", false);
    (cfg.filter || []).forEach((p) => filters[p].clear());
    updateFilterChips();
    syncViewControls();
    renderFocusTicket();
    draw();
    fit();
    if (cfg.activeView) persistActiveView("").catch(reportViewError);
  };

  const helpBtn = footUtil.createEl("button", {
    cls: "mm-help",
    text: "Help",
    attr: { title: "Mindmap help" },
  });
  helpBtn.onclick = () => new HelpModal(app).open();

  // focus ticket lives at the top of the rail (built right after the search box).
  function renderFocusTicket() {
    const node = focused != null ? nodes[focused] : undefined;
    if (node) focusLabel.setText(`Focus: ${node.title}`);
    focusTicket.toggleClass("mm-hidden", !node);
  }
  function setFocus(id: string | null) {
    focused = id;
    selected = null;
    renderFocusTicket();
    draw();
    fit();
  }
  renderFocusTicket();

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
      (focusId) => setFocus(focusId),
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
        const hasBar = !titleOnly && (n.progress != null || n.bars.length > 0);
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
        const labelH = !titleOnly && n.labels.length ? 24 : 0;
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
        if (!titleOnly && n.sub) {
          const subWrapped = wrap(n.sub, subWidth(n.w!), 10.5, subLines);
          if (
            subWrapped.join(" ").length <
            n.sub.replace(/\s+/g, " ").trim().length
          )
            truncated = true;
          subWrapped.forEach((t) =>
            lines.push({ t, cls: "mm-t2", size: 10.5, lh: 15 })
          );
        }
        if (!titleOnly && n.meta)
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

        // bottom strip: label pills, then the progress/category bar as the last row
        if (labelH) drawLabels(g, n);
        if (hasBar) drawBar(g, n);

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
    rememberActive();
  }

  // small value pills along the card's bottom strip; drops any that don't fit on one row.
  // sit above the bar when there is one, so the bar is always the card's last row.
  function drawLabels(g: SVGElement, n: MNode) {
    const hasBar = n.progress != null || n.bars.length > 0;
    const top = n.y! + n.h! - (hasBar ? 53 : 31),
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

  // progress bar (0-100) and/or stacked category bar, pinned to the card's last row
  function drawBar(g: SVGElement, n: MNode) {
    const x = n.x! + 14,
      w = n.w! - 28,
      y = n.y! + n.h! - 23;
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
    // the sidebar overlays the left of the stage; keep content clear of it
    const barW = toolbar.classList.contains("mm-bar-collapsed")
      ? 0
      : toolbar.offsetWidth + 16;
    view.k =
      Math.min(
        (w - barW) / (contentRight + 40),
        h / (contentBottom + 40),
        1.4
      ) || 1;
    view.x = barW + 20;
    view.y = 8;
    apply();
  }

  // Export the current map (full extent, current collapse/filter state) as a
  // standalone .html next to the note. The view is already an SVG tree; we clone
  // it, freeze each element's *computed* style inline (so the file renders without
  // Obsidian's CSS vars / theme), and frame it with a transform-free viewBox.
  // ponytail: copies whatever's painted now — an active search dim bakes in.
  function exportHtml() {
    const PAD = 24;
    const PROPS = [
      "fill",
      "stroke",
      "stroke-width",
      "stroke-dasharray",
      "opacity",
      "font-family",
      "font-size",
      "font-weight",
      "text-anchor",
      "letter-spacing",
      "filter",
    ];
    const box = (rootG as SVGGraphicsElement).getBBox();
    const clone = svg.cloneNode(true) as SVGSVGElement;
    const live = svg.querySelectorAll<SVGElement>("*");
    const copies = clone.querySelectorAll<SVGElement>("*");
    live.forEach((el, i) => {
      const cs = getComputedStyle(el);
      copies[i].setAttribute(
        "style",
        PROPS.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(";")
      );
    });
    clone.querySelector("g")?.removeAttribute("transform"); // drop pan/zoom
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute(
      "viewBox",
      `${box.x - PAD} ${box.y - PAD} ${box.width + PAD * 2} ${box.height + PAD * 2}`
    );
    clone.setAttribute("width", String(Math.ceil(box.width + PAD * 2)));
    clone.setAttribute("height", String(Math.ceil(box.height + PAD * 2)));

    const bg = getComputedStyle(wrapEl).backgroundColor || "#fff";
    const esc = (s: string) =>
      s.replace(/[<>&]/g, (c) =>
        c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"
      );
    const html =
      `<!doctype html><meta charset="utf-8"><title>${esc(cfg.title || "Mindmap")}</title>` +
      `<body style="margin:0;background:${bg}">${clone.outerHTML}</body>`;

    const path = mindmapExportPath(ctx.sourcePath);
    void app.vault.adapter.write(path, html).then(
      () => new Notice("Exported to " + path),
      (e: unknown) =>
        new Notice(
          "Export failed: " + (e instanceof Error ? e.message : String(e))
        )
    );
  }

  // Export the current map as an editable .excalidraw (v2 JSON) next to the
  // note. Reuses the geometry draw() just laid out and the edges it drew
  // (`links`); the pure builder in graph.ts does the element mapping.
  // ponytail: copies the current collapse/filter/titles state, like Export HTML.
  function exportExcalidraw() {
    const baseVis = computeVisible(nodes, collapsed, filters, cfg);
    const focusVis = focusVisible(nodes, focused);
    const vis = focused
      ? new Set([...baseVis].filter((id) => focusVis.has(id)))
      : baseVis;
    const visNodes = Object.values(nodes).filter((n) => vis.has(n.id));
    const exIndex = new Map(visNodes.map((n, i) => [n.id, i]));
    const exNodes = visNodes.map((n) => ({
      x: n.x!,
      y: n.y!,
      w: n.w!,
      h: n.h!,
      color: n.color,
      text: !titleOnly && n.sub ? n.title + "\n" + n.sub : n.title,
    }));
    const exEdges = links.map(({ a, b }) => {
      const p = nodes[a],
        c = nodes[b];
      return {
        x1: p.x! + p.w!,
        y1: p.y! + p.h! / 2,
        x2: c.x!,
        y2: c.y! + c.h! / 2,
        color: p.color,
        source: exIndex.get(a),
        target: exIndex.get(b),
      };
    });
    const json = JSON.stringify(mapToExcalidraw(exNodes, exEdges), null, 2);
    const path = mindmapExcalidrawPath(ctx.sourcePath);
    void app.vault.adapter.write(path, json).then(
      () => new Notice("Exported to " + path),
      (e: unknown) =>
        new Notice(
          "Export failed: " + (e instanceof Error ? e.message : String(e))
        )
    );
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
  // background click clears only the sticky highlight; focus stays until its ticket ✕
  stage.addEventListener("click", () => {
    selected = null;
    reapply();
  });

  // in-memory state wins (survives a persist re-render); after an Obsidian reload
  // it's gone, so fall back to the view persisted in the block (cfg.activeView).
  const remembered = activeState.get(ctx.sourcePath);
  const startView = initialView(cfg);
  if (remembered) {
    selectedView = remembered.view;
    applyFilterSnapshot(remembered.filters); // restores chips + view dropdown + draws
  } else if (startView) {
    selectedView = startView.name;
    applyFilterSnapshot(startView.filters || {});
  } else {
    draw();
  }
  // first fit after the element has real dimensions
  window.requestAnimationFrame(fit);
}
