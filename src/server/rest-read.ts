/**
 * Reading a Figma file through the REST API when the file is not open in
 * Figma — compacted into the SAME shape the plugin's reads return.
 *
 * The REST JSON is the reason "link + token" was expensive: every node carries
 * every property (absoluteRenderBounds, constraints, blendMode, full paint
 * objects with defaults…), ~1–3 KB a node. Here a node becomes the plugin's
 * sparse/compact/design shape — x/y relative to the parent, colours as hex,
 * defaults dropped — so an agent reading through REST pays roughly what it
 * pays through the plugin.
 *
 * Supported: get_document_info, get_node, get_nodes, get_design_context,
 * generate_design_md (rest-features.ts), screenshot, export_node. Anything else needs the plugin and says so.
 */
import { describeMotion } from "../shared/motion.js";
import { ErrorCode, OpError } from "./errors.js";
import { restGenerateDesignMd } from "./rest-features.js";
import { restError, retryDelayMs } from "./rest-hub.js";

export type { RestFetch } from "./rest-hub.js";
import type { RestFetch } from "./rest-hub.js";
export type Detail = "sparse" | "compact" | "full" | "design";

const BASE = "https://api.figma.com/v1";
const CACHE_TTL_MS = 60_000;
export const REST_MAX_NODES = 3000;
const SCREENSHOT_MAX_SIDE = 4096;

export const REST_READ_OPS = new Set(["get_document_info", "get_node", "get_nodes", "get_design_context", "screenshot", "export_node", "generate_design_md"]);

type Json = Record<string, unknown>;

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        rej(new Error("cancelled"));
      },
      { once: true },
    );
  });
}

export class RestClient {
  private cache = new Map<string, { at: number; value: Promise<unknown> }>();
  constructor(
    private readonly token: string,
    private readonly fetchImpl: RestFetch = (u, i) => fetch(u, i),
  ) {}

  /** GET with the token; 429 retried with Retry-After; errors that say what to do. Cached 60 s. */
  get(path: string, signal?: AbortSignal, opts: { fresh?: boolean } = {}): Promise<unknown> {
    if (opts.fresh) return this.fetchJson(path, signal);
    const hit = this.cache.get(path);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
    const value = this.fetchJson(path, signal);
    this.cache.set(path, { at: Date.now(), value });
    value.catch(() => this.cache.delete(path));
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value as string);
    return value;
  }

  private async fetchJson(path: string, signal?: AbortSignal): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(`${BASE}${path}`, { headers: { "X-Figma-Token": this.token }, ...(signal ? { signal } : {}) });
      if (res.status === 429) {
        const ms = retryDelayMs(res.headers, attempt);
        if (ms !== null) {
          await wait(ms, signal);
          continue;
        }
      }
      if (!res.ok) throw restError(res.status, await res.text().catch(() => ""), "read this file", res.headers);
      return res.json();
    }
  }
}

// ---------------------------------------------------------------------------
// Compaction: REST node → the plugin's serialized shape
// ---------------------------------------------------------------------------

const r2 = (n: number) => Math.round(n * 100) / 100;

function hex(c: { r: number; g: number; b: number; a?: number }, opacity = 1): string {
  const h = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  const a = (c.a ?? 1) * opacity;
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${a < 0.999 ? h(a) : ""}`;
}

function firstSolid(paints: unknown): string | undefined {
  if (!Array.isArray(paints)) return undefined;
  for (const p of paints as Json[]) {
    if (p.type === "SOLID" && p.visible !== false && p.color) return hex(p.color as { r: number; g: number; b: number; a?: number }, typeof p.opacity === "number" ? p.opacity : 1);
  }
  return undefined;
}

function compactPaints(paints: unknown): unknown[] | undefined {
  if (!Array.isArray(paints) || !paints.length) return undefined;
  const out: unknown[] = [];
  for (const p of paints as Json[]) {
    if (p.visible === false) continue;
    if (p.type === "SOLID" && p.color) out.push(hex(p.color as { r: number; g: number; b: number; a?: number }, typeof p.opacity === "number" ? p.opacity : 1));
    else if (p.type === "IMAGE") out.push({ type: "IMAGE", scaleMode: p.scaleMode });
    else if (typeof p.type === "string" && p.type.startsWith("GRADIENT_")) {
      out.push({ type: p.type, stops: (p.gradientStops as Json[] | undefined)?.map((s) => ({ position: r2(Number(s.position)), color: hex(s.color as { r: number; g: number; b: number; a?: number }) })) });
    } else out.push({ type: p.type });
  }
  return out.length ? out : undefined;
}

interface Ctx {
  detail: Detail;
  components: Record<string, { name?: string }>;
  styles: Record<string, { name?: string; styleType?: string }>;
  count: number;
  truncated: boolean;
}

function serialize(node: Json, parentBox: Json | undefined, c: Ctx): Json {
  const box = node.absoluteBoundingBox as Json | undefined;
  const out: Json = { id: node.id, name: node.name, type: node.type };
  if (box) {
    out.x = r2(Number(box.x) - (parentBox ? Number(parentBox.x) : 0));
    out.y = r2(Number(box.y) - (parentBox ? Number(parentBox.y) : 0));
    out.w = r2(Number(box.width));
    out.h = r2(Number(box.height));
  }
  if (c.detail === "sparse") return out;
  if (node.visible === false) out.visible = false;
  if (typeof node.opacity === "number" && node.opacity !== 1) out.opacity = r2(node.opacity);
  if (node.layoutMode && node.layoutMode !== "NONE") {
    out.layoutMode = node.layoutMode;
    out.itemSpacing = node.itemSpacing ?? 0;
    out.padding = { l: node.paddingLeft ?? 0, r: node.paddingRight ?? 0, t: node.paddingTop ?? 0, b: node.paddingBottom ?? 0 };
    if (node.primaryAxisSizingMode) out.primaryAxisSizingMode = node.primaryAxisSizingMode;
    if (node.counterAxisSizingMode) out.counterAxisSizingMode = node.counterAxisSizingMode;
    if (node.primaryAxisAlignItems && node.primaryAxisAlignItems !== "MIN") out.primaryAxisAlignItems = node.primaryAxisAlignItems;
    if (node.counterAxisAlignItems && node.counterAxisAlignItems !== "MIN") out.counterAxisAlignItems = node.counterAxisAlignItems;
  }
  if (node.clipsContent) out.clipsContent = true;
  if (node.type === "TEXT") {
    const chars = String(node.characters ?? "");
    out.characters = c.detail === "compact" && chars.length > 120 ? `${chars.slice(0, 120)}…` : chars;
    const st = (node.style ?? {}) as Json;
    if (typeof st.fontSize === "number") out.fontSize = st.fontSize;
  }
  const fill = firstSolid(node.fills);
  if (fill) out.fill = fill;
  if (Array.isArray(node.children)) out.childCount = node.children.length;
  if (node.type === "INSTANCE" && typeof node.componentId === "string") {
    out.componentId = node.componentId;
    const comp = c.components[node.componentId];
    if (comp?.name) out.component = comp.name;
  }
  if (c.detail === "compact") return out;

  // Prototype motion of a closed file, the plugin's shape (full/design, as there).
  if (Array.isArray(node.interactions) && node.interactions.length) {
    const motion = describeMotion(node.interactions as unknown[], "ms");
    if (motion.length) out.motion = motion;
  }
  if (typeof node.cornerRadius === "number" && node.cornerRadius !== 0) out.cornerRadius = node.cornerRadius;
  else if (Array.isArray(node.rectangleCornerRadii)) out.cornerRadii = node.rectangleCornerRadii;
  const strokes = compactPaints(node.strokes);
  if (strokes) {
    out.strokes = strokes;
    if (typeof node.strokeWeight === "number") out.strokeWeight = node.strokeWeight;
  }
  if (c.detail !== "design") return out;

  const fills = compactPaints(node.fills);
  if (fills && (fills.length > 1 || typeof fills[0] !== "string")) out.fills = fills;
  if (Array.isArray(node.effects) && node.effects.length) {
    out.effects = (node.effects as Json[])
      .filter((e) => e.visible !== false)
      .map((e) => ({ type: e.type, ...(typeof e.radius === "number" ? { radius: e.radius } : {}), ...(e.color ? { color: hex(e.color as { r: number; g: number; b: number; a?: number }) } : {}), ...(e.offset ? { offset: e.offset } : {}), ...(typeof e.spread === "number" && e.spread ? { spread: e.spread } : {}) }));
  }
  if (node.type === "TEXT") {
    const st = (node.style ?? {}) as Json;
    const t: Json = { fontFamily: st.fontFamily, fontWeight: st.fontWeight, fontSize: st.fontSize };
    if (st.italic) t.italic = true;
    if (typeof st.lineHeightPx === "number" && st.lineHeightUnit !== "INTRINSIC_%") t.lineHeight = r2(st.lineHeightPx);
    if (typeof st.letterSpacing === "number" && st.letterSpacing !== 0) t.letterSpacing = r2(st.letterSpacing);
    if (st.textAlignHorizontal && st.textAlignHorizontal !== "LEFT") t.textAlign = st.textAlignHorizontal;
    if (st.textCase && st.textCase !== "ORIGINAL") t.textCase = st.textCase;
    if (st.textDecoration && st.textDecoration !== "NONE") t.textDecoration = st.textDecoration;
    out.typography = t;
  }
  const styleRefs = node.styles as Record<string, string> | undefined;
  if (styleRefs) {
    const named: Json = {};
    for (const [k, id] of Object.entries(styleRefs)) named[k] = c.styles[id]?.name ?? id;
    out.styles = named;
  }
  if (node.boundVariables && typeof node.boundVariables === "object" && Object.keys(node.boundVariables).length) {
    out.boundVariables = Object.keys(node.boundVariables as Json);
  }
  if (node.componentProperties) {
    out.componentProperties = Object.fromEntries(Object.entries(node.componentProperties as Record<string, Json>).map(([k, v]) => [k, v.value]));
  }
  if (node.componentPropertyDefinitions) {
    out.componentPropertyDefinitions = Object.fromEntries(
      Object.entries(node.componentPropertyDefinitions as Record<string, Json>).map(([k, v]) => [k, { type: v.type, defaultValue: v.defaultValue, ...(v.variantOptions ? { variantOptions: v.variantOptions } : {}) }]),
    );
  }
  return out;
}

/** Breadth-first, depth- and count-limited — the plugin's get_design_context rules. */
export function compactTree(root: Json, detail: Detail, maxDepth: number, maxNodes: number, components: Ctx["components"] = {}, styles: Ctx["styles"] = {}): { tree: Json; count: number; truncated: boolean } {
  const c: Ctx = { detail, components, styles, count: 0, truncated: false };
  const rootOut = serialize(root, undefined, c);
  c.count = 1;
  const queue: Array<{ node: Json; out: Json; depth: number }> = [{ node: root, out: rootOut, depth: 0 }];
  while (queue.length) {
    const { node, out, depth } = queue.shift()!;
    const kids = node.children as Json[] | undefined;
    if (!Array.isArray(kids) || !kids.length || depth >= maxDepth) continue;
    const childOut: Json[] = [];
    for (const k of kids) {
      if (c.count >= maxNodes) {
        c.truncated = true;
        out.childrenTruncated = true;
        break;
      }
      const so = serialize(k, node.absoluteBoundingBox as Json | undefined, c);
      c.count++;
      childOut.push(so);
      queue.push({ node: k, out: so, depth: depth + 1 });
    }
    if (childOut.length) out.children = childOut;
  }
  return { tree: rootOut, count: c.count, truncated: c.truncated };
}

function detailOf(v: unknown, fallback: Detail): Detail {
  return v === "sparse" || v === "compact" || v === "full" || v === "design" ? v : fallback;
}

function depthOf(v: unknown, fallback: number): number {
  return typeof v === "number" && v >= 0 ? Math.min(12, Math.floor(v)) : fallback;
}

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------

export interface RestReadDeps {
  client: RestClient;
  /** Download an image URL the REST API handed back (SSRF-checked fetch). */
  download: (url: string) => Promise<Uint8Array>;
  signal?: AbortSignal;
}

async function nodesById(fileKey: string, ids: string[], depth: number | undefined, d: RestReadDeps): Promise<Json> {
  const q = new URLSearchParams({ ids: ids.join(",") });
  if (depth !== undefined) q.set("depth", String(depth));
  return (await d.client.get(`/files/${encodeURIComponent(fileKey)}/nodes?${q}`, d.signal)) as Json;
}

function docOf(res: Json, id: string): { document: Json; components: Ctx["components"]; styles: Ctx["styles"] } {
  const n = (res.nodes as Record<string, Json | null> | undefined)?.[id];
  if (!n || !n.document) {
    throw new OpError(ErrorCode.NODE_NOT_FOUND, `Node "${id}" is not in this file.`, "Copy the link again from Figma (right-click → Copy link to selection).");
  }
  return { document: n.document as Json, components: (n.components ?? {}) as Ctx["components"], styles: (n.styles ?? {}) as Ctx["styles"] };
}

export async function restRead(op: string, params: Json, fileKey: string, d: RestReadDeps): Promise<unknown> {
  const source = { source: "rest", fileKey };
  if (op === "get_document_info") {
    const f = (await d.client.get(`/files/${encodeURIComponent(fileKey)}?depth=1`, d.signal)) as Json;
    const pages = (((f.document as Json | undefined)?.children ?? []) as Json[]).map((p) => ({ id: p.id, name: p.name }));
    return { fileName: f.name, lastModified: f.lastModified, version: f.version, pages, ...source };
  }
  if (op === "get_nodes") {
    const ids = (params.nodeIds as string[] | undefined) ?? [];
    const detail = detailOf(params.detail, "compact");
    const res = await nodesById(fileKey, ids, 1, d);
    return {
      nodes: ids.map((id) => {
        const n = (res.nodes as Record<string, Json | null> | undefined)?.[id];
        return n?.document ? compactTree(n.document as Json, detail, 0, 1, (n.components ?? {}) as Ctx["components"], (n.styles ?? {}) as Ctx["styles"]).tree : { id, missing: true };
      }),
      ...source,
    };
  }
  const nodeId = String(params.nodeId ?? "");
  if (op === "get_node" || op === "get_design_context") {
    if (!nodeId) {
      throw new OpError(ErrorCode.INVALID_PARAMS, `Reading "${op}" through the REST API needs a node.`, "Use a link copied with Copy link to selection (it carries ?node-id=…), or pass nodeId.");
    }
    const detail = detailOf(params.detail, op === "get_node" ? "compact" : "compact");
    const depth = depthOf(params.depth, op === "get_node" ? (params.includeChildren ? 1 : 0) : 2);
    const maxNodes = typeof params.maxNodes === "number" && params.maxNodes > 0 ? Math.min(20_000, params.maxNodes) : REST_MAX_NODES;
    const res = await nodesById(fileKey, [nodeId], depth + 1, d);
    const { document, components, styles } = docOf(res, nodeId);
    const t = compactTree(document, detail, depth, maxNodes, components, styles);
    if (op === "get_node") {
      const { children, ...node } = t.tree;
      return { node, ...(children ? { children } : {}), ...source };
    }
    return { tree: t.tree, nodeCount: t.count, ...(t.truncated ? { truncated: true } : {}), ...source };
  }
  if (op === "generate_design_md") {
    return restGenerateDesignMd(d.client, fileKey, params, d.signal);
  }
  if (op === "screenshot" || op === "export_node") {
    if (!nodeId) throw new OpError(ErrorCode.INVALID_PARAMS, "A REST render needs a node.", "Use a link with ?node-id=…, or pass nodeId.");
    const format = op === "screenshot" ? "png" : String(params.format ?? "PNG").toLowerCase().replace("jpeg", "jpg");
    let scale = typeof params.scale === "number" ? params.scale : op === "screenshot" ? 0.6 : 1;
    const warnings: string[] = [];
    if (format === "png" || format === "jpg") {
      const res = await nodesById(fileKey, [nodeId], 0, d);
      const box = docOf(res, nodeId).document.absoluteBoundingBox as Json | undefined;
      const side = box ? Math.max(Number(box.width), Number(box.height)) : 0;
      if (side > 0 && side * scale > SCREENSHOT_MAX_SIDE) {
        scale = SCREENSHOT_MAX_SIDE / side;
        warnings.push(`Scaled to ${r2(scale)} to stay within ${SCREENSHOT_MAX_SIDE}px.`);
      }
    }
    const q = new URLSearchParams({ ids: nodeId, format, ...(format === "png" || format === "jpg" ? { scale: String(Math.max(0.01, Math.min(4, scale))) } : {}) });
    const img = (await d.client.get(`/images/${encodeURIComponent(fileKey)}?${q}`, d.signal)) as { err?: string | null; images?: Record<string, string | null> };
    if (img.err) throw new OpError(ErrorCode.INTERNAL, `Figma could not render: ${img.err}`);
    const url = img.images?.[nodeId];
    if (!url) throw new OpError(ErrorCode.NODE_NOT_FOUND, "Figma returned no image for this node.", "Hidden or empty nodes do not render.");
    const bytes = await d.download(url);
    const fmt = format.toUpperCase();
    const base = { format: fmt, nodeId, base64: Buffer.from(bytes).toString("base64"), ...source };
    const result = op === "screenshot" ? { ...base, scale } : base;
    return warnings.length ? { result, warnings } : result;
  }
  throw new OpError(
    ErrorCode.UNSUPPORTED_OPERATION,
    `"${op}" needs the file open in Figma with the plugin running; the REST fallback reads get_document_info, get_node, get_nodes, get_design_context, generate_design_md, screenshot and export_node.`,
    "Open the file in Figma Desktop and run Figma Plugin MCP, then call again with the same link.",
  );
}
