/// <reference types="@figma/plugin-typings" />
import { HandlerContext, requireNode } from "../context.js";
import { err } from "../errors.js";
import { ErrorCode } from "../../shared/protocol.js";

import { encodeBase64 } from "../base64.js";

/** Encode a byte array to base64 (no Buffer/btoa guarantee in the main-thread sandbox). */
export function bytesToBase64(bytes: Uint8Array): string {
  return encodeBase64(bytes);
}

/**
 * The longest side a screenshot may come back at. The default target is the
 * whole page, and a page of forty screens at the default scale was a
 * 30 000-pixel PNG — megabytes of base64 for a picture nobody can read at
 * that size anyway. Past this the scale is lowered to fit, and the caller is
 * told so.
 */
export const SCREENSHOT_MAX_SIDE = 4096;

/** The canvas area an export covers: the node's box, or everything on a page. */
export function exportBounds(node: BaseNode): Rect | null {
  const box = (node as { absoluteBoundingBox?: Rect | null }).absoluteBoundingBox;
  if (box) return box;
  if (node.type !== "PAGE") return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const child of (node as PageNode).children) {
    const b = child.absoluteBoundingBox;
    if (!b) continue;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  return maxX > minX && maxY > minY ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null;
}

/** screenshot: PNG of a node (or current page selection/root) at `scale`. */
export async function screenshot(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  let scale = typeof p.scale === "number" ? p.scale : 0.6;
  let node: SceneNode | PageNode;
  if (typeof p.nodeId === "string") {
    node = await requireNode(p.nodeId);
  } else if (figma.currentPage.selection.length === 1) {
    node = figma.currentPage.selection[0]!;
  } else {
    node = figma.currentPage;
  }
  const bounds = exportBounds(node);
  const side = bounds ? Math.max(bounds.width, bounds.height) : 0;
  if (side > 0 && side * scale > SCREENSHOT_MAX_SIDE) {
    const asked = scale;
    scale = SCREENSHOT_MAX_SIDE / side;
    ctx.warn(
      `At scale ${asked} "${node.name}" would be ${Math.round(side * asked)}px on its longest side; scaled to ${Math.round(scale * 1000) / 1000} to stay within ${SCREENSHOT_MAX_SIDE}px. Pass a nodeId to look at one part closer.`,
    );
  }
  const bytes = await (node as ExportMixin).exportAsync({
    format: "PNG",
    constraint: { type: "SCALE", value: scale },
  });
  return {
    format: "PNG",
    scale,
    nodeId: node.id,
    base64: bytesToBase64(bytes),
  };
}

/** export_node: PNG/SVG/JPG/PDF export of a node → base64. */
export async function exportNode(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const node = await requireNode(p.nodeId ?? p.id);
  const fmt = String(p.format ?? "PNG").toUpperCase();
  const scale = typeof p.scale === "number" ? p.scale : 1;

  let settings: ExportSettings;
  switch (fmt) {
    case "PNG":
      settings = { format: "PNG", constraint: { type: "SCALE", value: scale } };
      break;
    case "JPG":
    case "JPEG":
      settings = { format: "JPG", constraint: { type: "SCALE", value: scale } };
      break;
    case "SVG":
      settings = { format: "SVG" };
      break;
    case "PDF":
      settings = { format: "PDF" };
      break;
    default:
      throw err(
        ErrorCode.INVALID_PARAMS,
        `Unsupported export format "${fmt}".`,
        "Use PNG, JPG, SVG or PDF.",
      );
  }
  const bytes = await (node as ExportMixin).exportAsync(settings);
  return {
    format: fmt === "JPEG" ? "JPG" : fmt,
    nodeId: node.id,
    base64: bytesToBase64(bytes),
  };
}
