/// <reference types="@figma/plugin-typings" />
/**
 * FigJam and Figma Slides: the editors whose native nodes Figma Design does
 * not have.
 *
 * - create_figjam_diagram draws a graph placed by src/shared/figjam with
 *   FigJam's own shapes-with-text, stickies and connectors, inside a section.
 *   Connectors follow their shapes natively — no live re-routing needed.
 * - get_slides / create_slide read and extend the slide grid of a Slides file.
 *
 * Each op refuses with a next step in the wrong editor, rather than failing
 * deep inside a create call Figma Design does not have.
 */
import { ErrorCode } from "../../shared/protocol.js";
import { err } from "../errors.js";
import type { HandlerContext } from "../context.js";
import { FIGJAM_FILL, type FigjamColor, type FigjamShape } from "../../shared/figjam/style.js";
import { hexToRgb } from "../color-util.js";

type Json = Record<string, unknown>;

function requireEditor(want: "figjam" | "slides", op: string): void {
  if (figma.editorType !== want) {
    throw err(
      ErrorCode.UNSUPPORTED_OPERATION,
      `${op} needs a ${want === "figjam" ? "FigJam board" : "Figma Slides deck"}; this window is "${figma.editorType}".`,
      want === "figjam"
        ? "Open a FigJam file, run Figma Plugin MCP there, and pass file:\"<that board's name>\". In Figma Design, figma_diagram draws with frames instead."
        : "Open a Figma Slides file and run Figma Plugin MCP there (pass file:\"<deck name>\").",
    );
  }
}

async function setText(target: { text: TextSublayerNode }, characters: string): Promise<void> {
  const font = target.text.fontName;
  if (font !== figma.mixed) await figma.loadFontAsync(font);
  else await figma.loadFontAsync({ family: "Inter", style: "Medium" });
  target.text.characters = characters;
}

function solid(color: string): SolidPaint {
  const { r, g, b } = hexToRgb(color);
  return { type: "SOLID", color: { r, g, b } };
}

/** create_figjam_diagram: { title, nodes:[{id,label,shape,color,x,y,w,h}], edges:[{from,to,label?,dashed?}], width, height, x?, y? }. */
export async function createFigjamDiagram(ctx: HandlerContext): Promise<unknown> {
  requireEditor("figjam", "create_figjam_diagram");
  const p = ctx.params;
  const nodes = (Array.isArray(p.nodes) ? p.nodes : []) as Json[];
  const edges = (Array.isArray(p.edges) ? p.edges : []) as Json[];
  if (!nodes.length) throw err(ErrorCode.INVALID_PARAMS, "create_figjam_diagram needs nodes.", "This op is driven by figma_diagram; call that instead.");
  const ox = typeof p.x === "number" ? p.x : figma.viewport.center.x - Number(p.width ?? 800) / 2;
  const oy = typeof p.y === "number" ? p.y : figma.viewport.center.y - Number(p.height ?? 600) / 2;

  const section = figma.createSection();
  section.name = String(p.title ?? "Diagram");
  section.x = ox;
  section.y = oy;
  section.resizeWithoutConstraints(Math.max(200, Number(p.width ?? 800)), Math.max(160, Number(p.height ?? 600)));
  section.setPluginData("figjam-diagram", JSON.stringify({ kind: p.kind ?? null, title: p.title ?? null }));

  const idMap: Record<string, string> = {};
  const total = nodes.length + edges.length;
  let done = 0;
  for (const n of nodes) {
    const shape = String(n.shape ?? "ROUNDED_RECTANGLE") as FigjamShape;
    const color = FIGJAM_FILL[(String(n.color ?? "blue") as FigjamColor)] ?? FIGJAM_FILL.blue;
    let node: StickyNode | ShapeWithTextNode;
    if (shape === "STICKY") {
      const sticky = figma.createSticky();
      await setText(sticky, String(n.label ?? ""));
      sticky.fills = [solid(color)];
      node = sticky;
    } else {
      const s = figma.createShapeWithText();
      s.shapeType = shape;
      s.resize(Math.max(24, Number(n.w ?? 160)), Math.max(24, Number(n.h ?? 80)));
      s.fills = [solid(color)];
      await setText(s, String(n.label ?? ""));
      node = s;
    }
    node.name = String(n.label ?? n.id).split("\n")[0]!.slice(0, 80);
    section.appendChild(node);
    node.x = Number(n.x ?? 0);
    node.y = Number(n.y ?? 0);
    node.setPluginData("figjam-id", String(n.id));
    idMap[String(n.id)] = node.id;
    ctx.progress(++done, total, "shapes");
  }

  let connectors = 0;
  for (const e of edges) {
    const a = idMap[String(e.from)];
    const b = idMap[String(e.to)];
    if (!a || !b) {
      ctx.warn(`Edge ${String(e.from)} → ${String(e.to)} was not drawn: a node it names does not exist.`);
      continue;
    }
    const c = figma.createConnector();
    section.appendChild(c);
    c.connectorStart = { endpointNodeId: a, magnet: "AUTO" };
    c.connectorEnd = { endpointNodeId: b, magnet: "AUTO" };
    c.connectorEndStrokeCap = "ARROW_LINES";
    if (e.dashed === true) c.dashPattern = [10, 6];
    if (typeof e.label === "string" && e.label) await setText(c, e.label);
    connectors++;
    ctx.progress(++done, total, "connectors");
  }
  return { sectionId: section.id, nodeIds: idMap, shapes: nodes.length, connectors };
}

/** get_slides: the deck as rows of slides (the slide grid). */
export async function getSlides(_ctx: HandlerContext): Promise<unknown> {
  requireEditor("slides", "get_slides");
  const grid = figma.getSlideGrid();
  const rows = grid.map((row, r) =>
    row.map((slide, c) => ({
      id: slide.id,
      name: slide.name,
      row: r,
      col: c,
      ...((slide as unknown as { isSkippedSlide?: boolean }).isSkippedSlide ? { skipped: true } : {}),
      childCount: slide.children.length,
    })),
  );
  return { rows, slideCount: rows.reduce((n, r) => n + r.length, 0), currentPage: figma.currentPage.name };
}

/** create_slide: { name?, row?, col? } → a new slide; draw into it with create({ parentId }). */
export async function createSlide(ctx: HandlerContext): Promise<unknown> {
  requireEditor("slides", "create_slide");
  const p = ctx.params;
  const row = typeof p.row === "number" ? Math.max(0, Math.floor(p.row)) : undefined;
  const col = typeof p.col === "number" ? Math.max(0, Math.floor(p.col)) : undefined;
  const slide = row !== undefined ? figma.createSlide(row, col) : figma.createSlide();
  if (typeof p.name === "string" && p.name) slide.name = p.name;
  if (typeof p.fill === "string") slide.fills = [solid(p.fill)];
  if (p.focus === true) figma.viewport.slidesView = "single-slide";
  return { id: slide.id, name: slide.name, width: slide.width, height: slide.height };
}
