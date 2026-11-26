/// <reference types="@figma/plugin-typings" />
/**
 * Quality audits: accessibility, design-system compliance (and the fix for
 * it), and responsive behaviour.
 *
 * Each returns findings a caller can act on node by node — an id, a kind, a
 * sentence — rather than a score. The judgement calls live in
 * quality-util.ts, which is figma-free and tested on its own.
 */
import { HandlerContext, requireNode } from "../context.js";
import { err } from "../errors.js";
import { ErrorCode } from "../../shared/protocol.js";
import { compositeOver, contrastRatio, type RGB, type RGBA } from "../color-util.js";
import { firstSolidFillRgba, layoutAudit, wcagMinRatio } from "./audit.js";
import { buildChildMap, type MiniNode } from "../tree-walk.js";
import {
  hex,
  isControlLike,
  isDefaultLayerName,
  isGenericControlName,
  isInteractiveTrigger,
  matchColor,
  matchNumber,
  matchTextStyle,
  numberTokensFor,
  resolveViewports,
  type ColorToken,
  type NumberToken,
  type TypeStyle,
} from "../quality-util.js";

type Severity = "error" | "warning";

interface Finding {
  nodeId: string;
  name: string;
  kind: string;
  severity: Severity;
  message: string;
}

function subCtx(ctx: HandlerContext, params: Record<string, unknown>): HandlerContext {
  return { params, warnings: ctx.warnings, progress: ctx.progress, warn: ctx.warn };
}

async function auditRoot(nodeId: unknown): Promise<BaseNode & ChildrenMixin | SceneNode> {
  if (typeof nodeId === "string" && nodeId) return requireNode(nodeId);
  return (figma.currentPage.selection[0] as SceneNode | undefined) ?? figma.currentPage;
}

/** Visible scene nodes under (and including) root, depth-first. */
function walk(root: BaseNode, visit: (n: SceneNode) => "skip" | void): number {
  let count = 0;
  const stack: BaseNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type !== "PAGE" && n.type !== "DOCUMENT") {
      const s = n as SceneNode;
      if (s.visible === false) continue;
      count++;
      if (visit(s) === "skip") continue;
    }
    const kids = (n as Partial<ChildrenMixin>).children;
    if (Array.isArray(kids)) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
  return count;
}

function summarize(findings: Finding[], max: number) {
  const byKind: Record<string, number> = {};
  let errors = 0;
  for (const f of findings) {
    byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
    if (f.severity === "error") errors++;
  }
  // Errors first, so a capped list keeps what matters.
  const sorted = findings.slice().sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
  return {
    summary: { total: findings.length, errors, warnings: findings.length - errors, byKind },
    findings: sorted.slice(0, max),
    ...(findings.length > max ? { truncated: findings.length - max } : {}),
  };
}

function maxParam(v: unknown, def: number): number {
  return typeof v === "number" && v > 0 ? Math.min(2000, Math.floor(v)) : def;
}

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

function isInteractive(n: SceneNode): boolean {
  const reactions = (n as { reactions?: ReadonlyArray<Reaction> }).reactions;
  const tap = Array.isArray(reactions) && reactions.some((r) => isInteractiveTrigger(r?.trigger?.type));
  if (!tap && (n.type === "TEXT" || n.type === "VECTOR" || n.type === "LINE" || n.type === "BOOLEAN_OPERATION")) return false;
  return isControlLike(n.name, (n as Partial<LayoutMixin>).height, tap);
}

type Box = { x: number; y: number; width: number; height: number };

function boxOf(n: BaseNode): Box | null {
  const b = (n as { absoluteBoundingBox?: Box | null }).absoluteBoundingBox;
  return b && typeof b.width === "number" ? b : null;
}

function covers(outer: Box, inner: Box): boolean {
  return (
    outer.x <= inner.x + 0.5 &&
    outer.y <= inner.y + 0.5 &&
    outer.x + outer.width >= inner.x + inner.width - 0.5 &&
    outer.y + outer.height >= inner.y + inner.height - 0.5
  );
}

/**
 * The colour behind a text layer. A card is often a Rectangle drawn BEFORE the
 * text in the same group, not the text's parent — so at every level, earlier
 * siblings that cover the text (nearest first) count before the parent does.
 * Translucent layers composite until an opaque one is found.
 */
function backgroundBehind(t: SceneNode): RGB | null {
  const box = boxOf(t);
  const layers: RGBA[] = [];
  const done = () => {
    let acc: RGB = { r: layers[layers.length - 1]!.r, g: layers[layers.length - 1]!.g, b: layers[layers.length - 1]!.b };
    for (let i = layers.length - 2; i >= 0; i--) acc = compositeOver(layers[i]!, acc);
    return acc;
  };
  let child: BaseNode = t;
  let cur: BaseNode | null = t.parent;
  while (cur) {
    const kids = (cur as Partial<ChildrenMixin>).children;
    if (box && Array.isArray(kids)) {
      for (let i = kids.indexOf(child as SceneNode) - 1; i >= 0; i--) {
        const s = kids[i]!;
        if (s.visible === false) continue;
        const sb = boxOf(s);
        if (!sb || !covers(sb, box)) continue;
        const c = firstSolidFillRgba(s);
        if (!c) continue;
        layers.push(c);
        if (c.a >= 0.999) return done();
      }
    }
    if (cur.type !== "PAGE" && "fills" in cur) {
      const c = firstSolidFillRgba(cur as SceneNode);
      if (c) {
        layers.push(c);
        if (c.a >= 0.999) return done();
      }
    }
    child = cur;
    cur = cur.parent;
  }
  return layers.length ? done() : null;
}

function hasLabelText(n: SceneNode): boolean {
  if (n.type === "TEXT") return (n as TextNode).characters.trim().length > 0;
  if (!("findOne" in n)) return false;
  return !!(n as ChildrenMixin).findOne((k) => k.visible !== false && k.type === "TEXT" && (k as TextNode).characters.trim().length > 0);
}

/** a11y_audit: contrast, touch targets, small text, controls nobody named. */
export async function a11yAudit(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const root = await auditRoot(p.nodeId);
  const minTouch = typeof p.minTouch === "number" && p.minTouch > 0 ? p.minTouch : 44;
  const minFont = typeof p.minFontSize === "number" && p.minFontSize > 0 ? p.minFontSize : 11;
  const findings: Finding[] = [];
  const add = (n: SceneNode, kind: string, severity: Severity, message: string) =>
    findings.push({ nodeId: n.id, name: n.name, kind, severity, message });

  // A control's own children are its anatomy: their text is still read for
  // contrast and size, but a nested "icon" is not another tap target.
  const inControl = new Set<string>();
  const underControl = (n: SceneNode) => !!n.parent && inControl.has(n.parent.id);
  const checked = walk(root, (n) => {
    if (underControl(n)) inControl.add(n.id);
    if (n.type === "TEXT") {
      const t = n as TextNode;
      if (!t.characters.trim()) return;
      const fg = firstSolidFillRgba(t);
      const bg = backgroundBehind(t);
      if (fg && bg) {
        const ratio = contrastRatio(compositeOver(fg, bg), bg);
        const min = wcagMinRatio(t);
        if (ratio < min) {
          add(t, "contrast", "error", `Text contrast ${ratio.toFixed(2)}:1 is below WCAG AA ${min}:1 for this size ("${t.characters.slice(0, 40)}").`);
        }
      }
      if (typeof t.fontSize === "number" && t.fontSize < minFont) {
        add(t, "font-size", "warning", `Text is ${t.fontSize}px — below the ${minFont}px minimum for comfortable reading.`);
      }
      return;
    }
    if (inControl.has(n.id) || !isInteractive(n)) return;
    inControl.add(n.id);
    const box = n as SceneNode & LayoutMixin;
    if ("width" in box && (box.width < minTouch - 0.5 || box.height < minTouch - 0.5)) {
      add(n, "touch-target", "error", `Tap target is ${Math.round(box.width)}×${Math.round(box.height)} — below ${minTouch}×${minTouch}. Grow the hit area (padding or a transparent frame), not necessarily the visual.`);
    }
    if (isDefaultLayerName(n.name)) {
      add(n, "unnamed-control", "warning", `An interactive layer is still called "${n.name}". Name it by what it does — the layer name is the accessible name in handoff.`);
    } else if (!hasLabelText(n) && isGenericControlName(n.name)) {
      add(n, "unnamed-control", "warning", `Icon-only control named only "${n.name}". Name it by its action (e.g. "Close", "Share") so it has an accessible label.`);
    }
  });

  return { root: root.id, checked, minTouch, minFontSize: minFont, ...summarize(findings, maxParam(p.maxFindings, 200)) };
}

// ---------------------------------------------------------------------------
// Design-system compliance
// ---------------------------------------------------------------------------

interface DsTokens {
  colors: ColorToken[];
  colorVars: Map<string, Variable>;
  numbers: NumberToken[];
  numberVars: Map<string, Variable>;
  textStyles: TypeStyle[];
}

async function resolveValue(v: Variable, modeId: string, depth = 0): Promise<unknown> {
  const raw = v.valuesByMode[modeId] ?? Object.values(v.valuesByMode)[0];
  if (raw && typeof raw === "object" && (raw as VariableAlias).type === "VARIABLE_ALIAS" && depth < 6) {
    const target = await figma.variables.getVariableByIdAsync((raw as VariableAlias).id);
    if (!target) return undefined;
    const col = await figma.variables.getVariableCollectionByIdAsync(target.variableCollectionId);
    return resolveValue(target, col?.defaultModeId ?? modeId, depth + 1);
  }
  return raw;
}

async function loadTokens(): Promise<DsTokens> {
  const out: DsTokens = { colors: [], colorVars: new Map(), numbers: [], numberVars: new Map(), textStyles: [] };
  const vars = await figma.variables.getLocalVariablesAsync();
  const modes = new Map<string, string>();
  for (const v of vars) {
    if (v.resolvedType !== "COLOR" && v.resolvedType !== "FLOAT") continue;
    let mode = modes.get(v.variableCollectionId);
    if (!mode) {
      const col = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
      mode = col?.defaultModeId ?? Object.keys(v.valuesByMode)[0] ?? "";
      modes.set(v.variableCollectionId, mode);
    }
    const value = await resolveValue(v, mode);
    if (v.resolvedType === "COLOR" && value && typeof value === "object" && "r" in (value as object)) {
      const c = value as RGBA;
      out.colors.push({ id: v.id, name: v.name, color: { r: c.r, g: c.g, b: c.b }, alpha: typeof c.a === "number" ? c.a : 1 });
      out.colorVars.set(v.id, v);
    } else if (v.resolvedType === "FLOAT" && typeof value === "number") {
      out.numbers.push({ id: v.id, name: v.name, value, scopes: v.scopes ?? [] });
      out.numberVars.set(v.id, v);
    }
  }
  for (const s of await figma.getLocalTextStylesAsync()) {
    out.textStyles.push({
      id: s.id,
      name: s.name,
      family: s.fontName.family,
      style: s.fontName.style,
      size: s.fontSize,
      lineHeight: s.lineHeight,
      letterSpacing: s.letterSpacing,
      textCase: s.textCase,
      textDecoration: s.textDecoration,
    });
  }
  return out;
}

type DsKind = "color" | "text" | "radius" | "spacing";

interface DsItem {
  node: SceneNode;
  kind: DsKind;
  /** "fills[0]", "strokes[1]", "text", "cornerRadius", "paddingLeft", … */
  field: string;
  value: string;
  state: "bound" | "bindable" | "near" | "off";
  token?: { id: string; name: string };
}

const SPACING_FIELDS = ["paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "itemSpacing"] as const;
const RADIUS_FIELDS = ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"] as const;

function bound(n: SceneNode, field: string): boolean {
  const b = (n as { boundVariables?: Record<string, unknown> }).boundVariables;
  return !!b && b[field] !== undefined;
}

/** figma.mixed → null: a value the style would flatten, so never an exact match. */
function unmixed<T>(v: T): Exclude<T, symbol> | null {
  return typeof v === "symbol" ? null : (v as Exclude<T, symbol>);
}

function scanDesignSystem(root: BaseNode, tokens: DsTokens, kinds: Set<DsKind>, includeInstances: boolean): { items: DsItem[]; checked: number } {
  const items: DsItem[] = [];
  const radiusTokens = numberTokensFor("radius", tokens.numbers);
  const spaceTokens = numberTokensFor("spacing", tokens.numbers);
  const checked = walk(root, (n) => {
    if (kinds.has("color")) {
      for (const field of ["fills", "strokes"] as const) {
        if (!(field in n)) continue;
        const paints = (n as GeometryMixin)[field];
        if (!Array.isArray(paints)) continue;
        const styleId = field === "fills" ? (n as { fillStyleId?: unknown }).fillStyleId : (n as { strokeStyleId?: unknown }).strokeStyleId;
        const styled = typeof styleId === "string" && styleId.length > 0;
        paints.forEach((paint: Paint, i: number) => {
          if (paint.type !== "SOLID" || paint.visible === false) return;
          const at = `${field}[${i}]`;
          const value = hex(paint.color) + (typeof paint.opacity === "number" && paint.opacity < 1 ? ` @${Math.round(paint.opacity * 100)}%` : "");
          if (styled || paint.boundVariables?.color) {
            items.push({ node: n, kind: "color", field: at, value, state: "bound" });
            return;
          }
          const m = matchColor(paint.color, typeof paint.opacity === "number" ? paint.opacity : 1, tokens.colors);
          if (m.exact) items.push({ node: n, kind: "color", field: at, value, state: "bindable", token: { id: m.exact.token.id, name: m.exact.token.name } });
          else if (m.near) items.push({ node: n, kind: "color", field: at, value, state: "near", token: { id: m.near.token.id, name: m.near.token.name } });
          else items.push({ node: n, kind: "color", field: at, value, state: "off" });
        });
      }
    }
    if (kinds.has("text") && n.type === "TEXT") {
      const t = n as TextNode;
      const styleId = t.textStyleId;
      if (typeof styleId === "string" && styleId) items.push({ node: t, kind: "text", field: "text", value: "", state: "bound" });
      else if (typeof t.fontSize === "number" && typeof t.fontName === "object") {
        const fn = t.fontName as FontName;
        const value = `${fn.family} ${fn.style} ${t.fontSize}`;
        const m = matchTextStyle(fn.family, fn.style, t.fontSize, tokens.textStyles, {
          lineHeight: unmixed(t.lineHeight),
          letterSpacing: unmixed(t.letterSpacing),
          textCase: unmixed(t.textCase),
          textDecoration: unmixed(t.textDecoration),
        });
        const s = m.exact ?? m.near;
        items.push({ node: t, kind: "text", field: "text", value, state: m.exact ? "bindable" : m.near ? "near" : "off", ...(s ? { token: { id: s.id, name: s.name } } : {}) });
      }
    }
    if (kinds.has("radius") && "cornerRadius" in n) {
      const r = (n as CornerMixin).cornerRadius;
      if (typeof r === "number" && r > 0) {
        if (RADIUS_FIELDS.some((f) => bound(n, f))) items.push({ node: n, kind: "radius", field: "cornerRadius", value: String(r), state: "bound" });
        else {
          const t = matchNumber(r, radiusTokens);
          items.push({ node: n, kind: "radius", field: "cornerRadius", value: String(r), state: t ? "bindable" : "off", ...(t ? { token: { id: t.id, name: t.name } } : {}) });
        }
      }
    }
    if (kinds.has("spacing") && "layoutMode" in n && (n as FrameNode).layoutMode !== "NONE") {
      const f = n as FrameNode;
      for (const field of SPACING_FIELDS) {
        const v = f[field];
        if (typeof v !== "number" || v <= 0) continue;
        if (field === "itemSpacing" && f.primaryAxisAlignItems === "SPACE_BETWEEN") continue;
        if (bound(n, field)) items.push({ node: n, kind: "spacing", field, value: String(v), state: "bound" });
        else {
          const t = matchNumber(v, spaceTokens);
          items.push({ node: n, kind: "spacing", field, value: String(v), state: t ? "bindable" : "off", ...(t ? { token: { id: t.id, name: t.name } } : {}) });
        }
      }
    }
    // An instance's layers belong to its main component: fix it there.
    if (!includeInstances && n.type === "INSTANCE") return "skip";
  });
  return { items, checked };
}

function kindsParam(v: unknown): Set<DsKind> {
  const all: DsKind[] = ["color", "text", "radius", "spacing"];
  if (!Array.isArray(v) || v.length === 0) return new Set(all);
  return new Set(v.map(String).filter((k): k is DsKind => (all as string[]).includes(k)));
}

function report(items: DsItem[], max: number) {
  const byKind: Record<string, Record<string, number>> = {};
  const offPalette = new Map<string, number>();
  for (const it of items) {
    const k = (byKind[it.kind] ??= { bound: 0, bindable: 0, near: 0, off: 0 });
    k[it.state] = (k[it.state] ?? 0) + 1;
    if (it.state === "off" && it.kind === "color") offPalette.set(it.value, (offPalette.get(it.value) ?? 0) + 1);
  }
  const total = items.length;
  const boundCount = items.filter((i) => i.state === "bound").length;
  const bindable = items.filter((i) => i.state === "bindable").length;
  const order = { bindable: 0, near: 1, off: 2, bound: 3 } as const;
  const findings = items
    .filter((i) => i.state !== "bound")
    .sort((a, b) => order[a.state] - order[b.state])
    .slice(0, max)
    .map((i) => ({
      nodeId: i.node.id,
      name: i.node.name,
      kind: i.kind,
      field: i.field,
      value: i.value,
      state: i.state,
      ...(i.token ? { token: i.token.name } : {}),
    }));
  return {
    compliance: total ? Math.round((boundCount / total) * 100) : 100,
    autoFixable: bindable,
    byKind,
    topOffPalette: [...offPalette.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([value, count]) => ({ value, count })),
    findings,
    ...(items.length - boundCount > max ? { truncated: items.length - boundCount - max } : {}),
  };
}

/** audit_design_system: which values are tokens, which could be, which are off-system. */
export async function auditDesignSystem(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const root = await auditRoot(p.nodeId);
  const tokens = await loadTokens();
  const { items, checked } = scanDesignSystem(root, tokens, kindsParam(p.kinds), p.includeInstances === true);
  return {
    root: root.id,
    checked,
    tokens: { colors: tokens.colors.length, numbers: tokens.numbers.length, textStyles: tokens.textStyles.length },
    ...report(items, maxParam(p.maxFindings, 200)),
  };
}

/** apply_design_system: bind every exact match to its token. `dryRun` reports only. */
export async function applyDesignSystem(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const root = await auditRoot(p.nodeId);
  const tokens = await loadTokens();
  if (!tokens.colors.length && !tokens.numbers.length && !tokens.textStyles.length) {
    throw err(
      ErrorCode.INVALID_PARAMS,
      "This file has no local color/number variables or text styles to bind to.",
      "Create tokens first (setupTokens / importTokens / setupTextStyles), then run apply_design_system.",
    );
  }
  const { items } = scanDesignSystem(root, tokens, kindsParam(p.kinds), p.includeInstances === true);
  const todo = items.filter((i) => i.state === "bindable" || (p.includeNear === true && i.state === "near"));
  const applied: Record<string, number> = {};
  const failed: Array<{ nodeId: string; field: string; error: string }> = [];
  if (p.dryRun !== true) {
    for (let k = 0; k < todo.length; k++) {
      const it = todo[k]!;
      try {
        await bindItem(it, tokens);
        applied[it.kind] = (applied[it.kind] ?? 0) + 1;
      } catch (e) {
        failed.push({ nodeId: it.node.id, field: it.field, error: e instanceof Error ? e.message : String(e) });
      }
      if ((k + 1) % 50 === 0) ctx.progress(k + 1, todo.length, "binding tokens");
    }
  }
  return {
    root: root.id,
    dryRun: p.dryRun === true,
    planned: todo.length,
    applied,
    ...(failed.length ? { failed: failed.slice(0, 50) } : {}),
    ...(p.dryRun === true
      ? { changes: todo.slice(0, maxParam(p.maxFindings, 200)).map((i) => ({ nodeId: i.node.id, name: i.node.name, field: i.field, value: i.value, token: i.token?.name })) }
      : {}),
  };
}

async function bindItem(it: DsItem, tokens: DsTokens): Promise<void> {
  const n = it.node;
  const id = it.token!.id;
  if (it.kind === "color") {
    const v = tokens.colorVars.get(id)!;
    const m = /^(fills|strokes)\[(\d+)\]$/.exec(it.field)!;
    const field = m[1] as "fills" | "strokes";
    const idx = Number(m[2]);
    const paints = ((n as GeometryMixin)[field] as readonly Paint[]).slice();
    paints[idx] = figma.variables.setBoundVariableForPaint(paints[idx] as SolidPaint, "color", v);
    (n as GeometryMixin)[field] = paints;
  } else if (it.kind === "text") {
    await (n as TextNode).setTextStyleIdAsync(id);
  } else if (it.kind === "radius") {
    const v = tokens.numberVars.get(id)!;
    for (const f of RADIUS_FIELDS) n.setBoundVariable(f, v);
  } else {
    n.setBoundVariable(it.field as VariableBindableNodeField, tokens.numberVars.get(id)!);
  }
}

// ---------------------------------------------------------------------------
// Responsive
// ---------------------------------------------------------------------------

function pageOf(node: BaseNode): PageNode | null {
  let p: BaseNode | null = node;
  while (p && p.type !== "PAGE") p = p.parent;
  return (p as PageNode | null) ?? null;
}

function toMini(node: BaseNode): MiniNode {
  const mini: MiniNode = { id: node.id };
  if ("children" in node) {
    const kids = (node as ChildrenMixin).children;
    if (kids.length) mini.children = kids.map(toMini);
  }
  return mini;
}

/** responsive_audit: stretch a copy of a screen to other viewports and audit each. */
export async function responsiveAudit(ctx: HandlerContext): Promise<unknown> {
  const p = ctx.params;
  const node = await requireNode(p.nodeId);
  if (!("resize" in node) || !("clone" in node)) {
    throw err(ErrorCode.INVALID_PARAMS, `"${node.name}" (${node.type}) cannot be resized.`, "Pass a FRAME, COMPONENT or INSTANCE — a screen.");
  }
  const base = node as FrameNode;
  const { viewports, unknown } = resolveViewports(base.width, p.sizes, p.presets);
  if (unknown.length) ctx.warn(`Unknown viewport preset(s): ${unknown.join(", ")}.`);
  if (!viewports.length) throw err(ErrorCode.INVALID_PARAMS, "No viewport to test.", "Pass sizes: [375, 834] or presets: [\"iphone\", \"ipad\"].");
  const keep = p.keep === true;
  const hugsHeight = base.layoutMode === "VERTICAL" ? base.primaryAxisSizingMode === "AUTO" : base.layoutMode === "HORIZONTAL" ? base.counterAxisSizingMode === "AUTO" : false;

  const results: unknown[] = [];
  const kept: string[] = [];
  // Copies live on the page, not in base's parent: inside auto-layout a
  // clone would take a slot and push its siblings around (x is ignored there),
  // and a clone of a variant would become one more variant of its set.
  const page = pageOf(base) ?? figma.currentPage;
  const abs = boxOf(base) ?? { x: base.x, y: base.y, width: base.width, height: base.height };
  let x = abs.x + abs.width + 200;
  for (let i = 0; i < viewports.length; i++) {
    const vp = viewports[i]!;
    const copy = node.type === "COMPONENT" ? node.createInstance() : base.clone();
    try {
      page.appendChild(copy);
      // Far from anything until the audit is done; `keep` lays them in a row.
      copy.x = keep ? x : -100000;
      copy.y = keep ? abs.y : -100000;
      copy.name = `${base.name} — ${vp.name}`;
      const h = vp.height !== undefined && !hugsHeight ? vp.height : copy.height;
      copy.resize(vp.width, h);
      const map = buildChildMap(toMini(base), toMini(copy));
      const back = new Map(Object.entries(map).map(([orig, cp]) => [cp, orig]));
      back.set(copy.id, base.id);
      // Every id the audit prints — "(2:39)" or a bare "clipped by 2:47" —
      // names a node of the throwaway copy; say which ORIGINAL it is.
      const remap = (s: string) => s.replace(/I?\d+:\d+(?:;\d+:\d+)*/g, (id) => back.get(id) ?? id);
      const audit = (await layoutAudit(subCtx(ctx, { nodeId: copy.id }))) as { summary: { issues: string[] } };
      const hints: string[] = [];
      for (const child of copy.findAll((k) => k.visible !== false)) {
        const c = child as SceneNode & LayoutMixin;
        if ((c as { layoutSizingHorizontal?: string }).layoutSizingHorizontal === "FIXED" && c.width > vp.width) {
          hints.push(`${c.name} (${back.get(c.id) ?? c.id}) is fixed at ${Math.round(c.width)}px — wider than the ${vp.width}px viewport. Make it FILL or HUG.`);
        }
      }
      const issues = audit.summary.issues.map(remap);
      results.push({ viewport: vp.name, width: vp.width, height: Math.round(copy.height), issueCount: issues.length, issues: issues.slice(0, 30), ...(hints.length ? { hints: hints.slice(0, 20) } : {}) });
      if (keep) {
        kept.push(copy.id);
        x += copy.width + 120;
      }
    } finally {
      if (!keep) copy.remove();
    }
    ctx.progress(i + 1, viewports.length, `viewport ${vp.name}`);
  }
  const worst = (results as Array<{ viewport: string; issueCount: number }>).reduce<{ viewport: string; issueCount: number } | null>(
    (w, r) => (!w || r.issueCount > w.issueCount ? r : w),
    null,
  );
  return {
    nodeId: base.id,
    base: { width: base.width, height: base.height },
    ...(base.layoutMode === "NONE" ? { note: "This frame has no auto-layout: children move only by their constraints, so most layouts break when the width changes." } : {}),
    results,
    worst: worst && worst.issueCount > 0 ? worst.viewport : null,
    ...(keep ? { kept } : {}),
  };
}
