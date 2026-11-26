/// <reference types="@figma/plugin-typings" />
/**
 * Draw a laid-out "board" diagram — use case, journey map, persona set.
 *
 * Unlike the graph kinds, these have no live re-routing: every coordinate and
 * every shape arrives as a ready create() spec from src/shared/<kind>, so this
 * handler only opens the frame, draws the specs in order and stores the model
 * on the frame (so get_diagram_spec / update + patch work as for every kind).
 */
import { HandlerContext } from "../context.js";
import { createTree } from "./create.js";
import { openDiagramFrame, pageModel, preloadDiagramFonts } from "../diagram-apply.js";
import { err } from "../errors.js";
import { ErrorCode } from "../../shared/protocol.js";
import { JOURNEY_MARKER, PERSONA_MARKER, USECASE_MARKER } from "../diagram-mark.js";

const MARKERS: Record<string, string> = {
  usecase: USECASE_MARKER,
  journey: JOURNEY_MARKER,
  persona: PERSONA_MARKER,
};
const CHUNK = 60;

type Spec = Record<string, unknown>;

export interface BoardDraw {
  kind: string;
  name: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  parentId?: string;
  intoFrameId?: string;
  font?: string;
  source?: unknown;
  children: Spec[];
}

export async function createBoard(ctx: HandlerContext): Promise<unknown> {
  const d = ctx.params as unknown as BoardDraw;
  const marker = MARKERS[d?.kind];
  if (!marker || !Array.isArray(d.children)) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      "create_board expects laid-out draw data (kind + children).",
      'Call it through the figma_diagram tool with type:"usecase" | "journey" | "persona".',
    );
  }
  const font = typeof d.font === "string" && d.font ? d.font : "Inter";
  // Validate every child BEFORE the frame opens: redrawing in place empties
  // the frame first, and a bad spec must not leave it wiped.
  for (const [i, c] of d.children.entries()) {
    if (!c || typeof c !== "object" || typeof c.type !== "string") {
      throw err(ErrorCode.INVALID_PARAMS, `create_board child ${i} has no type — nothing was changed.`, "Draw through figma_diagram.");
    }
  }
  await preloadDiagramFonts(ctx, font);
  const frame = await openDiagramFrame(
    ctx,
    {
      type: "FRAME",
      name: d.name,
      x: d.x,
      y: d.y,
      width: d.w,
      height: d.h,
      fill: "#ffffff",
      strokes: "#dfe4ea",
      strokeWeight: 1,
      cornerRadius: 16,
      clipsContent: false,
      ...(d.parentId ? { parentId: d.parentId } : {}),
    },
    d.intoFrameId,
  );
  let done = 0;
  for (const spec of d.children) {
    await createTree(sub(ctx, { ...withFont(spec, font), parentId: frame.id }), frame);
    done++;
    if (done % CHUNK === 0) ctx.progress(done, d.children.length, `drawing ${d.kind}`);
  }
  const nodes: Record<string, string> = {};
  const prefix = new RegExp(`^${d.kind}:([^\\s]+)`);
  for (const child of frame.children) {
    const hit = prefix.exec(child.name);
    if (hit && hit[1] && !nodes[hit[1]]) nodes[hit[1]] = child.id;
  }
  frame.setPluginData(
    marker,
    JSON.stringify({ kind: d.kind, title: d.title, nodes: Object.keys(nodes), ...(d.source !== undefined ? { source: d.source } : {}) }),
  );
  return {
    frameId: frame.id,
    pageModel: pageModel(frame),
    name: frame.name,
    nodes,
    box: { x: frame.x, y: frame.y, w: frame.width, h: frame.height },
  };
}

/** TEXT specs (at any depth) get the board's font unless they name one. */
function withFont(spec: Spec, font: string): Spec {
  const out: Spec = { ...spec };
  if (out.type === "TEXT" && out.fontFamily === undefined) out.fontFamily = font;
  if (Array.isArray(out.children)) out.children = (out.children as Spec[]).map((c) => withFont(c, font));
  return out;
}

function sub(ctx: HandlerContext, params: Spec): HandlerContext {
  return { params, warnings: ctx.warnings, progress: ctx.progress, warn: ctx.warn };
}
