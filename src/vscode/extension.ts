import * as vscode from "vscode";
import * as yaml from "js-yaml";
import {
  MapCfg,
  NoteLike,
  Resolver,
  collectNodes,
  buildEdges,
  isSecondary,
  computeVisible,
  orderAndLayout,
  resolveLayout,
  validateConfig,
} from "../graph";
import { MapPayload, VEdge, VNode } from "./payload";

// ============================================================================
// Markdown Mindmap — VS Code adapter. Reuses the pure core (../graph). Reads the
// workspace's markdown frontmatter, runs the same layout the Obsidian adapter
// does, and renders the result in a webview. Click a card to open the note.
// Config comes from a ```mindmap fenced block in the active markdown file.
// ============================================================================

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("markdownMindmap.open", () =>
      openMap(context)
    )
  );
}

export function deactivate() {}

async function openMap(context: vscode.ExtensionContext) {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.languageId !== "markdown") {
    vscode.window.showErrorMessage(
      "Markdown Mindmap: open a markdown note with a ```mindmap block first."
    );
    return;
  }
  const block = extractMindmapBlock(ed.document.getText());
  if (!block) {
    vscode.window.showErrorMessage(
      "Markdown Mindmap: no ```mindmap block found in this note."
    );
    return;
  }
  let cfg: MapCfg;
  try {
    cfg = yaml.load(block) as MapCfg;
    validateConfig(cfg);
  } catch (e: any) {
    vscode.window.showErrorMessage(
      "Markdown Mindmap config error: " + (e?.message || String(e))
    );
    return;
  }

  // workspace markdown -> NoteLike[] (path is workspace-relative, the node id)
  const uris = await vscode.workspace.findFiles(
    "**/*.md",
    "**/node_modules/**"
  );
  const notes: NoteLike[] = [];
  const fsPathByRel: Record<string, string> = {};
  for (const uri of uris) {
    const rel = vscode.workspace.asRelativePath(uri, false);
    const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString(
      "utf8"
    );
    notes.push({
      path: rel,
      basename: rel.replace(/^.*\//, "").replace(/\.md$/, ""),
      frontmatter: parseFrontmatter(text),
    });
    fsPathByRel[rel] = uri.fsPath;
  }

  // no vault link API here: resolve links by basename, then by `title` frontmatter
  const resolver: Resolver = (key) => {
    const hit = notes.find(
      (n) =>
        n.basename === key || String(n.frontmatter.title ?? "").trim() === key
    );
    return hit ? hit.path : null;
  };

  const { nodes, byLevel } = collectNodes(cfg, notes);
  const edgeKind = buildEdges(cfg, nodes, byLevel, resolver);
  const vis = computeVisible(nodes, new Set(), {}, cfg);
  const { levelX, contentRight, contentBottom } = orderAndLayout(
    cfg,
    nodes,
    byLevel,
    vis
  );

  const vNodes: VNode[] = Object.values(nodes)
    .filter((n) => vis.has(n.id))
    .map((n) => ({
      id: n.id,
      x: n.x!,
      y: n.y!,
      w: n.w!,
      h: n.h!,
      color: n.color,
      title: n.title,
      sub: n.sub,
      meta: n.meta,
      labels: n.labels,
      progress: n.progress,
      bars: n.bars,
      hasKids: [...n.children].some((c) => vis.has(c)),
    }));

  const edges: VEdge[] = [];
  Object.values(nodes).forEach((p) => {
    if (!vis.has(p.id)) return;
    [...p.children]
      .filter((c) => vis.has(c))
      .forEach((cid) => {
        const c = nodes[cid];
        edges.push({
          x1: p.x! + p.w!,
          y1: p.y! + p.h! / 2,
          x2: c.x!,
          y2: c.y! + c.h! / 2,
          color: p.color,
          secondary: isSecondary(edgeKind, p.id, cid),
        });
      });
  });

  const headers = cfg.levels
    .map((lvl, i) => ({ x: levelX[i], label: lvl.label || "" }))
    .filter((h) => h.label);

  const payload: MapPayload = {
    title: cfg.title || "Markdown Mindmap",
    titleLines: resolveLayout(cfg.layout).titleLines,
    nodes: vNodes,
    edges,
    headers,
    contentRight,
    contentBottom,
  };

  const panel = vscode.window.createWebviewPanel(
    "markdownMindmap",
    payload.title,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  const scriptUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, "dist", "webview.js")
  );
  panel.webview.html = htmlShell(panel.webview, scriptUri, payload);
  panel.webview.onDidReceiveMessage((msg) => {
    if (msg?.type === "open" && fsPathByRel[msg.path]) {
      vscode.window.showTextDocument(vscode.Uri.file(fsPathByRel[msg.path]), {
        preview: false,
      });
    }
  });
}

// the first ```mindmap fenced block's body, or null
function extractMindmapBlock(md: string): string | null {
  const m = md.match(/```mindmap[ \t]*\r?\n([\s\S]*?)\r?\n```/);
  return m ? m[1] : null;
}

// leading --- ... --- YAML frontmatter, or {} when absent/invalid
function parseFrontmatter(text: string): Record<string, any> {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  try {
    const fm = yaml.load(m[1]);
    return fm && typeof fm === "object" ? (fm as Record<string, any>) : {};
  } catch {
    return {};
  }
}

function htmlShell(
  webview: vscode.Webview,
  scriptUri: vscode.Uri,
  payload: MapPayload
): string {
  const nonce = Buffer.from(String(Date.now()) + Math.random())
    .toString("base64")
    .replace(/[^a-zA-Z0-9]/g, "");
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};`;
  // JSON is valid JS, so assign it directly; escape < so a string value can't close the <script> tag
  const data = JSON.stringify(payload).replace(/</g, "\\u003c");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  html, body { height: 100%; margin: 0; }
  body { background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); overflow: hidden; }
  #stage { position: absolute; inset: 0; cursor: grab; }
  #stage.drag { cursor: grabbing; }
  svg { width: 100%; height: 100%; display: block; }
  .mm-colhead { fill: var(--vscode-descriptionForeground); font: 700 14px var(--vscode-font-family); }
  .mm-link { fill: none; opacity: .35; }
  .mm-link.mm-also { stroke-dasharray: 5 5; opacity: .2; }
  .mm-node { cursor: pointer; }
  .mm-box { fill: var(--vscode-editorWidget-background); stroke-width: 1.5; }
  .mm-t1 { font: 700 12px var(--vscode-font-family); fill: var(--vscode-editor-foreground); }
  .mm-t2 { font: 10.5px var(--vscode-font-family); fill: var(--vscode-descriptionForeground); }
  .mm-meta { font: 9.5px var(--vscode-font-family); fill: var(--vscode-descriptionForeground); }
  .mm-label { fill: var(--vscode-badge-background); stroke: var(--vscode-widget-border); }
  .mm-label-t { font: 600 9px var(--vscode-font-family); fill: var(--vscode-badge-foreground); text-anchor: middle; }
  .mm-track { fill: var(--vscode-widget-border); }
  .mm-barlbl { font: 700 9px var(--vscode-font-family); fill: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<div id="stage"><svg></svg></div>
<script nonce="${nonce}">window.__mmPayload = ${data};</script>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
