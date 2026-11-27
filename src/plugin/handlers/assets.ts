/// <reference types="@figma/plugin-typings" />
import { HandlerContext, getNodeByIdSafe } from "../context.js";
import { resolveParent, insertInto } from "../insert.js";
import { serializeNode } from "../serialize.js";
import { hexToRgb } from "../color-util.js";
import { err } from "../errors.js";
import { ErrorCode } from "../../shared/protocol.js";
import { InsertAt, Inset } from "../layout-math.js";
import { childOrigin, parentSize, resolveInParent, rotatedGroupNote } from "./create.js";

import { decodeBase64 } from "../base64.js";
import { fitArtwork } from "../fit-artwork.js";
import { keepClearOnCanvas } from "../keep-clear.js";

/** Decode a base64 string to a Uint8Array (no Buffer/atob guarantee in the main-thread sandbox). */
export function base64ToBytes(b64: string): Uint8Array {
  return decodeBase64(b64);
}

/** Recolor every solid fill and stroke of a node subtree to `hex`. */
function recolorPaints(node: SceneNode, hex: string): void {
  const rgb = hexToRgb(hex);
  const stack: SceneNode[] = [node];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if ("fills" in n) {
      const fills = (n as GeometryMixin).fills;
      if (Array.isArray(fills) && fills.length > 0) {
        (n as GeometryMixin).fills = fills.map((f) =>
          f.type === "SOLID" ? { ...f, color: rgb } : f,
        );
      }
    }
    if ("strokes" in n) {
      const strokes = (n as GeometryMixin).strokes;
      if (Array.isArray(strokes) && strokes.length > 0) {
        (n as GeometryMixin).strokes = strokes.map((f) =>
          f.type === "SOLID" ? { ...f, color: rgb } : f,
        );
      }
    }
    if ("children" in n) stack.push(...(n as ChildrenMixin).children);
  }
}

/**
 * load_icon: createNodeFromSvg → resize → recolor → position/insert.
 * params: { svg, name?, size?, color?, parentId?, x?, y?, inset? }.
 */
export async function loadIcon(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const svg = typeof p.svg === "string" ? p.svg : "";
  if (!svg) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      "load_icon requires an svg string.",
      "Fetch the SVG markup (server-side searchIcons) and pass it as { svg }.",
    );
  }
  const node = figma.createNodeFromSvg(svg);
  node.name = typeof p.name === "string" ? p.name : "icon";
  const size = typeof p.size === "number" ? p.size : 24;
  fitArtwork(node, size);
  if (typeof p.color === "string") recolorPaints(node, p.color);

  const parent = await resolveParent(p.parentId);
  const frame = parentFrame(parent);
  insertInto(parent, node, p.insertAt as InsertAt | undefined);
  positionInParent(node, p, parent, frame, ctx.warn);
  // Straight onto a page or section: never over what is already there.
  keepClearOnCanvas(node, p, ctx);

  return { id: node.id, node: serializeNode(node, "compact") };
}

/**
 * load_image: figma.createImage(bytes) → paint onto a rectangle/frame fill.
 * params: { base64, name?, w?, h?, parentId?, x?, y?, inset?, scaleMode? }.
 */
export async function loadImage(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const b64 =
    typeof p.base64 === "string"
      ? p.base64
      : typeof p.bytes === "string"
        ? p.bytes
        : typeof p.source === "string"
          ? p.source
          : "";
  if (!b64) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      "load_image requires image bytes as base64.",
      "Read the image server-side and pass { base64 }.",
    );
  }
  const image = figma.createImage(base64ToBytes(b64));
  const { width, height } = await image.getSizeAsync();

  if (typeof p.replaceId === "string" && p.replaceId) return replaceImageFill(ctx, p.replaceId, image, { w: width, h: height });

  const rect = figma.createRectangle();
  rect.name = typeof p.name === "string" ? p.name : "image";
  const w = typeof p.w === "number" ? p.w : width;
  const h = typeof p.h === "number" ? p.h : height;
  rect.resize(Math.max(1, w), Math.max(1, h));
  const scaleMode = (typeof p.scaleMode === "string" ? p.scaleMode : "FILL") as
    | "FILL"
    | "FIT"
    | "CROP"
    | "TILE";
  rect.fills = [{ type: "IMAGE", scaleMode, imageHash: image.hash }];

  if (typeof p.besideId === "string" && p.besideId) {
    await placeBeside(ctx, rect, p.besideId, typeof p.w === "number" || typeof p.h === "number");
    return { id: rect.id, imageSize: { w: width, h: height }, besideId: p.besideId, node: serializeNode(rect, "compact") };
  }

  const parent = await resolveParent(p.parentId);
  const frame = parentFrame(parent);
  insertInto(parent, rect, p.insertAt as InsertAt | undefined);
  positionInParent(rect, p, parent, frame, ctx.warn);
  // Straight onto a page or section: never over what is already there.
  keepClearOnCanvas(rect, p, ctx);

  return {
    id: rect.id,
    imageSize: { w: width, h: height },
    node: serializeNode(rect, "compact"),
  };
}

/** Gap between an original and the copy placed beside it. */
const BESIDE_GAP = 24;

/**
 * Put a new image layer right of `refId`, at the reference's size, in the
 * reference's parent (just above it in the layer list). An auto-layout parent
 * places it itself; on a page or section it then keeps clear of everything else.
 */
async function placeBeside(ctx: HandlerContext, rect: RectangleNode, refId: string, sized: boolean): Promise<void> {
  const ref = await getNodeByIdSafe(refId);
  if (!ref || !("parent" in ref) || !ref.parent || ref.type === "PAGE" || ref.type === "DOCUMENT") {
    rect.remove();
    throw err(ErrorCode.NODE_NOT_FOUND, `Node ${refId} was not found (or is a page).`, "Read the selection again (get_selection) and pass a layer id.");
  }
  const scene = ref as SceneNode;
  if (!sized && "width" in scene && scene.width > 0 && scene.height > 0) rect.resize(scene.width, scene.height);
  const parent = scene.parent as BaseNode & ChildrenMixin;
  let into: BaseNode & ChildrenMixin = parent;
  try {
    parent.insertChild(parent.children.indexOf(scene) + 1, rect);
  } catch {
    // Inside an instance (or anything else that takes no new children): the
    // page, at the reference's absolute position.
    into = figma.currentPage;
    figma.currentPage.appendChild(rect);
  }
  const managed = "layoutMode" in into && (into as FrameNode).layoutMode !== "NONE";
  if (!managed) {
    const box = into === parent ? { x: scene.x, y: scene.y } : { x: scene.absoluteTransform[0][2], y: scene.absoluteTransform[1][2] };
    rect.x = box.x + scene.width + BESIDE_GAP;
    rect.y = box.y;
  }
  keepClearOnCanvas(rect, ctx.params, ctx);
}

/**
 * Swap the picture of an existing image layer (removeBackground mode
 * "replace"). The new image is a render of the WHOLE layer, so its old fills
 * all go; a layer with children is refused — they would show twice.
 */
async function replaceImageFill(ctx: HandlerContext, id: string, image: Image, size: { w: number; h: number }): Promise<unknown> {
  const node = await getNodeByIdSafe(id);
  if (!node || !("fills" in node)) {
    throw err(ErrorCode.NODE_NOT_FOUND, `Node ${id} was not found or has no fills.`, "Use mode \"beside\" for groups and other layers without fills.");
  }
  const fills = (node as GeometryMixin).fills;
  if (!Array.isArray(fills) || !fills.some((f: Paint) => f.type === "IMAGE")) {
    throw err(ErrorCode.INVALID_PARAMS, `"${node.name}" has no image fill to replace.`, "Use mode \"beside\" (the default): it places the cut-out next to the original.");
  }
  if ("children" in node && (node as ChildrenMixin).children.some((c) => c.visible)) {
    throw err(ErrorCode.INVALID_PARAMS, `"${node.name}" has visible children, which the cut-out already contains.`, "Use mode \"beside\", or run it on the image layer itself.");
  }
  (node as GeometryMixin).fills = [{ type: "IMAGE", scaleMode: "FILL", imageHash: image.hash }];
  const strokes = "strokes" in node ? (node as GeometryMixin).strokes : [];
  const effects = "effects" in node ? (node as BlendMixin).effects : [];
  if ((Array.isArray(strokes) && strokes.length) || (Array.isArray(effects) && effects.length)) {
    ctx.warn(`"${node.name}" has strokes or effects; they were rendered into the cut-out too and now show twice — remove them from the layer if so.`);
  }
  return { id: node.id, replaced: true, imageSize: size, node: serializeNode(node as SceneNode, "compact") };
}

/**
 * The parent's size and child origin, read BEFORE the new node goes in: a
 * group grows to fit its children, so measured afterwards it includes the
 * icon still sitting wherever it was created.
 */
function parentFrame(parent: BaseNode): {
  size: { w: number; h: number } | null;
  origin: { x: number; y: number };
} {
  return { size: parentSize(parent), origin: childOrigin(parent) };
}

function positionInParent(
  node: SceneNode,
  p: Record<string, unknown>,
  parent: BaseNode,
  frame: ReturnType<typeof parentFrame>,
  warn: (msg: string) => void,
): void {
  const managed =
    "layoutMode" in parent && (parent as FrameNode).layoutMode !== "NONE";
  if (managed) return;
  const pb = frame.size;
  if (p.inset && pb) {
    const rotated = rotatedGroupNote(parent);
    if (rotated) warn(rotated);
    const box = resolveInParent(
      {
        w: node.width,
        h: node.height,
        inset: p.inset as Inset,
        align: p.align as "center-x" | "center-y" | "center" | undefined,
      },
      pb,
      frame.origin,
    );
    node.x = box.x;
    node.y = box.y;
    return;
  }
  if (typeof p.x === "number") node.x = p.x;
  if (typeof p.y === "number") node.y = p.y;
}

/**
 * create_page: try figma.createPage(); on plan-limit failure return a
 * fallback descriptor instead of throwing mid-flow.
 */
export async function createPage(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  try {
    const page = figma.createPage();
    if (typeof p.name === "string") page.name = p.name;
    return { id: page.id, name: page.name, created: true };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    ctx.warn(
      `PAGE_LIMIT: could not create a new page (${reason}); using the current page.`,
    );
    return {
      created: false,
      fallback: "current-page",
      reason,
      id: figma.currentPage.id,
      name: figma.currentPage.name,
    };
  }
}

/** Switch the visible Figma page by id or exact name. */
export async function setCurrentPage(ctx: HandlerContext): Promise<unknown> {
  const pageId = typeof ctx.params.pageId === "string" ? ctx.params.pageId.trim() : "";
  const pageName = typeof ctx.params.name === "string" ? ctx.params.name.trim() : "";
  await figma.loadAllPagesAsync?.();
  let page: PageNode | null = null;
  if (pageId) {
    const node = await getNodeByIdSafe(pageId);
    if (node?.type === "PAGE") page = node;
  } else if (pageName) {
    const exact = figma.root.children.filter(
      (candidate) => candidate.name.toLowerCase() === pageName.toLowerCase(),
    );
    if (exact.length === 1) page = exact[0]!;
    else if (exact.length > 1) {
      throw err(
        ErrorCode.INVALID_PARAMS,
        `Multiple pages are named "${pageName}".`,
        "Call get_document_info and pass the exact pageId instead.",
      );
    } else {
      const needle = pageName.toLowerCase().replace(/[^a-z0-9]+/g, "");
      const fuzzy = figma.root.children.filter((candidate) => {
        const have = candidate.name.toLowerCase().replace(/[^a-z0-9]+/g, "");
        return have === needle || have.includes(needle) || needle.includes(have);
      });
      if (fuzzy.length === 1) page = fuzzy[0]!;
      if (fuzzy.length > 1) {
        throw err(
          ErrorCode.INVALID_PARAMS,
          `Several pages match "${pageName}": ${fuzzy.map((p) => p.name).join(", ")}.`,
          "Pass a more specific page name, or the pageId from get_document_info.",
        );
      }
    }
  }
  if (!page) {
    throw err(
      ErrorCode.NODE_NOT_FOUND,
      `Page ${pageId || JSON.stringify(pageName)} was not found.`,
      "Call get_document_info to list page ids and names.",
    );
  }
  // `figma.currentPage = page` is the pre-dynamic-page API. This plugin
  // declares `documentAccess: "dynamic-page"`, where the synchronous setter
  // does not take effect — it reported success and left the user on the page
  // they were already on, so everything drawn afterwards landed there.
  if (typeof figma.setCurrentPageAsync === "function") await figma.setCurrentPageAsync(page);
  else figma.currentPage = page;

  if (figma.currentPage.id !== page.id) {
    throw err(
      ErrorCode.INTERNAL,
      `Could not switch to "${page.name}" — still on "${figma.currentPage.name}".`,
      "Switch pages in the Figma UI, or pass parentId to draw into a specific frame.",
    );
  }
  return { id: page.id, name: page.name, current: true };
}

/**
 * create_overlay: a RECTANGLE (never a FRAME) sized to the parent's bounds,
 * with color + opacity, inserted at top by default.
 */
export async function createOverlay(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const parent = await resolveParent(p.parentId);
  const pb = parentSize(parent);
  // A group's children are in its containing frame's coordinates, so its own
  // top-left is where an overlay covering it starts — not 0,0. Read before
  // the insert, which grows the group around the rectangle.
  const origin = childOrigin(parent);
  const rect = figma.createRectangle();
  rect.name = typeof p.name === "string" ? p.name : "Overlay";
  if (pb) rect.resize(Math.max(1, pb.w), Math.max(1, pb.h));
  const color = typeof p.color === "string" ? p.color : "#000000";
  const opacity = typeof p.opacity === "number" ? p.opacity : 0.5;
  rect.fills = [{ type: "SOLID", color: hexToRgb(color) }];
  rect.opacity = opacity;

  const insertAt = (p.insertAt as InsertAt | undefined) ?? "top";
  insertInto(parent, rect, insertAt);
  const managed =
    "layoutMode" in parent && (parent as FrameNode).layoutMode !== "NONE";
  if (!managed) {
    rect.x = origin.x;
    rect.y = origin.y;
  }
  return { id: rect.id, node: serializeNode(rect, "compact") };
}
