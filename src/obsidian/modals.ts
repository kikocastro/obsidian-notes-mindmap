// Obsidian Modals for the mindmap: prompt, confirm, help, and the note dialog.
// Adapter-only (imports `obsidian`); pure logic stays in src/graph.ts.

import { App, Component, MarkdownRenderer, Modal, TFile } from "obsidian";
import { MNode, scalarStr } from "../graph";

// a neighbour (parent/child/sibling), resolved for the note dialog's "Linked" section
export interface LinkRow {
  id: string;
  title: string;
  levelLabel: string;
  color: string;
  secondary: boolean;
  relation: "parent" | "child" | "sibling";
}

// ---- text prompt ---------------------------------------------------------
// Obsidian/Electron has no window.prompt (it returns null), which silently broke
// saving and editing views. A tiny Modal stands in: resolves the typed string, or
// null on cancel/Esc.
class PromptModal extends Modal {
  private resolved = false;
  constructor(
    app: App,
    private heading: string,
    private initial: string,
    private done: (value: string | null) => void
  ) {
    super(app);
  }
  override onOpen() {
    const { contentEl, modalEl } = this;
    // same fullscreen re-home as NoteModal: the modal mounts on body, hidden by the
    // fullscreen layer, so move it inside the fullscreen element.
    if (activeDocument.fullscreenElement)
      activeDocument.fullscreenElement.appendChild(this.containerEl);
    modalEl.addClass("mm-prompt");
    contentEl.createEl("h3", { text: this.heading });
    const input = contentEl.createEl("input", {
      type: "text",
      cls: "mm-prompt-input",
      value: this.initial,
    });
    const submit = () => {
      this.resolved = true;
      this.done(input.value);
      this.close();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });
    const row = contentEl.createDiv({ cls: "mm-prompt-actions" });
    row.createEl("button", { text: "Save", cls: "mod-cta" }).onclick = submit;
    row.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    activeWindow.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }
  override onClose() {
    this.contentEl.empty();
    if (!this.resolved) this.done(null);
  }
}

export const promptText = (
  app: App,
  heading: string,
  initial = ""
): Promise<string | null> =>
  new Promise((resolve) =>
    new PromptModal(app, heading, initial, resolve).open()
  );

// Electron's window.confirm works but Obsidian's review guidelines disallow it, so a
// tiny Modal stands in: resolves true on confirm, false on cancel/Esc.
class ConfirmModal extends Modal {
  private resolved = false;
  constructor(
    app: App,
    private message: string,
    private done: (ok: boolean) => void
  ) {
    super(app);
  }
  override onOpen() {
    const { contentEl, modalEl } = this;
    if (activeDocument.fullscreenElement)
      activeDocument.fullscreenElement.appendChild(this.containerEl);
    modalEl.addClass("mm-prompt");
    contentEl.createEl("h3", { text: this.message });
    const row = contentEl.createDiv({ cls: "mm-prompt-actions" });
    row.createEl("button", { text: "OK", cls: "mod-cta" }).onclick = () => {
      this.resolved = true;
      this.done(true);
      this.close();
    };
    row.createEl("button", { text: "Cancel" }).onclick = () => this.close();
  }
  override onClose() {
    this.contentEl.empty();
    if (!this.resolved) this.done(false);
  }
}

export const confirmModal = (app: App, message: string): Promise<boolean> =>
  new Promise((resolve) => new ConfirmModal(app, message, resolve).open());

// ---- help dialog ---------------------------------------------------------
// ponytail: hand-maintained cheat sheet. The plugin can't read the repo README at
// runtime (only main.js/manifest/styles ship to the vault), so this mirrors the key
// reference; full docs + examples live at the GitHub link below.
const HELP = `## Markdown Mindmap

A map is one \`\`\`mindmap\`\`\` block of YAML. Folders become columns (**levels**),
frontmatter links become **edges**. The tree rebuilds from your notes every open.

### Quick start
~~~yaml
title: Goals → Projects → Tasks
levels:
  - { id: goals,    label: GOALS,    from: planning/goals,    card: { title: title, sub: kpi } }
  - { id: projects, label: PROJECTS, from: planning/projects, card: { title: title, meta: [status] } }
  - { id: tasks,    label: TASKS,    from: planning/tasks,    card: { title: title, progress: progress } }
edges:
  - { from: goals,    to: projects, via: goal }     # each project note: goal: "[[Goal A]]"
  - { from: projects, to: tasks,    via: project }  # each task note: project: "[[Project 1]]"
filter: [status]
~~~

### Top-level keys
- **title** — heading in the toolbar
- **height** — component height px (default 900)
- **levels** — columns, left to right (**required**)
- **edges** — parent → child links between levels
- **filter** — properties shown as chip filters
- **filterLabels** — rename a filter group's heading
- **layout** — override card/column sizing
- **properties: true** — show all frontmatter in the note dialog
- **views** — saved filter + collapse selections (managed by the toolbar)

### Each level
- **id** (required) — referenced by edges
- **from** (required) — folder to read notes from (recursive)
- **label** — column header
- **color** — column/border hex colour
- **where** — keep only notes matching, e.g. \`{ horizon: now }\`
- **card** — which fields render on the card

### Each card
Field values are frontmatter property names; dotted paths work everywhere (\`customFields.serves\`).
- **title** — bold title (falls back to file name)
- **sub** — subtitle line (single line by default; set \`layout.subLines: 2\`+ to wrap it)
- **meta** — list of fields, muted \`·\`-joined line
- **progress** — a 0–100 field as a progress bar
- **bars** — a list field as a stacked count-by-category bar (or a map: \`{ field, category, colors }\`)
- **labels** — list of fields shown as coloured pills

### Each edge
- **from** / **to** — level ids
- **via** — frontmatter field holding the link (on the **to** notes by default; dotted paths work)
- **reverse: true** — field lives on the **from** notes and points down
- **secondary: true** — draw dashed, keep out of the layout spine

### Interactions
- **Search** — spotlight matching cards, dim the rest
- **Filter chips** — multi-select per property (OR within, AND across)
- **Saved views** — save / apply / edit / delete a filter combination; each view also remembers which subtrees are collapsed
- **Export** — save the current map next to the note as a standalone **HTML** file or an editable **Excalidraw** drawing
- **Hover** a card — highlight its full up/down lineage
- **Click** a card — dialog with its linked parents, siblings, and children (click to jump), properties, and the rendered note
- **Focus** (from the dialog) — show a node, its ancestors, and primary descendants; persists until you click empty map space to clear
- **Titles only** — hide subtitle/meta/bars/labels, leaving just titles
- **+ / −** — collapse / expand a subtree
- **⟨ / ☰** — collapse the toolbar to a single button, or expand it back
- **⛶** fullscreen · **Reset** clears filters/search/collapse/focus · drag to pan, scroll to zoom

[Full documentation on GitHub →](https://github.com/kikocastro/markdown-mindmap#readme)
`;

export class HelpModal extends Modal {
  private comp = new Component();
  override async onOpen() {
    this.comp.load();
    const { contentEl, modalEl } = this;
    if (activeDocument.fullscreenElement)
      activeDocument.fullscreenElement.appendChild(this.containerEl);
    modalEl.addClass("mm-modal");
    this.containerEl.addClass("mm-modal-host");
    contentEl.empty();
    const body = contentEl.createDiv({ cls: "mm-note markdown-rendered" });
    await MarkdownRenderer.render(this.app, HELP, body, "", this.comp);
  }
  override onClose() {
    this.comp.unload();
    this.contentEl.empty();
  }
}

// ---- note dialog ---------------------------------------------------------

export class NoteModal extends Modal {
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
    if (activeDocument.fullscreenElement)
      activeDocument.fullscreenElement.appendChild(this.containerEl);
    modalEl.addClass("mm-modal");
    this.containerEl.addClass("mm-modal-host");
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
      void this.app.workspace.getLeaf("tab").openFile(this.file);
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
    if (value == null || value === "") return "—";
    if (typeof value === "object") {
      try {
        return JSON.stringify(value);
      } catch {
        return "[object]";
      }
    }
    return scalarStr(value);
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
      // when every row in the group shares one level, hoist it into the header
      // (PARENTS · DRIVERS) so the per-row title gets the full width
      const lvls = new Set(rows.map((l) => l.levelLabel));
      const sharedLvl = lvls.size === 1 ? [...lvls][0] : null;
      const grp = wrapEl.createDiv({ cls: "mm-note-linkgroup" });
      grp.createDiv({
        cls: "mm-note-linklabel",
        text: `${label}${sharedLvl ? ` · ${sharedLvl}` : ""} (${rows.length})`,
      });
      rows.forEach((l) => {
        const btn = grp.createEl("button", {
          cls: "mm-link-row" + (l.secondary ? " mm-link-sec" : ""),
        });
        btn.style.setProperty("--mm-accent", l.color);
        if (!sharedLvl)
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
