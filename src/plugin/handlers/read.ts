/// <reference types="@figma/plugin-typings" />
import { HandlerContext, requireNode, findNode } from "../context.js";
import {
  serializeNode,
  serializeTree,
  normalizeDetail,
  Detail,
  type SerializedNode,
} from "../serialize.js";
import { availableFonts } from "../fonts.js";
import { rgbToHex } from "../color-util.js";
import { r2 } from "../num.js";
import { nodeNotFound, err } from "../errors.js";
import { ErrorCode, BATCH_CHUNK_SIZE } from "../../shared/protocol.js";
import { listComponents } from "./design-system.js";
import { localVariables } from "./tokens.js";

/**
 * How many nodes one get_design_context may serialize. The depth limit alone
 * does not bound a page: three levels of a file with 400 top-level screens of
 * 40 layers each is 16 000 nodes, a response bigger than the agent's context.
 * The walk is breadth-first, so what survives the cap is the outline — every
 * screen before any screen's insides — which is the map the read is for.
 */
const DESIGN_CONTEXT_MAX_NODES = 3000;
/** scan_nodes_by_types' default cap — the same budget search_nodes keeps. */
const SCAN_TYPES_LIMIT = 200;

export async function getDocumentInfo(): Promise<unknown> {
  const page = figma.currentPage;
  return {
    fileName: figma.root.name,
    fileKey: (figma as unknown as { fileKey?: string }).fileKey ?? null,
    currentPage: { id: page.id, name: page.name, childCount: page.children.length },
    pages: figma.root.children.map((p) => ({ id: p.id, name: p.name })),
    editorType: figma.editorType,
    selection: page.selection.map((n) => n.id),
  };
}

export async function getSelection(ctx: HandlerContext): Promise<unknown> {
  const detail = normalizeDetail(ctx.params.detail);
  return {
    selection: figma.currentPage.selection.map((n) => serializeNode(n, detail)),
  };
}

/**
 * read_selection: the selection-first editing entry point. Deep-reads every
 * currently selected node in ONE call (full detail + depth by default) so an
 * agent can inspect what the user picked without a round-trip per node.
 */
export async function readSelection(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const detail: Detail = normalizeDetail(p.detail ?? "full");
  const depth = typeof p.depth === "number" ? p.depth : 3;
  const sel = figma.currentPage.selection;
  if (sel.length === 0) {
    return { count: 0, nodes: [], hint: "Select node(s) in Figma first." };
  }
  return {
    count: sel.length,
    nodes: sel.map((n) => serializeTree(n, detail, depth)),
  };
}

export async function getDesignContext(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const scoped = typeof p.nodeId === "string";
  // Page-level (no nodeId) can be an entire file — tens of thousands of tokens
  // at compact detail. Default the WHOLE-PAGE read to `sparse` (id/name/type/
  // geometry only) so the agent gets a cheap map to then drill into by nodeId.
  // A scoped read keeps the requested detail (default compact). An explicit
  // detail always wins.
  const detail = p.detail !== undefined ? normalizeDetail(p.detail) : scoped ? "compact" : "sparse";
  const maxDepth = typeof p.depth === "number" ? p.depth : 3;
  let root: BaseNode;
  if (scoped) {
    const n = await findNode(p.nodeId as string);
    if (!n) throw nodeNotFound(p.nodeId as string);
    root = n;
  } else {
    root = figma.currentPage;
  }
  // A PAGE (or the DOCUMENT) resolves by id while its children are not in
  // memory — under documentAccess:"dynamic-page" the walk then throws on
  // page.children. Load before serializing; an already-loaded page no-ops.
  if (root.type === "PAGE") {
    await (root as PageNode).loadAsync?.();
  } else if (root.type === "DOCUMENT") {
    for (const pg of (root as DocumentNode).children) await pg.loadAsync?.();
  }
  const maxNodes =
    typeof p.maxNodes === "number" && p.maxNodes > 0 ? Math.floor(p.maxNodes) : DESIGN_CONTEXT_MAX_NODES;
  const { tree, count, truncated } = serializeTreeCapped(root, detail, maxDepth, maxNodes);
  return {
    tree,
    ...(truncated
      ? {
          truncated: true,
          nodeCount: count,
          truncatedHint: `Stopped at ${count} nodes (maxNodes). The outline is complete down to the depth where it stopped; read one subtree with a nodeId, lower depth, or raise maxNodes.`,
        }
      : {}),
    ...(scoped
      ? {}
      : {
          hint: "Whole-page read (sparse). Pass a nodeId to deep-read one subtree, or detail:'compact'|'full' for more per-node data.",
        }),
  };
}

/**
 * serializeTree with a node budget. Breadth-first, so the cap cuts the
 * deepest layers first; a node whose children did not fit gets
 * `childrenTruncated` with its real child count, so the reader knows the
 * subtree is there and how to ask for it.
 */
export function serializeTreeCapped(
  root: BaseNode,
  detail: Detail,
  maxDepth: number,
  maxNodes: number,
): { tree: SerializedNode; count: number; truncated: boolean } {
  const tree = serializeNode(root, detail);
  let count = 1;
  let truncated = false;
  const queue: Array<{ node: BaseNode; depth: number; out: SerializedNode }> = [
    { node: root, depth: 0, out: tree },
  ];
  for (let head = 0; head < queue.length; head++) {
    const item = queue[head]!;
    if (item.depth >= maxDepth) continue;
    if (!("children" in item.node)) continue;
    const kids = (item.node as ChildrenMixin).children;
    if (kids.length === 0) continue;
    if (count + kids.length > maxNodes) {
      // All of a node's children or none of them: half a child list reads as
      // the whole list, and that is worse than a list marked missing.
      truncated = true;
      (item.out as Record<string, unknown>).childrenTruncated = kids.length;
      continue;
    }
    const childOut: SerializedNode[] = [];
    for (const kid of kids) {
      const so = serializeNode(kid, detail);
      childOut.push(so);
      queue.push({ node: kid, depth: item.depth + 1, out: so });
    }
    count += kids.length;
    item.out.children = childOut;
  }
  return { tree, count, truncated };
}

export async function getNode(ctx: HandlerContext): Promise<unknown> {
  const node = await requireNode(ctx.params.nodeId ?? ctx.params.id);
  // Single-node deep read: default to full detail like read_selection does.
  // (`normalizeDetail` alone lands on "compact" — it never returns falsy, so
  // the old `|| "full"` could never fire.)
  const detail = normalizeDetail(ctx.params.detail ?? "full");
  const out: Record<string, unknown> = { node: serializeNode(node, detail) };
  // figma.getChildren() forwards get_node with includeChildren:true.
  if (ctx.params.includeChildren === true && "children" in node) {
    out.children = (node as ChildrenMixin).children.map((c) =>
      serializeNode(c, detail),
    );
  }
  return out;
}

export async function getNodes(ctx: HandlerContext): Promise<unknown> {
  const ids: string[] = Array.isArray(ctx.params.nodeIds)
    ? ctx.params.nodeIds
    : [];
  const detail = normalizeDetail(ctx.params.detail);
  const nodes: unknown[] = [];
  for (const id of ids) {
    const n = await findNode(id);
    // A PAGE id resolves while the page is still unloaded — serializing it
    // reads .children, which throws under documentAccess:"dynamic-page".
    if (n && n.type === "PAGE") await (n as PageNode).loadAsync?.();
    if (n) nodes.push(serializeNode(n, detail));
    else nodes.push({ id, missing: true });
  }
  return { nodes };
}

export async function searchNodes(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  // `query` is the natural spelling agents reach for (find_component uses it
  // too); accept it as an alias for `name`. Also match TEXT content so
  // searching visible copy ("Sign in") finds the node, not just layer names.
  const nameQuery =
    typeof p.name === "string"
      ? p.name.toLowerCase()
      : typeof p.query === "string"
        ? p.query.toLowerCase()
        : undefined;
  const types = Array.isArray(p.types)
    ? (p.types as string[]).map((t) => t.toUpperCase())
    : undefined;
  // Default cap lowered 200 → 50: a 200-node compact dump is thousands of
  // tokens, and callers rarely need more than the top matches. Pass an explicit
  // `limit` to widen. When results are truncated we report `hasMore` so the
  // agent knows to narrow the query (or raise the limit) rather than assume the
  // list is complete.
  const limit = typeof p.limit === "number" ? p.limit : 50;
  const detail = normalizeDetail(p.detail);

  // Scope: search under nodeId when given (previously ignored — the whole
  // page came back regardless), else the current page.
  let scope: BaseNode & ChildrenMixin = figma.currentPage;
  if (typeof p.nodeId === "string") {
    const n = await requireNode(p.nodeId);
    // A leaf holds nothing to search; falling back to the whole page answered
    // a question the caller did not ask.
    if (!("children" in n)) return { count: 0, nodes: [] };
    scope = n as BaseNode & ChildrenMixin;
  }

  const results: unknown[] = [];
  // No callback when there is no filter: the editor skips a call back into
  // the plugin for every node of the page.
  const all = types
    ? scope.findAllWithCriteria({ types: types as NodeType[] })
    : scope.findAll();
  let matched = 0;
  let truncated = false;
  for (const n of all) {
    if (nameQuery) {
      const inName = n.name.toLowerCase().includes(nameQuery);
      const inText =
        n.type === "TEXT" &&
        (n as TextNode).characters.toLowerCase().includes(nameQuery);
      if (!inName && !inText) continue;
    }
    matched++;
    if (results.length >= limit) {
      truncated = true;
      continue;
    }
    results.push(serializeNode(n, detail));
  }
  return {
    count: results.length,
    nodes: results,
    ...(truncated
      ? {
          hasMore: true,
          totalMatched: matched,
          hint: `Showing ${results.length} of ${matched} matches. Narrow with a more specific query/types/nodeId scope, or pass a higher \`limit\`.`,
        }
      : {}),
  };
}

export async function scanTextNodes(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  let root: BaseNode & ChildrenMixin;
  if (typeof p.nodeId === "string") {
    const n = await requireNode(p.nodeId);
    if (!("children" in n)) return { textNodes: [] };
    root = n as BaseNode & ChildrenMixin;
  } else {
    root = figma.currentPage;
  }
  const all = root.findAllWithCriteria({ types: ["TEXT"] });
  const limit = typeof p.limit === "number" ? p.limit : 300;
  const texts = all.slice(0, limit);
  const truncated = all.length > texts.length;
  return {
    count: texts.length,
    ...(truncated ? { totalMatched: all.length, hasMore: true, hint: `Showing ${texts.length} of ${all.length} text nodes. Scope with a nodeId or raise \`limit\`.` } : {}),
    textNodes: texts.map((t) => ({
      id: t.id,
      name: t.name,
      characters:
        t.characters.length > 200 ? t.characters.slice(0, 200) + "…" : t.characters,
      x: r2(t.x),
      y: r2(t.y),
      w: r2(t.width),
      h: r2(t.height),
    })),
  };
}

export async function scanNodesByTypes(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const types = Array.isArray(p.types)
    ? (p.types as string[]).map((t) => t.toUpperCase())
    : ["FRAME"];
  const detail = normalizeDetail(p.detail);
  let root: BaseNode & ChildrenMixin;
  if (typeof p.nodeId === "string") {
    const n = await requireNode(p.nodeId);
    // A leaf (TEXT, RECTANGLE) has no findAllWithCriteria — it threw INTERNAL.
    if (!("children" in n)) return { count: 0, nodes: [] };
    root = n as BaseNode & ChildrenMixin;
  } else {
    root = figma.currentPage;
  }
  const found = root.findAllWithCriteria({ types: types as NodeType[] });
  // Capped like search_nodes: "every FRAME on the page" of a large file was
  // thousands of serialized nodes in one response.
  const limit = typeof p.limit === "number" && p.limit > 0 ? Math.floor(p.limit) : SCAN_TYPES_LIMIT;
  const shown = Math.min(found.length, limit);
  const out: unknown[] = [];
  for (let i = 0; i < shown; i++) {
    out.push(serializeNode(found[i]!, detail));
    if ((i + 1) % BATCH_CHUNK_SIZE === 0) {
      ctx.progress(i + 1, shown, "scanning");
    }
  }
  ctx.progress(shown, shown, "done");
  return {
    count: out.length,
    nodes: out,
    ...(found.length > shown
      ? {
          hasMore: true,
          totalMatched: found.length,
          hint: `Showing ${shown} of ${found.length} nodes. Scope with a nodeId or narrower types, or pass a higher \`limit\`.`,
        }
      : {}),
  };
}

export async function getStyles(): Promise<unknown> {
  const [paint, text, effect, grid] = await Promise.all([
    figma.getLocalPaintStylesAsync(),
    figma.getLocalTextStylesAsync(),
    figma.getLocalEffectStylesAsync(),
    figma.getLocalGridStylesAsync(),
  ]);
  return {
    paint: paint.map((s) => ({ id: s.id, name: s.name })),
    text: text.map((s) => ({ id: s.id, name: s.name })),
    effect: effect.map((s) => ({ id: s.id, name: s.name })),
    grid: grid.map((s) => ({ id: s.id, name: s.name })),
  };
}

export async function getVariables(): Promise<unknown> {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  // One fetch for every variable instead of an await per id.
  const byId = new Map((await localVariables()).map((v) => [v.id, v]));
  const out: unknown[] = [];
  for (const c of collections) {
    const modes = c.modes.map((m) => ({ id: m.modeId, name: m.name }));
    const variables: unknown[] = [];
    for (const id of c.variableIds) {
      const v = byId.get(id);
      if (!v) continue;
      const values: Record<string, unknown> = {};
      for (const m of c.modes) {
        const raw = v.valuesByMode[m.modeId];
        values[m.name] = formatVarValue(raw, v.resolvedType);
      }
      variables.push({ id: v.id, name: v.name, type: v.resolvedType, values });
    }
    out.push({ id: c.id, name: c.name, modes, variables });
  }
  return { collections: out };
}

function formatVarValue(raw: unknown, type: VariableResolvedDataType): unknown {
  if (raw === undefined) return null;
  if (type === "COLOR" && raw && typeof raw === "object" && "r" in raw) {
    const c = raw as RGBA;
    return rgbToHex(c);
  }
  if (raw && typeof raw === "object" && "type" in raw) {
    return { alias: (raw as VariableAlias).id };
  }
  return raw;
}

export async function getComponents(ctx: HandlerContext): Promise<unknown> {
  return listComponents(ctx.params);
}

export async function getFonts(ctx: HandlerContext): Promise<unknown> {
  const requested: string[] = Array.isArray(ctx.params.families)
    ? ctx.params.families
    : [];
  const all = await availableFonts();
  const byFamily = new Map<string, Set<string>>();
  for (const f of all) {
    const set = byFamily.get(f.family.toLowerCase()) ?? new Set<string>();
    set.add(f.style);
    byFamily.set(f.family.toLowerCase(), set);
  }
  if (requested.length === 0) {
    // Return a de-duplicated family list only (token-frugal).
    const families = [...new Set(all.map((f) => f.family))].sort();
    return { families };
  }
  const availability = requested.map((fam) => {
    const styles = byFamily.get(fam.toLowerCase());
    return {
      family: fam,
      available: !!styles,
      styles: styles ? [...styles] : [],
    };
  });
  return { availability };
}
