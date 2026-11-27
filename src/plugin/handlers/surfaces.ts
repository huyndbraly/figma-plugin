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
import { FIGJAM_FILL, FIGJAM_MARKER, LEGACY_FIGJAM_MARKER, type FigjamColor, type FigjamShape } from "../../shared/figjam/style.js";
import { pageModel } from "../diagram-apply.js";
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

/**
 * create_figjam_diagram: { kind, title, source, nodes:[{id,label,shape,color,x,y,w,h}],
 * edges:[{from,to,label?,dashed?}], width, height, x?, y?, intoSectionId? }.
 *
 * The section stores the MODEL it was drawn from (FIGJAM_MARKER), like a Figma
 * Design frame does, so the diagram can be read back, cross-checked and
 * patched. `intoSectionId` redraws an existing section in place: its id,
 * position and comments survive. A failure part-way removes what this call
 * drew instead of leaving half a diagram on the board.
 */
export async function createFigjamDiagram(ctx: HandlerContext): Promise<unknown> {
  requireEditor("figjam", "create_figjam_diagram");
  const p = ctx.params;
  const nodes = (Array.isArray(p.nodes) ? p.nodes : []) as Json[];
  const edges = (Array.isArray(p.edges) ? p.edges : []) as Json[];
  if (!nodes.length) throw err(ErrorCode.INVALID_PARAMS, "create_figjam_diagram needs nodes.", "This op is driven by figma_diagram; call that instead.");

  let section: SectionNode;
  let created = false;
  // On a redraw, the nodes the PREVIOUS drawing made — removed only once the
  // new drawing is complete. Anything else in the section (stickies, images
  // the user added) is the user's and stays.
  let previous: SceneNode[] = [];
  if (typeof p.intoSectionId === "string" && p.intoSectionId) {
    const target = await figma.getNodeByIdAsync(p.intoSectionId);
    if (!target || target.type !== "SECTION" || !(target.getPluginData(FIGJAM_MARKER) || target.getPluginData(LEGACY_FIGJAM_MARKER))) {
      throw err(ErrorCode.INVALID_PARAMS, `"${p.intoSectionId}" is not a FigJam diagram section.`, "Pass the sectionId figma_diagram returned for a FigJam-native diagram.");
    }
    section = target;
    previous = toolDrawn(section);
  } else {
    const ox = typeof p.x === "number" ? p.x : figma.viewport.center.x - Number(p.width ?? 800) / 2;
    const oy = typeof p.y === "number" ? p.y : figma.viewport.center.y - Number(p.height ?? 600) / 2;
    section = figma.createSection();
    created = true;
    section.x = ox;
    section.y = oy;
  }
  const oldName = section.name;
  const oldSize = { w: section.width, h: section.height };
  section.name = String(p.title ?? "Diagram");
  section.resizeWithoutConstraints(Math.max(200, Number(p.width ?? 800)), Math.max(160, Number(p.height ?? 600)));
  const drawnNow: SceneNode[] = [];

  const idMap: Record<string, string> = {};
  const total = nodes.length + edges.length;
  let done = 0;
  let connectors = 0;
  try {
    for (const n of nodes) {
      const shape = String(n.shape ?? "ROUNDED_RECTANGLE") as FigjamShape;
      const color = FIGJAM_FILL[(String(n.color ?? "blue") as FigjamColor)] ?? FIGJAM_FILL.blue;
      let node: StickyNode | ShapeWithTextNode;
      if (shape === "STICKY") {
        const sticky = figma.createSticky();
        section.appendChild(sticky);
        drawnNow.push(sticky); // recorded at once: a failure below must still take it back
        await setText(sticky, String(n.label ?? ""));
        sticky.fills = [solid(color)];
        node = sticky;
      } else {
        const sh = figma.createShapeWithText();
        section.appendChild(sh);
        drawnNow.push(sh);
        sh.shapeType = shape;
        sh.resize(Math.max(24, Number(n.w ?? 160)), Math.max(24, Number(n.h ?? 80)));
        sh.fills = [solid(color)];
        await setText(sh, String(n.label ?? ""));
        node = sh;
      }
      node.name = String(n.label ?? n.id).split("\n")[0]!.slice(0, 80);
      node.x = Number(n.x ?? 0);
      node.y = Number(n.y ?? 0);
      node.setPluginData("figjam-id", String(n.id));
      idMap[String(n.id)] = node.id;
      ctx.progress(++done, total, "shapes");
    }

    for (const e of edges) {
      const a = idMap[String(e.from)];
      const b = idMap[String(e.to)];
      if (!a || !b) {
        ctx.warn(`Edge ${String(e.from)} → ${String(e.to)} was not drawn: a node it names does not exist.`);
        continue;
      }
      const c = figma.createConnector();
      section.appendChild(c);
      c.setPluginData("figjam-id", `edge:${String(e.from)}>${String(e.to)}`);
      drawnNow.push(c);
      c.connectorStart = { endpointNodeId: a, magnet: "AUTO" };
      c.connectorEnd = { endpointNodeId: b, magnet: "AUTO" };
      c.connectorEndStrokeCap = "ARROW_LINES";
      if (e.dashed === true) c.dashPattern = [10, 6];
      if (typeof e.label === "string" && e.label) await setText(c, e.label);
      connectors++;
      ctx.progress(++done, total, "connectors");
    }
  } catch (e) {
    // Half a diagram is worse than none: the agent would read it as drawn.
    // A new section goes entirely; a redraw takes back only what THIS call
    // drew, so the previous drawing — still matching the stored model — stays.
    if (created) section.remove();
    else {
      for (const n of drawnNow) n.remove();
      section.name = oldName;
      section.resizeWithoutConstraints(oldSize.w, oldSize.h);
    }
    throw e;
  }
  // The user's own connectors that ended on a shape about to go: move their
  // end to the new shape with the same diagram id, so they stay attached.
  const prevIds = new Set(previous.map((n) => n.id));
  const drawnIds = new Set(drawnNow.map((n) => n.id));
  // old shape id → its diagram id, once (not one scan per connector end).
  const tagOf = new Map<string, string>();
  for (const n of previous) {
    try {
      const tag = n.getPluginData("figjam-id");
      if (tag) tagOf.set(n.id, tag);
    } catch {
      /* no tag: its connectors cannot be moved */
    }
  }
  // A connector can live anywhere on the page (a user arrow from another
  // section), not only in this one. One that cannot be moved is reported, not
  // thrown: the new drawing is complete by now and must replace the old.
  let dangling = 0;
  for (const c of connectorsAround(section)) {
    if (prevIds.has(c.id) || drawnIds.has(c.id) || insideInstance(c)) continue;
    for (const end of ["connectorStart", "connectorEnd"] as const) {
      const e = c[end] as { endpointNodeId?: string; magnet?: "NONE" | "AUTO" | "TOP" | "LEFT" | "BOTTOM" | "RIGHT" | "CENTER" };
      if (!e || !e.endpointNodeId || !prevIds.has(e.endpointNodeId)) continue;
      const tag = tagOf.get(e.endpointNodeId);
      const to = tag ? idMap[tag] : undefined;
      try {
        if (!to) throw new Error("no new shape");
        c[end] = { endpointNodeId: to, magnet: e.magnet && e.magnet !== "NONE" ? e.magnet : "AUTO" };
      } catch {
        dangling++;
      }
    }
  }
  if (dangling) ctx.warn(`${dangling} end(s) of connectors you drew pointed at shapes this redraw removed and could not be moved to a new shape (the shape is no longer in the model, or Figma refused the change) — check them.`);
  for (const n of previous) if (!n.removed) n.remove();
  section.setPluginData(
    FIGJAM_MARKER,
    // `drawn`: the node ids THIS drawing made — the next redraw removes those
    // and nothing else (a copy the user pasted carries the figjam-id tag too).
    // `section`: whose list it is — a DUPLICATED section carries the copy.
    JSON.stringify({ kind: p.kind ?? null, title: p.title ?? null, ...(p.source !== undefined ? { source: p.source } : {}), native: "figjam", drawn: drawnNow.map((n) => n.id), section: section.id }),
  );
  // The other diagrams on the page, for the server's cross-check — the same
  // hand-back a Figma Design draw gives, so FigJam diagrams are compared too.
  // The diagram IS drawn by now: a page walk that fails must not turn that
  // into an error (an agent would draw it again).
  let onPage: Array<Record<string, unknown>> | undefined;
  try {
    onPage = pageModel(section);
  } catch {
    ctx.warn("The other diagrams on the page could not be read, so this one was not cross-checked.");
  }
  return { sectionId: section.id, nodeIds: idMap, shapes: nodes.length, connectors, ...(created ? {} : { redrawn: true }), ...(onPage ? { pageModel: onPage } : {}) };
}

/**
 * What a previous drawing of this section made. Exactly the ids the marker
 * lists, when it lists them; for a section drawn before that (no `drawn`
 * list), nodes tagged `figjam-id` plus connectors whose two ends are such
 * nodes.
 */
function toolDrawn(section: SectionNode): SceneNode[] {
  let listed: string[] | undefined;
  let owner: string | undefined;
  try {
    const raw = section.getPluginData(FIGJAM_MARKER);
    const mark = raw ? (JSON.parse(raw) as { drawn?: unknown; section?: unknown }) : undefined;
    if (Array.isArray(mark?.drawn)) listed = mark!.drawn.map(String);
    if (typeof mark?.section === "string") owner = mark.section;
  } catch {
    listed = undefined;
  }
  if (listed) {
    const ids = new Set(listed);
    const found = section.children.filter((c) => ids.has(c.id));
    // A DUPLICATED section (Cmd+D) carries the original's list (and id), but
    // its children have new ids. Only then fall back to the tags: an original
    // whose tool shapes the user deleted keeps its pasted copies.
    const duplicated = owner !== undefined ? owner !== section.id : !found.length && listed.length > 0;
    if (!duplicated) return found;
  }
  return toolDrawnByTag(section);
}

/** Inside an instance: not the user's to re-point (and not editable). */
function insideInstance(n: BaseNode): boolean {
  try {
    for (let p = n.parent; p && p.type !== "PAGE"; p = p.parent) if (p.type === "INSTANCE") return true;
  } catch {
    /* unreachable parent: treat as free */
  }
  return false;
}

/** Every connector on the section's page (this section's when the page cannot be reached). */
function connectorsAround(section: SectionNode): ConnectorNode[] {
  try {
    let p: BaseNode | null = section.parent;
    while (p && p.type !== "PAGE") p = p.parent;
    const page = p as (PageNode & { findAllWithCriteria?: PageNode["findAllWithCriteria"] }) | null;
    if (page && typeof page.findAllWithCriteria === "function") return page.findAllWithCriteria({ types: ["CONNECTOR"] }) as ConnectorNode[];
  } catch {
    /* fall through to the section's own */
  }
  return section.children.filter((c): c is ConnectorNode => c.type === "CONNECTOR");
}

function toolDrawnByTag(section: SectionNode): SceneNode[] {
  const tagged = new Set<string>();
  const out: SceneNode[] = [];
  for (const c of section.children) {
    let tag = "";
    try {
      tag = c.getPluginData("figjam-id");
    } catch {
      tag = "";
    }
    if (tag) {
      tagged.add(c.id);
      out.push(c);
    }
  }
  for (const c of section.children) {
    if (c.type !== "CONNECTOR" || out.includes(c)) continue;
    const a = (c.connectorStart as { endpointNodeId?: string }).endpointNodeId;
    const b = (c.connectorEnd as { endpointNodeId?: string }).endpointNodeId;
    if (a && b && tagged.has(a) && tagged.has(b)) out.push(c);
  }
  return out;
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
  const col = typeof p.col === "number" ? Math.max(0, Math.floor(p.col)) : undefined;
  // figma.createSlide(row, col): a column alone has no meaning — it was
  // silently ignored. Put it in the first row and say so.
  let row = typeof p.row === "number" ? Math.max(0, Math.floor(p.row)) : undefined;
  if (row === undefined && col !== undefined) {
    row = 0;
    ctx.warn("createSlide: `col` without `row` — placed in row 0.");
  }
  const slide = row !== undefined ? figma.createSlide(row, col) : figma.createSlide();
  if (typeof p.name === "string" && p.name) slide.name = p.name;
  if (typeof p.fill === "string") slide.fills = [solid(p.fill)];
  if (p.focus === true) figma.viewport.slidesView = "single-slide";
  return { id: slide.id, name: slide.name, width: slide.width, height: slide.height };
}
