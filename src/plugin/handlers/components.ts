/// <reference types="@figma/plugin-typings" />
/**
 * Components and instances: find, create, combine as variants, author
 * component properties, instantiate and edit instances.
 *
 * Every op takes components by NAME as readily as by id — names are what
 * survive between sessions (see figma_rules: "consume by name, never by id").
 * Name resolution is exact (case/separator-insensitive); a near miss is an
 * error that lists the closest names, never a silent guess.
 */
import { HandlerContext, getNodeByIdSafe, requireNode } from "../context.js";
import { resolveParent, insertInto } from "../insert.js";
import { serializeNode } from "../serialize.js";
import { err } from "../errors.js";
import { ErrorCode } from "../../shared/protocol.js";
import { InsertAt } from "../layout-math.js";
import { keepClearOnCanvas } from "../keep-clear.js";
import { normalizeName, rankCandidates } from "../fuzzy.js";
import {
  buildOverrideSummary,
  flattenComponentProperties,
  planPropertyPatch,
  propertyValueStuck,
  resolvePropertyKey,
  type ComponentPropertyEntry,
  type PropertyValue,
} from "../edit-util.js";
import { structureSignatureAtDepth, type StructNode } from "../structure-sig.js";
import { layoutVariantGrid, parseVariantName, variantMatches, variantName } from "../variant-grid.js";
import { create } from "./create.js";
import { modify } from "./write.js";
import { loadNodeFonts } from "../fonts.js";
import { checkMap, mapFromFigma, mapToTypeScript, type ComponentMap, type FigmaComponentInfo } from "../../shared/component-map.js";

type AnyComponent = ComponentNode | ComponentSetNode;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function subCtx(ctx: HandlerContext, params: Record<string, unknown>): HandlerContext {
  return { params, warnings: ctx.warnings, progress: ctx.progress, warn: ctx.warn };
}

/** Run a Figma API call; its plain Error becomes an actionable INVALID_PARAMS. */
function figmaCall<T>(what: string, fn: () => T, hint: string): T {
  try {
    return fn();
  } catch (e) {
    throw err(ErrorCode.INVALID_PARAMS, `${what} failed: ${e instanceof Error ? e.message : String(e)}`, hint);
  }
}

function isVariant(node: BaseNode): boolean {
  return node.type === "COMPONENT" && node.parent?.type === "COMPONENT_SET";
}

/** Is `node` inside an INSTANCE (its layers cannot be restructured)? */
function insideInstance(node: BaseNode): boolean {
  let p = node.parent;
  while (p) {
    if (p.type === "INSTANCE") return true;
    p = p.parent;
  }
  return false;
}

interface Listed {
  id: string;
  name: string;
  node: AnyComponent;
}

/**
 * Every local component a caller can name: component sets, plain components,
 * and each variant as "<Set>/<Size=sm, State=default>" so a variant can be
 * found directly too.
 */
async function listLocalComponents(scope: "page" | "file"): Promise<Listed[]> {
  if (scope === "file") await figma.loadAllPagesAsync?.();
  const root: DocumentNode | PageNode = scope === "file" ? figma.root : figma.currentPage;
  const found = root.findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] }) as AnyComponent[];
  const out: Listed[] = [];
  for (const n of found) {
    if (isVariant(n)) out.push({ id: n.id, name: `${n.parent!.name}/${n.name}`, node: n });
    else out.push({ id: n.id, name: n.name, node: n });
  }
  return out;
}

/** Names within a couple of typos of `want` (already normalized), closest first. */
function closeSpellings(want: string, all: Listed[]): string[] {
  const max = Math.max(1, Math.min(3, Math.floor(want.length / 3)));
  return all
    .map((c) => ({ name: c.name, d: editDistance(want, normalizeName(c.name), max) }))
    .filter((x) => x.d <= max)
    .sort((a, b) => a.d - b.d)
    .slice(0, 5)
    .map((x) => x.name);
}

/** Levenshtein distance, giving up (returns cap+1) once it exceeds `cap`. */
function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

async function findByName(name: string): Promise<{ exact: Listed | null; near: string[] }> {
  const want = normalizeName(name);
  for (const scope of ["page", "file"] as const) {
    const all = await listLocalComponents(scope);
    const exact = all.filter((c) => normalizeName(c.name) === want);
    if (exact.length > 0) {
      // A set and its own default variant never collide (variants carry the
      // set prefix), so several exact hits are genuinely distinct components.
      return { exact: exact[0]!, near: exact.length > 1 ? exact.map((c) => `${c.name} (${c.id})`) : [] };
    }
    if (scope === "file") {
      // Variants only crowd the hint ("Button/Size=sm, …" four times over)
      // unless the caller was asking for one.
      const pool = name.includes("=") ? all : all.filter((c) => !isVariant(c.node));
      // Closest spelling first: "Buton" is one letter from "Button", while the
      // word overlap ranks every "SmokeTest/…" alike and then by length.
      const ranked = rankCandidates(name, pool, 8)
        .map((s) => s.candidate.name)
        .sort((a, b) => editDistance(want, normalizeName(a), 99) - editDistance(want, normalizeName(b), 99))
        .slice(0, 5);
      return { exact: null, near: ranked.length ? ranked : closeSpellings(want, pool) };
    }
  }
  return { exact: null, near: [] };
}

/**
 * Resolve a component reference: a node id, a name, or a library key.
 * Returns the COMPONENT or COMPONENT_SET.
 */
async function resolveComponentRef(
  ref: unknown,
  ctx: HandlerContext,
  opts: { key?: unknown } = {},
): Promise<AnyComponent> {
  if (typeof opts.key === "string" && opts.key.trim()) {
    const key = opts.key.trim();
    try {
      return await figma.importComponentByKeyAsync(key);
    } catch {
      try {
        return await figma.importComponentSetByKeyAsync(key);
      } catch (e) {
        throw err(
          ErrorCode.NODE_NOT_FOUND,
          `Could not import a library component with key "${key}" (${e instanceof Error ? e.message : String(e)}).`,
          "The key must belong to a PUBLISHED library this file can use. For local components pass the name or id instead.",
        );
      }
    }
  }
  if (typeof ref !== "string" || ref.trim() === "") {
    throw err(
      ErrorCode.INVALID_PARAMS,
      "A component reference is required (component name, id, or key).",
      'Pass e.g. "Button" or "Button/Size=sm, State=default", a node id like "12:34", or { key } for a library component.',
    );
  }
  const s = ref.trim();
  if (/^I?\d+:\d+/.test(s)) {
    const node = await getNodeByIdSafe(s);
    if (node && (node.type === "COMPONENT" || node.type === "COMPONENT_SET")) return node as AnyComponent;
    if (node && node.type === "INSTANCE") {
      const main = await (node as InstanceNode).getMainComponentAsync();
      if (main) {
        ctx.warn(`"${s}" is an INSTANCE; used its main component "${main.name}".`);
        return main;
      }
    }
    if (node) {
      throw err(
        ErrorCode.INVALID_PARAMS,
        `Node "${s}" is a ${node.type}, not a component.`,
        "Pass a COMPONENT or COMPONENT_SET id — find_component lists them — or componentize the node first.",
      );
    }
  }
  const { exact, near } = await findByName(s);
  if (exact) {
    if (near.length > 1) ctx.warn(`"${s}" names ${near.length} components; used the first. Candidates: ${near.join(", ")}.`);
    return exact.node;
  }
  throw err(
    ErrorCode.NODE_NOT_FOUND,
    `No local component named "${s}".`,
    near.length
      ? `Closest names: ${near.join(", ")}. Names match ignoring case and separators; use find_component to search.`
      : "This file has no matching component. Create one with findOrCreateComponent / componentize, or pass a library { key }.",
  );
}

/** Pick the variant of a set matching `wanted`; default variant when none asked. */
function pickVariant(set: ComponentSetNode, wanted: unknown): ComponentNode {
  const variants = set.children.filter((c): c is ComponentNode => c.type === "COMPONENT");
  if (!wanted || typeof wanted !== "object" || Object.keys(wanted).length === 0) {
    return set.defaultVariant ?? variants[0]!;
  }
  const w = wanted as Record<string, unknown>;
  const hit = variants.find((v) => variantMatches(parseVariantName(v.name), w));
  if (hit) return hit;
  // Partial request (only Size given): start from the default variant's other
  // values, so { Size: "lg" } means "the default, but large".
  const base = parseVariantName((set.defaultVariant ?? variants[0]!).name);
  const merged = { ...base };
  for (const [k, v] of Object.entries(w)) {
    const key = Object.keys(base).find((b) => b.toLowerCase() === k.toLowerCase()) ?? k;
    merged[key] = String(v);
  }
  const fallback = variants.find((v) => variantMatches(parseVariantName(v.name), merged));
  if (fallback) return fallback;
  throw err(
    ErrorCode.INVALID_PARAMS,
    `Component set "${set.name}" has no variant matching ${JSON.stringify(w)}.`,
    `Available variants: ${variants.map((v) => v.name).join(" | ")}.`,
  );
}

/** Component or set that owns property definitions for `node`. */
function propertyOwner(node: BaseNode, ctx: HandlerContext): AnyComponent {
  if (node.type === "COMPONENT_SET") return node as ComponentSetNode;
  if (node.type === "COMPONENT") {
    if (isVariant(node)) {
      ctx.warn(`"${node.name}" is a variant; component properties live on its set "${node.parent!.name}".`);
      return node.parent as ComponentSetNode;
    }
    return node as ComponentNode;
  }
  throw err(
    ErrorCode.INVALID_PARAMS,
    `Node "${node.id}" is a ${node.type}; component properties belong to a COMPONENT or COMPONENT_SET.`,
    "Pass the component (or set) id or name. To change an instance's values use setInstanceProperties.",
  );
}

async function requireComponent(ref: unknown, ctx: HandlerContext): Promise<AnyComponent> {
  return resolveComponentRef(ref, ctx);
}

async function requireInstance(id: unknown): Promise<InstanceNode> {
  const node = await requireNode(id);
  if (node.type !== "INSTANCE") {
    throw err(
      ErrorCode.INVALID_PARAMS,
      `Node "${node.id}" is a ${node.type}, not an INSTANCE.`,
      "Pass an instance id — instantiate() returns one; search_nodes with types:[\"INSTANCE\"] finds existing ones.",
    );
  }
  return node as InstanceNode;
}

/**
 * Find a layer inside `root` by id, by "A/B/C" name path, or by name anywhere
 * in the subtree (first match, warned when ambiguous).
 */
function findLayer(root: BaseNode, target: string, ctx: HandlerContext): SceneNode | null {
  const all = "findAll" in root ? (root as ChildrenMixin).findAll(() => true) : [];
  const byId = all.find((n) => n.id === target || n.id.endsWith(`;${target}`));
  if (byId) return byId;
  if (target.includes("/") && "children" in root) {
    let cur: BaseNode | undefined = root;
    for (const part of target.split("/").map((s) => s.trim())) {
      const kids: readonly SceneNode[] = cur && "children" in cur ? (cur as ChildrenMixin).children : [];
      cur = kids.find((k) => k.name === part) ?? kids.find((k) => k.name.toLowerCase() === part.toLowerCase());
      if (!cur) break;
    }
    if (cur && cur !== root) return cur as SceneNode;
  }
  const exact = all.filter((n) => n.name === target);
  const hits = exact.length ? exact : all.filter((n) => n.name.toLowerCase() === target.toLowerCase());
  if (hits.length > 1) ctx.warn(`"${target}" matches ${hits.length} layers in "${root.name}"; used the first. Use an "A/B" path or an id to be exact.`);
  return hits[0] ?? null;
}

function describeComponent(c: AnyComponent): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: c.id,
    name: isVariant(c) ? `${c.parent!.name}/${c.name}` : c.name,
    type: c.type,
    key: (c as ComponentNode).key,
  };
  if (c.description) out.description = c.description;
  if (c.type === "COMPONENT_SET") {
    const set = c as ComponentSetNode;
    out.variantCount = set.children.length;
    out.defaultVariantId = set.defaultVariant?.id;
    try {
      out.variantOptions = set.variantGroupProperties
        ? Object.fromEntries(Object.entries(set.variantGroupProperties).map(([k, v]) => [k, v.values]))
        : undefined;
    } catch {
      /* unreadable on a broken set */
    }
  }
  if (isVariant(c)) {
    out.setId = c.parent!.id;
    out.variant = parseVariantName(c.name);
  }
  try {
    const owner = c.type === "COMPONENT_SET" || !isVariant(c) ? c : (c.parent as ComponentSetNode);
    const defs = owner.componentPropertyDefinitions;
    out.properties = Object.fromEntries(
      Object.entries(defs)
        .filter(([, d]) => d.type !== "VARIANT")
        .map(([k, d]) => [k, { type: d.type, defaultValue: d.defaultValue }]),
    );
  } catch {
    /* definitions unreadable (broken set) */
  }
  const page = pageOf(c);
  if (page) out.page = page.name;
  return out;
}

function pageOf(node: BaseNode): PageNode | null {
  let p: BaseNode | null = node;
  while (p && p.type !== "PAGE") p = p.parent;
  return (p as PageNode | null) ?? null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** find_component: rank local components (and variants) by name. */
export async function findComponent(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const query = String(p.query ?? p.name ?? "").trim();
  const limit = typeof p.limit === "number" && p.limit > 0 ? Math.min(100, Math.floor(p.limit)) : 10;
  const includeVariants = p.includeVariants === true;
  const all = (await listLocalComponents(p.scope === "page" ? "page" : "file")).filter(
    (c) => includeVariants || !isVariant(c.node),
  );
  if (!query) {
    return { count: Math.min(limit, all.length), total: all.length, matches: all.slice(0, limit).map((c) => describeComponent(c.node)) };
  }
  const ranked = rankCandidates(query, all, limit);
  // A variant query ("Button/Size=lg") is worth answering even when variants
  // were not asked for.
  if (ranked.length === 0 && !includeVariants && query.includes("=")) {
    const variants = (await listLocalComponents("file")).filter((c) => isVariant(c.node));
    ranked.push(...rankCandidates(query, variants, limit));
  }
  return {
    count: ranked.length,
    total: all.length,
    matches: ranked.map((s) => ({ ...describeComponent(s.candidate.node), score: s.score, match: s.reason })),
  };
}

/** get_instance_overrides: what an instance changed relative to its main component. */
export async function getInstanceOverrides(ctx: HandlerContext): Promise<unknown> {
  const inst = await requireInstance(ctx.params.nodeId);
  const main = await inst.getMainComponentAsync();
  const overrides = (inst.overrides ?? []).map((o) => ({ id: o.id, fields: [...o.overriddenFields] }));
  const summary = buildOverrideSummary({
    sourceInstanceId: inst.id,
    mainComponentId: main?.id ?? null,
    overriddenNodeIds: overrides.map((o) => o.id),
    componentProperties: flattenComponentProperties(
      inst.componentProperties as unknown as Record<string, { type?: string; value?: unknown }>,
    ),
    exposedInstanceIds: (inst.exposedInstances ?? []).map((n) => n.id),
  });
  return {
    ...summary,
    mainComponent: main ? { id: main.id, name: isVariant(main) ? `${main.parent!.name}/${main.name}` : main.name } : null,
    propertyTypes: Object.fromEntries(
      Object.entries(inst.componentProperties ?? {}).map(([k, v]) => [k, v.type]),
    ),
    overrides,
  };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** find_or_create_component: reuse a component by exact name, else create it from spec. */
export async function findOrCreateComponent(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const name = String(p.name ?? "").trim();
  if (!name) {
    throw err(ErrorCode.INVALID_PARAMS, "find_or_create_component requires a name.", 'Pass { name: "Button/Primary", spec: { ... } }.');
  }
  const { exact } = await findByName(name);
  if (exact) return { id: exact.id, created: false, component: describeComponent(exact.node) };
  const spec = (p.spec && typeof p.spec === "object" ? p.spec : {}) as Record<string, unknown>;
  const made = (await create(
    subCtx(ctx, {
      ...spec,
      ...(p.parentId !== undefined && spec.parentId === undefined ? { parentId: p.parentId } : {}),
      ...(p.placeGroup !== undefined ? { placeGroup: p.placeGroup } : {}),
      type: "COMPONENT",
      name,
    }),
  )) as { id: string; node: unknown };
  const node = (await getNodeByIdSafe(made.id)) as ComponentNode | null;
  if (node && typeof p.description === "string") node.description = p.description;
  return { id: made.id, created: true, component: node ? describeComponent(node) : made.node };
}

/** componentize: turn a node into a component; optionally swap its copies for instances. */
export async function componentize(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const node = await requireNode(p.nodeId);
  if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
    throw err(ErrorCode.INVALID_PARAMS, `"${node.name}" is already a ${node.type}.`, "Instantiate it instead.");
  }
  if (node.type === "INSTANCE") {
    throw err(
      ErrorCode.INVALID_PARAMS,
      `"${node.name}" is an INSTANCE.`,
      "detachInstance it first, or use its main component.",
    );
  }
  if (insideInstance(node)) {
    throw err(ErrorCode.INVALID_PARAMS, `"${node.name}" is inside an instance and cannot be converted.`, "Detach the instance first.");
  }
  // Read BEFORE converting: the node becomes a COMPONENT (and may be replaced).
  const sig = structureSignatureAtDepth(toStruct(node));
  const srcType = node.type;
  const srcName = node.name;
  const component = figmaCall(
    "createComponentFromNode",
    () => figma.createComponentFromNode(node),
    "Only frames, groups and shapes outside instances/components can become components.",
  );
  if (typeof p.name === "string" && p.name.trim()) component.name = p.name.trim();
  if (typeof p.description === "string") component.description = p.description;

  const replaced: Array<{ oldId: string; newId: string }> = [];
  if (p.replaceCopies === true) {
    const scopeRoot: BaseNode & ChildrenMixin =
      p.scope === "parent" && component.parent && "findAll" in component.parent
        ? (component.parent as BaseNode & ChildrenMixin)
        : (pageOf(component) ?? figma.currentPage);
    const max = typeof p.maxCopies === "number" && p.maxCopies > 0 ? Math.floor(p.maxCopies) : 200;
    const copies = scopeRoot
      .findAll(
        (n) =>
          n.id !== component.id &&
          n.type === srcType &&
          n.name === srcName &&
          !insideComponentOrInstance(n) &&
          structureSignatureAtDepth(toStruct(n)) === sig,
      )
      .slice(0, max);
    for (let i = 0; i < copies.length; i++) {
      const copy = copies[i]!;
      if (copy.removed) continue;
      const inst = component.createInstance();
      replaceWithInstance(copy, inst);
      await copyTextOverrides(copy, inst, ctx);
      replaced.push({ oldId: copy.id, newId: inst.id });
      copy.remove();
      if ((i + 1) % 20 === 0) ctx.progress(i + 1, copies.length, "replacing copies");
    }
    if (copies.length >= max) ctx.warn(`Stopped at ${max} copies; raise maxCopies to replace more.`);
  }
  return { id: component.id, replacedCount: replaced.length, replaced, component: describeComponent(component) };
}

function insideComponentOrInstance(n: BaseNode): boolean {
  let p = n.parent;
  while (p) {
    if (p.type === "INSTANCE" || p.type === "COMPONENT" || p.type === "COMPONENT_SET") return true;
    p = p.parent;
  }
  return false;
}

function toStruct(n: BaseNode): StructNode {
  const out: StructNode = { type: n.type, name: n.name };
  if ("children" in n) {
    const kids = (n as ChildrenMixin).children;
    if (kids.length) out.children = kids.map(toStruct);
  }
  return out;
}

/** Put `inst` exactly where `old` sits: same parent, index, position, size and layout role. */
function replaceWithInstance(old: SceneNode, inst: InstanceNode): void {
  const parent = old.parent as (BaseNode & ChildrenMixin) | null;
  if (parent) parent.insertChild(parent.children.indexOf(old), inst);
  const o = old as SceneNode & LayoutMixin;
  if ("x" in o) {
    inst.x = o.x;
    inst.y = o.y;
  }
  if ("width" in o && (Math.abs(inst.width - o.width) > 0.5 || Math.abs(inst.height - o.height) > 0.5)) {
    try {
      inst.resize(o.width, o.height);
    } catch {
      /* fixed-size instance */
    }
  }
  for (const k of ["layoutAlign", "layoutGrow", "layoutPositioning", "constraints", "visible", "rotation"] as const) {
    if (k in o) {
      try {
        (inst as unknown as Record<string, unknown>)[k] = (o as unknown as Record<string, unknown>)[k];
      } catch {
        /* not settable here */
      }
    }
  }
}

/** Copies differ in their words, not their structure: carry text across. */
async function copyTextOverrides(from: SceneNode, to: InstanceNode, ctx: HandlerContext): Promise<void> {
  const src = "findAll" in from ? (from as ChildrenMixin).findAll((n) => n.type === "TEXT") : [];
  const dst = to.findAll((n) => n.type === "TEXT");
  for (let i = 0; i < Math.min(src.length, dst.length); i++) {
    const a = src[i] as TextNode;
    const b = dst[i] as TextNode;
    if (a.characters === b.characters) continue;
    try {
      await loadNodeFonts(b);
      b.characters = a.characters;
    } catch (e) {
      ctx.warn(`Could not carry text "${a.characters.slice(0, 30)}" into the instance: ${e instanceof Error ? e.message : String(e)}.`);
    }
  }
}

/** create_variants: build (or gather) components and combine them into a set. */
export async function createVariants(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const variants = Array.isArray(p.variants) ? (p.variants as Array<Record<string, unknown>>) : [];
  const ids = Array.isArray(p.componentIds) ? (p.componentIds as unknown[]) : [];
  if (variants.length === 0 && ids.length === 0) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      "create_variants needs variants or componentIds.",
      'Pass { name: "Button", variants: [{ props: { Size: "sm" }, spec: {...} }, ...] } or { name, componentIds: [...] }.',
    );
  }
  const parent = await resolveParent(p.parentId);
  const components: ComponentNode[] = [];
  const createdHere: ComponentNode[] = [];
  const fail = (e: unknown): never => {
    for (const c of createdHere) {
      try {
        c.remove();
      } catch {
        /* gone */
      }
    }
    throw e;
  };

  try {
    for (const raw of ids) {
      const c = await getNodeByIdSafe(String(raw));
      if (!c || c.type !== "COMPONENT") {
        throw err(ErrorCode.INVALID_PARAMS, `componentIds: "${String(raw)}" is not a COMPONENT.`, "Componentize the node first.");
      }
      if (isVariant(c)) {
        throw err(ErrorCode.INVALID_PARAMS, `"${c.name}" already belongs to set "${c.parent!.name}".`, "Pass components that are not in a set yet.");
      }
      components.push(c as ComponentNode);
    }
    for (let i = 0; i < variants.length; i++) {
      const v = variants[i] ?? {};
      const props = (v.props ?? v.properties ?? v.variant) as Record<string, unknown> | undefined;
      let name: string;
      try {
        name = variantName(props ?? {});
      } catch (e) {
        throw err(ErrorCode.INVALID_PARAMS, `variants[${i}]: ${(e as Error).message}`, 'Each variant needs props like { Size: "sm", State: "default" }.');
      }
      if (typeof v.componentId === "string") {
        const c = await getNodeByIdSafe(v.componentId);
        if (!c || c.type !== "COMPONENT" || isVariant(c)) {
          throw err(ErrorCode.INVALID_PARAMS, `variants[${i}].componentId is not a free COMPONENT.`, "Pass a component that is not in a set yet.");
        }
        c.name = name;
        components.push(c as ComponentNode);
        continue;
      }
      const spec = (v.spec && typeof v.spec === "object" ? v.spec : {}) as Record<string, unknown>;
      const made = (await create(
        subCtx(ctx, { ...spec, type: "COMPONENT", name, parentId: parent.id, allowOverlap: true }),
      )) as { id: string };
      const node = (await getNodeByIdSafe(made.id)) as ComponentNode;
      createdHere.push(node);
      components.push(node);
      ctx.progress(i + 1, variants.length, "building variants");
    }
    // Names given for componentIds-only input become variant names when they
    // are not already "Prop=value".
    for (const c of components) {
      if (!c.name.includes("=")) c.name = `Variant=${c.name.replace(/[=,]/g, " ").trim() || "Default"}`;
    }
    const names = components.map((c) => c.name);
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) throw err(ErrorCode.INVALID_PARAMS, `Two variants are both "${dup}".`, "Every variant needs a distinct combination of property values.");
  } catch (e) {
    fail(e);
  }

  const set = figmaCall(
    "combineAsVariants",
    () => figma.combineAsVariants(components, parent),
    "All variants must be COMPONENTs that can be reparented (not inside instances).",
  );
  if (typeof p.name === "string" && p.name.trim()) set.name = p.name.trim();
  if (typeof p.description === "string") set.description = p.description;
  if (typeof p.x === "number") set.x = p.x;
  if (typeof p.y === "number") set.y = p.y;
  styleSet(set, p);
  const grid = arrange(set, p, ctx);
  keepClearOnCanvas(set, p, ctx);
  return {
    id: set.id,
    name: set.name,
    variants: set.children.map((c) => ({ id: c.id, name: c.name })),
    layout: { rowsBy: grid.rowsBy, columnsBy: grid.columnsBy },
    component: describeComponent(set),
  };
}

/** Figma's own look for a set — a dashed purple outline — unless styled otherwise. */
function styleSet(set: ComponentSetNode, p: Record<string, unknown>): void {
  if (p.setStyle === false) return;
  try {
    if (!set.strokes || set.strokes.length === 0) {
      set.strokes = [{ type: "SOLID", color: { r: 0.592, g: 0.278, b: 1 } }];
      set.strokeWeight = 1;
      set.dashPattern = [10, 5];
    }
    set.cornerRadius = 5;
  } catch {
    /* cosmetic only */
  }
}

function arrange(set: ComponentSetNode, p: Record<string, unknown>, ctx: HandlerContext) {
  const kids = set.children.filter((c): c is ComponentNode => c.type === "COMPONENT");
  let valueOrder: Record<string, string[]> | undefined;
  try {
    valueOrder = Object.fromEntries(Object.entries(set.variantGroupProperties).map(([k, v]) => [k, v.values]));
  } catch {
    valueOrder = undefined;
  }
  const grid = layoutVariantGrid(
    kids.map((k) => ({ id: k.id, w: k.width, h: k.height, props: parseVariantName(k.name) })),
    {
      ...(typeof p.rowsBy === "string" ? { rowsBy: p.rowsBy } : {}),
      ...(typeof p.columnsBy === "string" ? { columnsBy: p.columnsBy } : {}),
      ...(typeof p.gap === "number" ? { gap: p.gap } : {}),
      ...(typeof p.padding === "number" ? { padding: p.padding } : {}),
      ...(valueOrder ? { valueOrder } : {}),
    },
  );
  if (set.layoutMode && set.layoutMode !== "NONE") {
    ctx.warn(`"${set.name}" uses auto-layout; its variants are placed by it, not by a grid.`);
    return grid;
  }
  const byId = new Map(kids.map((k) => [k.id, k]));
  for (const pos of grid.positions) {
    const k = byId.get(pos.id);
    if (!k) continue;
    k.x = pos.x;
    k.y = pos.y;
  }
  set.resizeWithoutConstraints(grid.width, grid.height);
  return grid;
}

/** arrange_component_set: lay a set's variants out in a tidy grid. */
export async function arrangeComponentSet(ctx: HandlerContext): Promise<unknown> {
  const c = await requireComponent(ctx.params.nodeId, ctx);
  const set = c.type === "COMPONENT_SET" ? c : isVariant(c) ? (c.parent as ComponentSetNode) : null;
  if (!set) {
    throw err(ErrorCode.INVALID_PARAMS, `"${c.name}" is not a component set.`, "Pass a COMPONENT_SET (or one of its variants).");
  }
  const grid = arrange(set, ctx.params, ctx);
  return { id: set.id, width: grid.width, height: grid.height, rowsBy: grid.rowsBy, columnsBy: grid.columnsBy };
}

/** set_component_description: description (+ one documentation link). */
export async function setComponentDescription(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const c = await requireComponent(p.nodeId, ctx);
  if (typeof p.description === "string") c.description = p.description;
  const link = typeof p.link === "string" ? p.link : Array.isArray(p.links) ? p.links[0] : undefined;
  if (typeof link === "string") {
    figmaCall("documentationLinks", () => (c.documentationLinks = link ? [{ uri: link }] : []), "Pass a full http(s) URL.");
  }
  return { id: c.id, description: c.description, documentationLinks: c.documentationLinks?.map((l) => l.uri) ?? [] };
}

// ---------------------------------------------------------------------------
// Component properties
// ---------------------------------------------------------------------------

const PROP_TYPES = ["BOOLEAN", "TEXT", "INSTANCE_SWAP", "VARIANT", "SLOT"] as const;
const BIND_FIELD: Record<string, "visible" | "characters" | "mainComponent"> = {
  BOOLEAN: "visible",
  TEXT: "characters",
  INSTANCE_SWAP: "mainComponent",
};

async function preferredValues(raw: unknown, ctx: HandlerContext): Promise<InstanceSwapPreferredValue[] | undefined> {
  if (!Array.isArray(raw)) return undefined;
  const out: InstanceSwapPreferredValue[] = [];
  for (const r of raw) {
    const c = await resolveComponentRef(r, ctx);
    out.push({ type: c.type === "COMPONENT_SET" ? "COMPONENT_SET" : "COMPONENT", key: (c as ComponentNode).key });
  }
  return out;
}

/** An INSTANCE_SWAP value is a component id; accept a name too. */
async function swapValue(raw: unknown, ctx: HandlerContext): Promise<string> {
  const c = await resolveComponentRef(raw, ctx);
  if (c.type === "COMPONENT_SET") return (c as ComponentSetNode).defaultVariant.id;
  return c.id;
}

function currentDefs(owner: AnyComponent): Record<string, ComponentPropertyEntry> {
  return owner.componentPropertyDefinitions as unknown as Record<string, ComponentPropertyEntry>;
}

function requireKey(owner: AnyComponent, name: unknown): string {
  const m = resolvePropertyKey(currentDefs(owner), String(name ?? ""));
  if (!m.key) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      `${m.error ?? "Unknown property"} (on "${owner.name}")`,
      m.candidates?.length ? `Properties: ${m.candidates.join(", ")}.` : "This component has no properties yet.",
    );
  }
  return m.key;
}

/** Bind a property to layers: in each variant of a set, the layer with that name/path. */
function bindProperty(
  owner: AnyComponent,
  key: string,
  type: string,
  bind: unknown,
  ctx: HandlerContext,
): Array<{ id: string; name: string; field: string }> {
  const list = Array.isArray(bind) ? bind : bind === undefined ? [] : [bind];
  const bound: Array<{ id: string; name: string; field: string }> = [];
  const scopes: BaseNode[] = owner.type === "COMPONENT_SET" ? [...owner.children] : [owner];
  for (const entry of list) {
    const target =
      typeof entry === "string" ? entry : String((entry as Record<string, unknown>)?.target ?? (entry as Record<string, unknown>)?.nodeId ?? "");
    const field = (
      typeof entry === "object" && entry && typeof (entry as Record<string, unknown>).field === "string"
        ? (entry as Record<string, unknown>).field
        : BIND_FIELD[type]
    ) as "visible" | "characters" | "mainComponent" | undefined;
    if (!target || !field) {
      ctx.warn(`Skipped a bind entry with no target or field (${JSON.stringify(entry)}).`);
      continue;
    }
    let hits = 0;
    for (const scope of scopes) {
      const layer = findLayer(scope, target, ctx);
      if (!layer) continue;
      if (field === "characters" && layer.type !== "TEXT") {
        ctx.warn(`"${layer.name}" is a ${layer.type}; a TEXT property binds to TEXT layers.`);
        continue;
      }
      if (field === "mainComponent" && layer.type !== "INSTANCE") {
        ctx.warn(`"${layer.name}" is a ${layer.type}; an INSTANCE_SWAP property binds to INSTANCE layers.`);
        continue;
      }
      figmaCall(
        "componentPropertyReferences",
        () => {
          layer.componentPropertyReferences = { ...(layer.componentPropertyReferences ?? {}), [field]: key };
        },
        "The layer must be inside this component (not inside a nested instance).",
      );
      bound.push({ id: layer.id, name: layer.name, field });
      hits++;
    }
    if (hits === 0) ctx.warn(`bind: no layer "${target}" found in "${owner.name}".`);
  }
  return bound;
}

/** add_component_property: define a property and (optionally) bind it to layers. */
export async function addComponentProperty(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const owner = propertyOwner(await requireComponent(p.nodeId, ctx), ctx);
  const type = String(p.type ?? "").toUpperCase();
  if (!(PROP_TYPES as readonly string[]).includes(type)) {
    throw err(ErrorCode.INVALID_PARAMS, `Unknown property type "${String(p.type)}".`, `Use one of ${PROP_TYPES.join(", ")}.`);
  }
  const name = String(p.name ?? "").trim();
  if (!name) throw err(ErrorCode.INVALID_PARAMS, "add_component_property requires a name.", 'e.g. { name: "Label", type: "TEXT", defaultValue: "Button" }.');
  let def: string | boolean;
  if (type === "INSTANCE_SWAP") def = await swapValue(p.defaultValue, ctx);
  else if (type === "BOOLEAN") def = p.defaultValue === undefined ? true : p.defaultValue === true || p.defaultValue === "true";
  else def = String(p.defaultValue ?? "");
  const options: ComponentPropertyOptions = {};
  const pv = await preferredValues(p.preferredValues, ctx);
  if (pv) options.preferredValues = pv;
  if (typeof p.description === "string") options.description = p.description;
  const key = figmaCall(
    "addComponentProperty",
    () => owner.addComponentProperty(name, type as ComponentPropertyType, def, Object.keys(options).length ? options : undefined),
    type === "VARIANT"
      ? "VARIANT properties can only be added to a COMPONENT_SET."
      : "Check the default value matches the type (TEXT: string, BOOLEAN: true/false, INSTANCE_SWAP: a component).",
  );
  const bound = bindProperty(owner, key, type, p.bind, ctx);
  return { id: owner.id, key, type, bound };
}

/** edit_component_property: rename / change default / preferred values. */
export async function editComponentProperty(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const owner = propertyOwner(await requireComponent(p.nodeId, ctx), ctx);
  const key = requireKey(owner, p.property);
  const type = String(currentDefs(owner)[key]?.type ?? "");
  const change: Parameters<ComponentNode["editComponentProperty"]>[1] = {};
  if (typeof p.name === "string" && p.name.trim()) change.name = p.name.trim();
  if (p.defaultValue !== undefined) {
    change.defaultValue =
      type === "INSTANCE_SWAP"
        ? await swapValue(p.defaultValue, ctx)
        : type === "BOOLEAN"
          ? p.defaultValue === true || p.defaultValue === "true"
          : String(p.defaultValue);
  }
  const pv = await preferredValues(p.preferredValues, ctx);
  if (pv) change.preferredValues = pv;
  if (typeof p.description === "string") change.description = p.description;
  if (Object.keys(change).length === 0) {
    throw err(ErrorCode.INVALID_PARAMS, "Nothing to change.", "Pass name, defaultValue or preferredValues.");
  }
  const newKey = figmaCall(
    "editComponentProperty",
    () => owner.editComponentProperty(key, change),
    "VARIANT properties can be renamed but have no default; preferredValues apply to INSTANCE_SWAP only.",
  );
  const bound = p.bind !== undefined ? bindProperty(owner, newKey, type, p.bind, ctx) : [];
  return { id: owner.id, key: newKey, previousKey: key, type, bound };
}

/** delete_component_property. */
export async function deleteComponentProperty(ctx: HandlerContext): Promise<unknown> {
  const owner = propertyOwner(await requireComponent(ctx.params.nodeId, ctx), ctx);
  const key = requireKey(owner, ctx.params.property);
  figmaCall(
    "deleteComponentProperty",
    () => owner.deleteComponentProperty(key),
    "VARIANT properties cannot be deleted this way — remove or rename the variants instead.",
  );
  return { id: owner.id, deleted: key };
}

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

/**
 * Apply a {name: value} patch to an instance: VARIANT props first (switching
 * variant re-reads the instance), then the rest against the fresh map.
 */
async function applyProperties(
  inst: InstanceNode,
  input: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<{ applied: Record<string, unknown>; failed: Array<{ name: string; error: string; candidates?: string[] }> }> {
  const applied: Record<string, unknown> = {};
  const failed: Array<{ name: string; error: string; candidates?: string[] }> = [];
  const avail = () => inst.componentProperties as unknown as Record<string, ComponentPropertyEntry>;

  const first = planPropertyPatch(avail(), input);
  if (first.variants.length) {
    const patch = Object.fromEntries(first.variants.map((v) => [v.key, v.value])) as Record<string, string>;
    figmaCall("setProperties", () => inst.setProperties(patch), "Check the variant value exists on the set.");
    for (const v of first.variants) applied[v.key] = v.value;
  }
  // Re-plan the non-variant names against the (possibly new) variant's map.
  const restInput = Object.fromEntries(
    Object.entries(input).filter(([n]) => !first.variants.some((v) => v.name === n)),
  );
  const second = first.variants.length ? planPropertyPatch(avail(), restInput) : { ...first, variants: [] };
  failed.push(...second.failed);
  const restPatch: Record<string, PropertyValue> = {};
  for (const r of second.rest) {
    restPatch[r.key] = r.type === "INSTANCE_SWAP" && typeof r.value === "string" ? await swapValue(r.value, ctx) : r.value;
  }
  if (Object.keys(restPatch).length) {
    figmaCall(
      "setProperties",
      () => inst.setProperties(restPatch as { [k: string]: string | boolean | VariableAlias }),
      "TEXT takes a string, BOOLEAN true/false, INSTANCE_SWAP a component name or id.",
    );
    const now = avail();
    for (const [k, v] of Object.entries(restPatch)) {
      applied[k] = v;
      if (!propertyValueStuck(v, now[k]?.value)) ctx.warn(`Property "${k}" did not keep the value ${JSON.stringify(v)}.`);
    }
  }
  return { applied, failed };
}

function reportFailed(failed: Array<{ name: string; error: string; candidates?: string[] }>, applied: number): void {
  if (failed.length === 0) return;
  const first = failed[0]!;
  if (applied === 0) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      failed.map((f) => `${f.name}: ${f.error}`).join("; "),
      first.candidates?.length ? `Properties on this instance: ${first.candidates.join(", ")}.` : "Read them with get_instance_overrides.",
    );
  }
}

/** Apply overrides: [{target, props}] on layers, or copy from another instance. */
async function applyOverrides(inst: InstanceNode, p: Record<string, unknown>, ctx: HandlerContext): Promise<number> {
  let count = 0;
  if (typeof p.from === "string") count += await copyOverridesFrom(inst, p.from, ctx);
  const list = Array.isArray(p.overrides) ? (p.overrides as Array<Record<string, unknown>>) : [];
  for (const o of list) {
    const target = String(o.target ?? o.nodeId ?? o.layer ?? "");
    const props = (o.props ?? o.set) as Record<string, unknown> | undefined;
    if (!target || !props || typeof props !== "object") {
      ctx.warn(`Skipped an override with no target or props (${JSON.stringify(o).slice(0, 80)}).`);
      continue;
    }
    const layer = findLayer(inst, target, ctx);
    if (!layer) {
      ctx.warn(`Override target "${target}" not found inside "${inst.name}".`);
      continue;
    }
    await modify(subCtx(ctx, { nodeId: layer.id, props }));
    count++;
  }
  return count;
}

const COPYABLE_FIELDS = [
  "characters",
  "visible",
  "opacity",
  "fills",
  "strokes",
  "strokeWeight",
  "effects",
  "cornerRadius",
  "fontSize",
  "fontName",
] as const;

/** Copy every directly overridden field from a sibling instance of the same component. */
async function copyOverridesFrom(inst: InstanceNode, fromId: string, ctx: HandlerContext): Promise<number> {
  const src = await requireInstance(fromId);
  const [a, b] = await Promise.all([src.getMainComponentAsync(), inst.getMainComponentAsync()]);
  const sameSet = a && b && (a.id === b.id || (isVariant(a) && isVariant(b) && a.parent!.id === b.parent!.id));
  if (!sameSet) ctx.warn(`"${src.name}" and "${inst.name}" use different components; only matching layers are copied.`);
  // Properties first, they drive whole layers.
  const props = flattenComponentProperties(src.componentProperties as unknown as Record<string, { value?: unknown }>);
  const res = await applyProperties(inst, props, ctx);
  let count = Object.keys(res.applied).length;
  const prefix = `I${src.id};`;
  for (const o of src.overrides ?? []) {
    if (o.id === src.id) continue;
    const rel = o.id.startsWith(prefix) ? o.id.slice(prefix.length) : null;
    if (!rel) continue;
    const from = await getNodeByIdSafe(o.id);
    const to = await getNodeByIdSafe(`I${inst.id};${rel}`);
    if (!from || !to) continue;
    if (to.type === "TEXT") await loadNodeFonts(to as TextNode);
    for (const f of o.overriddenFields) {
      if (!(COPYABLE_FIELDS as readonly string[]).includes(f)) continue;
      try {
        if (f === "fontName" && to.type === "TEXT") {
          const fn = (from as TextNode).fontName;
          if (typeof fn === "object") {
            await figma.loadFontAsync(fn as FontName);
            (to as TextNode).fontName = fn as FontName;
          }
        } else {
          (to as unknown as Record<string, unknown>)[f] = (from as unknown as Record<string, unknown>)[f];
        }
        count++;
      } catch (e) {
        ctx.warn(`Could not copy ${f} on "${to.name}": ${e instanceof Error ? e.message : String(e)}.`);
      }
    }
  }
  return count;
}

/** instantiate: an instance of a component (by name/id/key), placed and configured. */
export async function instantiate(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const ref = p.component ?? p.componentId ?? p.name;
  let comp = await resolveComponentRef(ref, ctx, { key: p.key });
  const variantAsked = p.variant && typeof p.variant === "object" ? (p.variant as Record<string, unknown>) : undefined;
  const target: ComponentNode =
    comp.type === "COMPONENT_SET" ? pickVariant(comp as ComponentSetNode, variantAsked) : (comp as ComponentNode);
  if (variantAsked && comp.type === "COMPONENT" && isVariant(comp)) {
    comp = comp.parent as ComponentSetNode;
  }
  const inst = target.createInstance();
  try {
    if (p.parentId !== undefined) {
      const parent = await resolveParent(p.parentId);
      insertInto(parent, inst, p.insertAt as InsertAt | undefined);
    } else if (inst.parent !== figma.currentPage) {
      figma.currentPage.appendChild(inst);
    }
    if (typeof p.instanceName === "string") inst.name = p.instanceName;
    else if (typeof p.layerName === "string") inst.name = p.layerName;
    if (typeof p.x === "number") inst.x = p.x;
    if (typeof p.y === "number") inst.y = p.y;
    const w = typeof p.width === "number" ? p.width : typeof p.w === "number" ? p.w : undefined;
    const h = typeof p.height === "number" ? p.height : typeof p.h === "number" ? p.h : undefined;
    if (w !== undefined || h !== undefined) inst.resize(w ?? inst.width, h ?? inst.height);
    for (const k of ["layoutAlign", "layoutGrow", "layoutPositioning", "layoutSizingHorizontal", "layoutSizingVertical"] as const) {
      if (p[k] !== undefined) {
        figmaCall(k, () => ((inst as unknown as Record<string, unknown>)[k] = p[k]), `${k} applies only inside an auto-layout parent.`);
      }
    }
    let applied: Record<string, unknown> = {};
    if (p.properties && typeof p.properties === "object") {
      const res = await applyProperties(inst, p.properties as Record<string, unknown>, ctx);
      applied = res.applied;
      for (const f of res.failed) ctx.warn(`properties.${f.name}: ${f.error}${f.candidates?.length ? ` (have: ${f.candidates.join(", ")})` : ""}`);
    }
    if (p.overrides !== undefined) await applyOverrides(inst, { overrides: p.overrides }, ctx);
    if (p.parentId === undefined) keepClearOnCanvas(inst, p, ctx);
    return {
      id: inst.id,
      componentId: target.id,
      componentName: comp.type === "COMPONENT_SET" ? comp.name : target.name,
      ...(target.parent?.type === "COMPONENT_SET" ? { variant: parseVariantName(target.name) } : {}),
      ...(Object.keys(applied).length ? { properties: applied } : {}),
      node: serializeNode(inst, "compact"),
    };
  } catch (e) {
    try {
      inst.remove();
    } catch {
      /* gone */
    }
    throw e;
  }
}

/** set_instance_properties: {name: value}, names without the "#1:2" suffix. */
export async function setInstanceProperties(ctx: HandlerContext): Promise<unknown> {
  const inst = await requireInstance(ctx.params.nodeId);
  const props = (ctx.params.properties ?? ctx.params.props) as Record<string, unknown> | undefined;
  if (!props || typeof props !== "object" || Object.keys(props).length === 0) {
    throw err(ErrorCode.INVALID_PARAMS, "set_instance_properties needs properties.", 'e.g. setInstanceProperties(id, { Label: "Save", Size: "lg", "Show icon": false }).');
  }
  const { applied, failed } = await applyProperties(inst, props, ctx);
  reportFailed(failed, Object.keys(applied).length);
  for (const f of failed) ctx.warn(`${f.name}: ${f.error}`);
  return { id: inst.id, applied, ...(failed.length ? { failed } : {}) };
}

/** set_instance_overrides: edit layers inside an instance, or copy another instance's overrides. */
export async function setInstanceOverrides(ctx: HandlerContext): Promise<unknown> {
  const inst = await requireInstance(ctx.params.nodeId);
  const p = ctx.params;
  if (p.overrides === undefined && p.from === undefined && p.properties === undefined) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      "set_instance_overrides needs overrides, from, or properties.",
      'e.g. { overrides: [{ target: "Label", props: { characters: "Save" } }] } or { from: otherInstanceId }.',
    );
  }
  let count = await applyOverrides(inst, p, ctx);
  if (p.properties && typeof p.properties === "object") {
    const res = await applyProperties(inst, p.properties as Record<string, unknown>, ctx);
    count += Object.keys(res.applied).length;
    for (const f of res.failed) ctx.warn(`properties.${f.name}: ${f.error}`);
  }
  return { id: inst.id, applied: count };
}

/** expose_nested_instance: surface a nested instance's properties on the parent component. */
export async function exposeNestedInstance(ctx: HandlerContext): Promise<unknown> {
  const node = await requireInstance(ctx.params.nodeId);
  let p = node.parent;
  while (p && p.type !== "COMPONENT" && p.type !== "COMPONENT_SET") {
    if (p.type === "INSTANCE") break;
    p = p.parent;
  }
  if (!p || (p.type !== "COMPONENT" && p.type !== "COMPONENT_SET")) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      `"${node.name}" is not a nested instance directly inside a component.`,
      "Pass an INSTANCE layer that sits inside a COMPONENT (not inside another instance).",
    );
  }
  const expose = ctx.params.expose !== false;
  figmaCall("isExposedInstance", () => (node.isExposedInstance = expose), "Only primary instances inside a component can be exposed.");
  return { id: node.id, exposed: node.isExposedInstance, componentId: p.id };
}

/** detach_instance: instance → plain frame. */
export async function detachInstance(ctx: HandlerContext): Promise<unknown> {
  const inst = await requireInstance(ctx.params.nodeId);
  const frame = figmaCall("detachInstance", () => inst.detachInstance(), "Nested instances inside another instance cannot be detached on their own.");
  return { id: frame.id, node: serializeNode(frame, "compact") };
}

/**
 * reset_instance_overrides: back to the main component's values.
 *
 * Figma's own reset leaves component PROPERTY values alone (a Label set to
 * "Save" stays "Save"), which is not what "back to the main component" means
 * to anybody reading the canvas. So TEXT / BOOLEAN / INSTANCE_SWAP values go
 * back to their defaults too; the variant is kept (it is which component the
 * instance IS, not an override). `keepProperties: true` skips that step.
 */
export async function resetInstanceOverrides(ctx: HandlerContext): Promise<unknown> {
  const inst = await requireInstance(ctx.params.nodeId);
  const before = (inst.overrides ?? []).length;
  const anyInst = inst as unknown as { removeOverrides?: () => void; resetOverrides: () => void };
  figmaCall("resetOverrides", () => (anyInst.removeOverrides ? anyInst.removeOverrides() : anyInst.resetOverrides()), "");
  const restored: Record<string, unknown> = {};
  if (ctx.params.keepProperties !== true) {
    const main = await inst.getMainComponentAsync();
    if (main) {
      const owner = isVariant(main) ? (main.parent as ComponentSetNode) : main;
      let defs: ComponentPropertyDefinitions | undefined;
      try {
        defs = owner.componentPropertyDefinitions;
      } catch {
        defs = undefined;
      }
      const current = inst.componentProperties;
      const patch: Record<string, string | boolean> = {};
      for (const [key, def] of Object.entries(defs ?? {})) {
        if (def.type === "VARIANT" || def.type === "SLOT") continue;
        if (current[key] && current[key]!.value !== def.defaultValue) patch[key] = def.defaultValue;
      }
      if (Object.keys(patch).length) {
        figmaCall("setProperties", () => inst.setProperties(patch), "");
        Object.assign(restored, patch);
      }
    }
  }
  return { id: inst.id, cleared: before, ...(Object.keys(restored).length ? { restoredProperties: restored } : {}) };
}

/** swap_component: point an instance at another component, keeping overrides where Figma can. */
export async function swapComponent(ctx: HandlerContext): Promise<unknown> {
  const inst = await requireInstance(ctx.params.nodeId);
  const c = await resolveComponentRef(ctx.params.component ?? ctx.params.componentId, ctx, { key: ctx.params.key });
  // Swapping within the SAME set changes only what was asked: { Tone: "x" }
  // keeps the instance's current Size, rather than falling back to the default's.
  const current = await inst.getMainComponentAsync();
  let wanted = ctx.params.variant as Record<string, unknown> | undefined;
  if (c.type === "COMPONENT_SET" && current && isVariant(current) && current.parent!.id === c.id && wanted && typeof wanted === "object") {
    wanted = { ...parseVariantName(current.name), ...wanted };
  }
  const target = c.type === "COMPONENT_SET" ? pickVariant(c as ComponentSetNode, wanted) : (c as ComponentNode);
  figmaCall("swapComponent", () => inst.swapComponent(target), "The instance must not be a nested instance inside another instance.");
  return {
    id: inst.id,
    componentId: target.id,
    componentName: isVariant(target) ? `${target.parent!.name}/${target.name}` : target.name,
  };
}

// ---------------------------------------------------------------------------
// Code ↔ Figma component map
// ---------------------------------------------------------------------------

function infoOf(c: AnyComponent): FigmaComponentInfo {
  const d = describeComponent(c) as {
    id: string;
    name: string;
    type: "COMPONENT" | "COMPONENT_SET";
    variantOptions?: Record<string, string[]>;
    properties?: Record<string, { type: string; defaultValue?: unknown }>;
  };
  return {
    id: d.id,
    name: d.name,
    type: d.type,
    ...(d.variantOptions ? { variantOptions: d.variantOptions } : {}),
    ...(d.properties ? { properties: d.properties } : {}),
  };
}

/** export_component_map: a starting code↔Figma map (plus TS prop types) from the file's components. */
export async function exportComponentMap(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const all = (await listLocalComponents(p.scope === "page" ? "page" : "file")).filter((c) => !isVariant(c.node));
  let picked: Listed[];
  if (Array.isArray(p.names) && p.names.length) {
    picked = [];
    for (const n of p.names) {
      const want = normalizeName(String(n));
      const hit = all.find((c) => normalizeName(c.name) === want);
      if (hit) picked.push(hit);
      else ctx.warn(`names: no component "${String(n)}".`);
    }
  } else if (typeof p.query === "string" && p.query.trim()) {
    picked = rankCandidates(p.query, all, 200).map((s) => s.candidate);
  } else {
    picked = all;
  }
  const limit = typeof p.limit === "number" && p.limit > 0 ? Math.floor(p.limit) : 100;
  if (picked.length > limit) ctx.warn(`${picked.length} components matched; mapped the first ${limit}. Narrow with query/names or raise limit.`);
  const map = mapFromFigma(picked.slice(0, limit).map((c) => infoOf(c.node)));
  return { count: Object.keys(map.components).length, map, typescript: mapToTypeScript(map) };
}

/** check_component_map: does the map still describe this file? */
export async function checkComponentMap(ctx: HandlerContext): Promise<unknown> {
  const map = ctx.params.map as ComponentMap | undefined;
  if (!map || typeof map !== "object" || !map.components || typeof map.components !== "object") {
    throw err(ErrorCode.INVALID_PARAMS, "check_component_map needs { map: { components: { … } } }.", "Pass the map JSON from your codebase, or start one with export_component_map.");
  }
  const all = (await listLocalComponents("file")).filter((c) => !isVariant(c.node));
  const byName = new Map(all.map((c) => [normalizeName(c.name), c.node]));
  const findings = checkMap(map, (name) => {
    const c = byName.get(normalizeName(name));
    return c ? infoOf(c) : undefined;
  });
  return {
    components: Object.keys(map.components).length,
    errors: findings.filter((f) => f.severity === "error").length,
    warnings: findings.filter((f) => f.severity === "warning").length,
    findings,
  };
}
