/**
 * Figma REST features that have no Plugin API equivalent, or that must work
 * with the file CLOSED: comments, version history, and a design.md built
 * from a file nobody has open.
 *
 * Everything here takes a {@link RestClient} (reads, cached) or the hub's
 * fetch (writes), so the token, the activity log and the 401/429 handling
 * are the hub's — see rest-hub.ts. Responses are compacted for an agent:
 * comment threads instead of a flat list with parent ids, ISO dates, the
 * author's handle instead of a user object.
 */
import { ErrorCode, OpError } from "./errors.js";
import { REST_API_BASE, restError, type RestFetch } from "./rest-hub.js";
import type { RestClient } from "./rest-read.js";
import { renderDesignMarkdown, computeFingerprint, type DesignSystemKit, type DesignComponent, type DesignScreen } from "../shared/design-system.js";

type Json = Record<string, unknown>;

/** Server-answered read ops that need only a file key and the REST token. */
export const REST_ONLY_READ_OPS = ["get_comments", "get_versions"] as const;
export type RestOnlyReadOp = (typeof REST_ONLY_READ_OPS)[number];

export function isRestOnlyReadOp(op: string): op is RestOnlyReadOp {
  return (REST_ONLY_READ_OPS as readonly string[]).includes(op);
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export interface CompactComment {
  id: string;
  message: string;
  author?: string;
  createdAt?: string;
  resolvedAt?: string;
  /** The node a comment is pinned to, when it is pinned to one. */
  nodeId?: string;
  replies?: CompactComment[];
}

function compactComment(c: Json): CompactComment {
  const user = (c.user ?? {}) as Json;
  const meta = (c.client_meta ?? {}) as Json;
  const nodeId = typeof meta.node_id === "string" ? meta.node_id : undefined;
  return {
    id: String(c.id),
    message: String(c.message ?? ""),
    ...(typeof user.handle === "string" ? { author: user.handle } : {}),
    ...(typeof c.created_at === "string" ? { createdAt: c.created_at } : {}),
    ...(typeof c.resolved_at === "string" && c.resolved_at ? { resolvedAt: c.resolved_at } : {}),
    ...(nodeId ? { nodeId } : {}),
  };
}

/**
 * Threads, newest first. `nodeId` keeps the threads pinned to that node (or
 * inside it, when `nodeIds` lists its subtree); `unresolved` drops resolved
 * threads.
 */
export function threadComments(raw: unknown, opts: { nodeId?: string; nodeIds?: string[]; unresolved?: boolean; limit?: number } = {}): { threads: CompactComment[]; total: number; returned: number } {
  const list = (((raw ?? {}) as Json).comments ?? []) as Json[];
  const roots = new Map<string, CompactComment>();
  const replies: Array<{ parent: string; c: CompactComment }> = [];
  for (const c of list) {
    const cc = compactComment(c);
    const parent = typeof c.parent_id === "string" && c.parent_id ? c.parent_id : "";
    if (parent) replies.push({ parent, c: cc });
    else roots.set(cc.id, cc);
  }
  for (const { parent, c } of replies) {
    const root = roots.get(parent);
    if (root) (root.replies ??= []).push(c);
  }
  for (const r of roots.values()) r.replies?.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const want = opts.nodeIds?.length ? new Set(opts.nodeIds) : opts.nodeId ? new Set([opts.nodeId]) : null;
  let threads = [...roots.values()].filter((t) => (!want || (t.nodeId && want.has(t.nodeId))) && (!opts.unresolved || !t.resolvedAt));
  threads.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const total = threads.length;
  const limit = typeof opts.limit === "number" && opts.limit > 0 ? Math.floor(opts.limit) : 50;
  threads = threads.slice(0, limit);
  return { threads, total, returned: threads.length };
}

/**
 * Comment threads of a file. Filtered to one node ONLY when `nodeId` is
 * passed explicitly: a copied link almost always carries a node-id (the page
 * or whatever was selected), and filtering on it silently returned zero
 * threads for "the comments of this file". The link's node comes back as
 * `linkNodeId` so the caller can filter if that is what it meant.
 */
export async function getComments(client: RestClient, fileKey: string, params: Json, signal?: AbortSignal, linkNodeId?: string): Promise<unknown> {
  // Comments change while people talk — never the 60 s read cache.
  const raw = await client.get(`/files/${encodeURIComponent(fileKey)}/comments`, signal, { fresh: true });
  const nodeId = typeof params.nodeId === "string" && params.nodeId ? params.nodeId : undefined;
  const t = threadComments(raw, {
    ...(nodeId ? { nodeId } : {}),
    ...(params.unresolved === true ? { unresolved: true } : {}),
    ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
  });
  return {
    fileKey,
    ...t,
    ...(nodeId ? { nodeFilter: nodeId } : {}),
    ...(linkNodeId && !nodeId ? { linkNodeId, hint: `All threads of the file. Pass nodeId: "${linkNodeId}" to keep only those pinned to the node in the link.` } : {}),
    source: "rest",
  };
}

export interface PostCommentInput {
  message: string;
  /** Reply to this comment (thread root) instead of starting a thread. */
  replyTo?: string;
  /** Pin the new thread to a node (ignored for replies — Figma pins threads). */
  nodeId?: string;
  /** Offset inside that node, px. */
  x?: number;
  y?: number;
}

/** POST /v1/files/:key/comments. Throws with a next step on every failure. */
export async function postComment(fetchImpl: RestFetch, fileKey: string, input: PostCommentInput, signal?: AbortSignal): Promise<CompactComment & { fileKey: string }> {
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (!message) {
    throw new OpError(ErrorCode.INVALID_PARAMS, "postComment needs a non-empty `message`.", 'e.g. figma.postComment({ url, message: "Spacing here should be 16" }).');
  }
  if (message.length > 5000) {
    throw new OpError(ErrorCode.INVALID_PARAMS, "That comment is over 5,000 characters.", "Shorten it or split it into a thread of replies.");
  }
  const body: Json = { message };
  if (input.replyTo) body.comment_id = String(input.replyTo);
  else if (input.nodeId) {
    body.client_meta = { node_id: String(input.nodeId), node_offset: { x: Number(input.x ?? 0) || 0, y: Number(input.y ?? 0) || 0 } };
  }
  const res = await fetchImpl(`${REST_API_BASE}/files/${encodeURIComponent(fileKey)}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (res.status === 404) {
    throw new OpError(ErrorCode.NODE_NOT_FOUND, "Figma has no such file or comment (404).", "Check the link / fileKey, and that replyTo is the id of a comment in this file (figma_read get_comments).");
  }
  if (!res.ok) throw restError(res.status, await res.text().catch(() => ""), "post comments (file_comments:write)", res.headers);
  return { ...compactComment((await res.json()) as Json), fileKey };
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export function compactVersions(raw: unknown, limit = 30): { versions: Array<Json>; returned: number; hasMore: boolean } {
  const list = ((((raw ?? {}) as Json).versions ?? []) as Json[]).slice(0, Math.max(1, limit));
  const versions = list.map((v) => {
    const user = (v.user ?? {}) as Json;
    return {
      id: String(v.id),
      ...(typeof v.label === "string" && v.label ? { label: v.label } : {}),
      ...(typeof v.description === "string" && v.description ? { description: v.description } : {}),
      ...(typeof v.created_at === "string" ? { createdAt: v.created_at } : {}),
      ...(typeof user.handle === "string" ? { author: user.handle } : {}),
    };
  });
  const pagination = ((raw ?? {}) as Json).pagination as Json | undefined;
  return { versions, returned: versions.length, hasMore: !!pagination?.next_page };
}

export async function getVersions(client: RestClient, fileKey: string, params: Json, signal?: AbortSignal): Promise<unknown> {
  const raw = await client.get(`/files/${encodeURIComponent(fileKey)}/versions`, signal, { fresh: true });
  const limit = typeof params.limit === "number" && params.limit > 0 ? Math.min(200, Math.floor(params.limit)) : 30;
  const named = params.namedOnly === true;
  const out = compactVersions(raw, named ? 200 : limit);
  if (named) out.versions = out.versions.filter((v) => v.label).slice(0, limit);
  out.returned = out.versions.length;
  return { fileKey, ...out, source: "rest" };
}

// ---------------------------------------------------------------------------
// design.md for a file that is not open
// ---------------------------------------------------------------------------

function hex(c: { r: number; g: number; b: number; a?: number } | undefined, opacity = 1): string | undefined {
  if (!c) return undefined;
  const h = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  const a = (c.a ?? 1) * opacity;
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${a < 0.999 ? h(a) : ""}`;
}

const WEIGHT_NAMES: Record<number, string> = { 100: "Thin", 200: "Extra Light", 300: "Light", 400: "Regular", 500: "Medium", 600: "Semi Bold", 700: "Bold", 800: "Extra Bold", 900: "Black" };

/** "Semi Bold Italic" from a REST TypeStyle — Figma's own style name when it sends one. */
export function fontStyleName(st: Json): string | undefined {
  if (typeof st.fontStyle === "string" && st.fontStyle) return st.fontStyle;
  const w = typeof st.fontWeight === "number" ? WEIGHT_NAMES[Math.round(st.fontWeight / 100) * 100] : undefined;
  if (!w) return undefined;
  return st.italic ? (w === "Regular" ? "Italic" : `${w} Italic`) : w;
}

/** "Tone=primary, Size=lg" variant names → { Tone: [primary, …], Size: [lg, …] }. */
export function variantOptionsFrom(names: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const n of names) {
    for (const part of n.split(",")) {
      const [k, v] = part.split("=").map((x) => x?.trim());
      if (!k || v === undefined || v === "") continue;
      const list = (out[k] ??= []);
      if (!list.includes(v)) list.push(v);
    }
  }
  return out;
}

function paintsOf(node: Json | undefined): unknown[] {
  return ((node?.fills ?? []) as Json[])
    .filter((p) => p.visible !== false)
    .map((p) => (p.type === "SOLID" ? { type: "SOLID", color: hex(p.color as never, typeof p.opacity === "number" ? p.opacity : 1) } : { type: p.type }));
}

/**
 * The DesignSystemKit the plugin would collect, built from REST: pages and
 * top-level frames, published + local styles WITH values (read off the style
 * nodes), components and component sets. Variables need an Enterprise plan
 * through REST, so they are read only when asked (`includeVariables`).
 */
export async function restDesignKit(client: RestClient, fileKey: string, params: Json, signal?: AbortSignal): Promise<DesignSystemKit> {
  const key = encodeURIComponent(fileKey);
  const file = (await client.get(`/files/${key}?depth=2`, signal)) as Json;
  const pages = (((file.document as Json | undefined)?.children ?? []) as Json[]).filter((p) => p.type === "CANVAS");
  const notes: string[] = ["Built through the Figma REST API (file not open in Figma): no anatomy, instance usage or observed patterns — open the file with the plugin for those."];
  /**
   * A secondary read that may fail without sinking the whole design.md — but
   * never silently: each failure is a note in the output, so a design.md with
   * no components says WHY. A rate limit is not soft: the remaining reads
   * would fail the same way, and the error says when to come back.
   */
  let incomplete = false;
  const soft = async (path: string, what: string): Promise<Json> => {
    try {
      return (await client.get(path, signal)) as Json;
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code === ErrorCode.RATE_LIMITED) throw e;
      incomplete = true;
      notes.push(`${what} could not be read through REST, so this file is INCOMPLETE there: ${err.message ?? String(e)}`);
      return {};
    }
  };

  const screens: DesignScreen[] = [];
  for (const p of pages) {
    for (const f of (p.children ?? []) as Json[]) {
      if (f.type !== "FRAME" && f.type !== "SECTION") continue;
      const box = (f.absoluteBoundingBox ?? {}) as Json;
      screens.push({
        id: String(f.id),
        name: String(f.name),
        pageName: String(p.name),
        type: String(f.type),
        ...(typeof box.width === "number" ? { width: Math.round(box.width) } : {}),
        ...(typeof box.height === "number" ? { height: Math.round(box.height) } : {}),
        ...(typeof f.layoutMode === "string" && f.layoutMode !== "NONE" ? { layoutMode: f.layoutMode } : {}),
      });
    }
  }

  // Styles: metadata lists them; their VALUES live on the style nodes.
  const stylesMeta = (((await soft(`/files/${key}/styles`, "Published styles")).meta as Json | undefined)?.styles ?? []) as Json[];
  const fileStyles = (file.styles ?? {}) as Record<string, Json>;
  const styleList: Json[] = stylesMeta.length
    ? stylesMeta.map((s) => ({ id: s.node_id, name: s.name, styleType: s.style_type, description: s.description }))
    : Object.entries(fileStyles).map(([id, s]) => ({ id, name: s.name, styleType: s.styleType, description: s.description }));
  const valueById = new Map<string, Json>();
  const MAX_STYLE_VALUES = 300;
  const allStyleIds = styleList.map((s) => String(s.id)).filter((id) => /^\d+:\d+/.test(id));
  const ids = allStyleIds.slice(0, MAX_STYLE_VALUES);
  if (allStyleIds.length > ids.length) notes.push(`Only the first ${MAX_STYLE_VALUES} of ${allStyleIds.length} styles have their values read (REST quota); the rest are listed by name only.`);
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100);
    const res = await soft(`/files/${key}/nodes?ids=${encodeURIComponent(slice.join(","))}&depth=0`, "Style values");
    for (const [id, n] of Object.entries((res.nodes ?? {}) as Record<string, Json | null>)) if (n?.document) valueById.set(id, n.document as Json);
  }
  const styles: NonNullable<DesignSystemKit["styles"]> = { paint: [], text: [], effect: [], grid: [] };
  for (const s of styleList) {
    const node = valueById.get(String(s.id));
    const base = { name: s.name, ...(s.description ? { description: s.description } : {}) };
    if (s.styleType === "FILL") styles.paint!.push({ ...base, paints: paintsOf(node) });
    else if (s.styleType === "TEXT") {
      const st = (node?.style ?? {}) as Json;
      styles.text!.push({
        ...base,
        fontName: { family: st.fontFamily, style: fontStyleName(st) },
        fontSize: st.fontSize,
        ...(typeof st.lineHeightPx === "number" ? { lineHeight: Math.round(st.lineHeightPx * 100) / 100 } : {}),
        ...(typeof st.letterSpacing === "number" && st.letterSpacing ? { letterSpacing: st.letterSpacing } : {}),
      });
    } else if (s.styleType === "EFFECT") styles.effect!.push({ ...base, effects: (node?.effects ?? []) as unknown[] });
    else if (s.styleType === "GRID") styles.grid!.push({ ...base, layoutGrids: (node?.layoutGrids ?? []) as unknown[] });
  }

  // Components (published metadata first; local ones off the file JSON).
  const components: DesignComponent[] = [];
  const compMeta = (((await soft(`/files/${key}/components`, "Published components")).meta as Json | undefined)?.components ?? []) as Json[];
  const setMeta = (((await soft(`/files/${key}/component_sets`, "Published component sets")).meta as Json | undefined)?.component_sets ?? []) as Json[];
  const seen = new Set<string>();
  for (const s of setMeta) {
    const id = String(s.node_id);
    seen.add(id);
    components.push({ id, name: String(s.name), type: "COMPONENT_SET", ...(s.key ? { key: String(s.key) } : {}), ...(s.description ? { description: String(s.description) } : {}), ...(((s.containing_frame ?? {}) as Json).pageName ? { pageName: String(((s.containing_frame ?? {}) as Json).pageName) } : {}) });
  }
  for (const c of compMeta) {
    const id = String(c.node_id);
    const frame = (c.containing_frame ?? {}) as Json;
    const set = frame.containingComponentSet as Json | undefined;
    if (set) continue; // variants are described by their set
    if (seen.has(id)) continue;
    seen.add(id);
    components.push({ id, name: String(c.name), type: "COMPONENT", ...(c.key ? { key: String(c.key) } : {}), ...(c.description ? { description: String(c.description) } : {}), ...(frame.pageName ? { pageName: String(frame.pageName) } : {}) });
  }
  // Unpublished (local) components are only in the file JSON. Always merge
  // them: a file with SOME published components still has local ones.
  // `remote: true` entries are components of OTHER files (libraries) that
  // this file uses — not this file's own.
  for (const [id, s] of Object.entries((file.componentSets ?? {}) as Record<string, Json>)) {
    if (seen.has(id) || s.remote === true) continue;
    seen.add(id);
    components.push({ id, name: String(s.name), type: "COMPONENT_SET", ...(s.key ? { key: String(s.key) } : {}), ...(s.description ? { description: String(s.description) } : {}) });
  }
  for (const [id, c] of Object.entries((file.components ?? {}) as Record<string, Json>)) {
    if (c.componentSetId || seen.has(id) || c.remote === true) continue;
    seen.add(id);
    components.push({ id, name: String(c.name), type: "COMPONENT", ...(c.key ? { key: String(c.key) } : {}), ...(c.description ? { description: String(c.description) } : {}) });
  }

  // A set's variants: from the published metadata, else the file JSON.
  const variantsOf = new Map<string, Array<{ id: string; name: string; key?: string }>>();
  const addVariant = (setId: string, v: { id: string; name: string; key?: string }) => {
    const list = variantsOf.get(setId) ?? [];
    if (!list.some((x) => x.id === v.id)) list.push(v);
    variantsOf.set(setId, list);
  };
  for (const c of compMeta) {
    const set = ((c.containing_frame ?? {}) as Json).containingComponentSet as Json | undefined;
    if (set?.nodeId) addVariant(String(set.nodeId), { id: String(c.node_id), name: String(c.name), ...(c.key ? { key: String(c.key) } : {}) });
  }
  for (const [id, c] of Object.entries((file.components ?? {}) as Record<string, Json>)) {
    if (typeof c.componentSetId === "string") addVariant(c.componentSetId, { id, name: String(c.name), ...(c.key ? { key: String(c.key) } : {}) });
  }
  for (const comp of components) {
    const variants = comp.type === "COMPONENT_SET" ? variantsOf.get(comp.id) : undefined;
    if (!variants?.length) continue;
    comp.variants = variants;
    const opts = variantOptionsFrom(variants.map((v) => v.name));
    comp.componentPropertyDefinitions = Object.fromEntries(Object.entries(opts).map(([k, values]) => [k, { type: "VARIANT", defaultValue: values[0], variantOptions: values }]));
  }

  let variables: DesignSystemKit["variables"];
  if (params.includeVariables === true) {
    try {
      const v = (await client.get(`/files/${key}/variables/local`, signal)) as Json;
      const meta = (v.meta ?? {}) as Json;
      const collections = Object.values((meta.variableCollections ?? {}) as Record<string, Json>).map((c) => ({
        name: c.name,
        modes: c.modes,
        variables: Object.values((meta.variables ?? {}) as Record<string, Json>)
          .filter((x) => x.variableCollectionId === c.id)
          .map((x) => ({ name: x.name, type: x.resolvedType, description: x.description, valuesByMode: x.valuesByMode })),
      }));
      variables = { collections };
    } catch {
      notes.push("Variables could not be read through REST (it needs an Enterprise plan and the file_variables:read scope).");
    }
  }

  const maxComponents = typeof params.maxComponents === "number" && params.maxComponents > 0 ? Math.floor(params.maxComponents) : 200;
  return {
    file: { name: String(file.name ?? ""), key: fileKey, pages: pages.map((p) => ({ id: String(p.id), name: String(p.name) })) },
    styles,
    ...(variables ? { variables } : {}),
    components: components.slice(0, maxComponents),
    screens: screens.slice(0, 200),
    extraction: {
      scope: "document",
      pagesScanned: pages.length,
      totalComponents: components.length,
      returnedComponents: Math.min(components.length, maxComponents),
      omittedComponents: Math.max(0, components.length - maxComponents),
      totalScreens: screens.length,
      returnedScreens: Math.min(200, screens.length),
      includesScreens: true,
      includesComponentUsage: false,
      ...(incomplete ? { incomplete: true } : {}),
    },
    notes,
  };
}

export async function restGenerateDesignMd(client: RestClient, fileKey: string, params: Json, signal?: AbortSignal): Promise<unknown> {
  const kit = await restDesignKit(client, fileKey, params, signal);
  const markdown = renderDesignMarkdown(kit, {
    ...(typeof params.maxComponents === "number" ? { maxComponents: params.maxComponents } : {}),
    ...(typeof params.maxOutputChars === "number" ? { maxOutputChars: params.maxOutputChars } : {}),
  });
  const base = { markdown, fingerprint: computeFingerprint(kit), extraction: kit.extraction, source: "rest", fileKey };
  return params.includeJson === true ? { ...base, kit } : base;
}

/** Components / styles of a closed file, in the shape the design index stores. */
export async function restComponentsAndStyles(client: RestClient, fileKey: string, signal?: AbortSignal): Promise<{ fileName: string; components: DesignComponent[]; styles: Array<{ name: string; type: string; description?: string }> }> {
  const kit = await restDesignKit(client, fileKey, {}, signal);
  const styles: Array<{ name: string; type: string; description?: string }> = [];
  for (const [type, list] of Object.entries(kit.styles ?? {})) {
    for (const s of (list ?? []) as Json[]) styles.push({ name: String(s.name), type, ...(s.description ? { description: String(s.description) } : {}) });
  }
  return { fileName: kit.file?.name ?? fileKey, components: kit.components ?? [], styles };
}
