// SVG element helper shared by the renderer. Obsidian adapter only (touches the DOM).

const NS = "http://www.w3.org/2000/svg";

export const svgEl = (
  tag: string,
  attrs: Record<string, any>,
  parent: Element
): SVGElement => {
  const e = activeDocument.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  parent.appendChild(e);
  return e;
};
