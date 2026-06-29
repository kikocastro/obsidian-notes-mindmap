import { wrap, subWidth } from "../graph";
import { MapPayload, VNode } from "./payload";

// Webview renderer: pure SVG drawing from the host-computed payload. No graph
// logic here except `wrap` (text fitting). Click a card -> ask the host to open
// the note. Mirrors the Obsidian adapter's card drawing.
// ponytail: v1 draws + pan/zoom + click-to-open. Search/filter/collapse/the note
// dialog are deferred to a later pass; add them when the VS Code UX is shaped.

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
declare global {
  interface Window {
    __mmPayload: MapPayload;
  }
}

const NS = "http://www.w3.org/2000/svg";
const vscodeApi = acquireVsCodeApi();
const data = window.__mmPayload;

const svgEl = (
  tag: string,
  attrs: Record<string, string | number>,
  parent: Element
): SVGElement => {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  parent.appendChild(e);
  return e;
};

const stage = document.getElementById("stage") as HTMLDivElement;
const svg = stage.querySelector("svg") as SVGSVGElement;
const rootG = svgEl("g", {}, svg);

// column headers
data.headers.forEach((h) => {
  svgEl("text", { class: "mm-colhead", x: h.x, y: 36 }, rootG).textContent =
    h.label;
});

// edges first (under the cards)
const linkLayer = svgEl("g", {}, rootG);
const nodeLayer = svgEl("g", {}, rootG);
data.edges.forEach((e) => {
  const mx = (e.x1 + e.x2) / 2;
  svgEl(
    "path",
    {
      class: "mm-link" + (e.secondary ? " mm-also" : ""),
      d: `M${e.x1},${e.y1} C${mx},${e.y1} ${mx},${e.y2} ${e.x2},${e.y2}`,
      stroke: e.color,
      "stroke-width": 2.5,
    },
    linkLayer
  );
});

function drawLabels(g: SVGElement, n: VNode) {
  const top = n.y + 7,
    h = 15,
    size = 9,
    pad = 11;
  const maxX = n.x + n.w - (n.hasKids ? 30 : 12);
  let bx = n.x + 12;
  for (const t of n.labels) {
    const w = Math.ceil(t.length * size * 0.62) + pad * 2; // estimated width (no SVG text metrics)
    if (bx + w > maxX) break;
    svgEl(
      "rect",
      { class: "mm-label", x: bx, y: top, width: w, height: h, rx: 7 },
      g
    );
    svgEl(
      "text",
      { class: "mm-label-t", x: bx + w / 2, y: top + 11, "font-size": size },
      g
    ).textContent = t;
    bx += w + 5;
  }
}

function drawBar(g: SVGElement, n: VNode) {
  const x = n.x + 14,
    w = n.w - 28,
    y = n.y + n.h - 14;
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

data.nodes.forEach((n) => {
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
      stroke: n.color,
    },
    g
  );

  const labelH = n.labels.length ? 20 : 0;
  if (labelH) drawLabels(g, n);

  const padR = n.hasKids ? 42 : 16;
  const lines: { t: string; cls: string; size: number; lh: number }[] = [];
  let truncated = false;
  const titleWrapped = wrap(n.title, n.w - 14 - padR, 12, data.titleLines);
  if (
    titleWrapped.join(" ").length < n.title.replace(/\s+/g, " ").trim().length
  )
    truncated = true;
  titleWrapped.forEach((t) =>
    lines.push({ t, cls: "mm-t1", size: 12, lh: 16 })
  );
  if (n.sub) {
    const subWrapped = wrap(n.sub, subWidth(n.w), 10.5, data.subLines);
    if (subWrapped.join(" ").length < n.sub.replace(/\s+/g, " ").trim().length)
      truncated = true;
    subWrapped.forEach((t) =>
      lines.push({ t, cls: "mm-t2", size: 10.5, lh: 15 })
    );
  }
  if (n.meta) lines.push({ t: n.meta, cls: "mm-meta", size: 9.5, lh: 14 });
  const totalH = lines.reduce((s, b) => s + b.lh, 0);
  const firstSize = lines[0]?.size || 12;
  let ty =
    labelH || hasBar
      ? n.y + labelH + firstSize + 2
      : n.y + (n.h - totalH) / 2 + firstSize;
  lines.forEach((b) => {
    svgEl(
      "text",
      { class: b.cls, x: n.x + 14, y: ty, "font-size": b.size },
      g
    ).textContent = b.t;
    ty += b.lh;
  });

  if (truncated)
    svgEl("title", {}, g).textContent = n.title + (n.sub ? "\n" + n.sub : "");

  if (hasBar) drawBar(g, n);
  g.addEventListener("click", () =>
    vscodeApi.postMessage({ type: "open", path: n.id })
  );
});

// ---- pan / zoom / fit ----
const view = { x: 20, y: 8, k: 1 };
const apply = () =>
  rootG.setAttribute(
    "transform",
    `translate(${view.x},${view.y}) scale(${view.k})`
  );
function fit() {
  const w = svg.clientWidth || 800,
    h = svg.clientHeight || 600;
  view.k =
    Math.min(
      w / (data.contentRight + 40),
      h / (data.contentBottom + 40),
      1.4
    ) || 1;
  view.x = 20;
  view.y = 8;
  apply();
}
let drag: { x: number; y: number } | null = null;
stage.addEventListener("mousedown", (e) => {
  drag = { x: e.clientX - view.x, y: e.clientY - view.y };
  stage.classList.add("drag");
});
window.addEventListener("mousemove", (e) => {
  if (drag) {
    view.x = e.clientX - drag.x;
    view.y = e.clientY - drag.y;
    apply();
  }
});
window.addEventListener("mouseup", () => {
  drag = null;
  stage.classList.remove("drag");
});
stage.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const step = Math.min(0.06, Math.abs(e.deltaY) * 0.0009);
    const f = e.deltaY < 0 ? 1 + step : 1 / (1 + step);
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

fit();
window.addEventListener("resize", fit);
