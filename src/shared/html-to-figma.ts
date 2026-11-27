/**
 * A captured DOM (boxes + computed CSS) → one `create()` spec tree.
 *
 * The capture (server/html-capture.ts, via Playwright) hands over what the
 * BROWSER decided — every element's border box and its computed style — so
 * nothing here re-implements CSS layout. What this module decides is the
 * Figma structure:
 *
 * - a flex container becomes an auto-layout FRAME (direction, gap, padding,
 *   alignment), so the result can be edited like a design, not a screenshot;
 * - a block container whose children stack top-to-bottom also becomes a
 *   vertical auto-layout frame (gap taken from the actual spacing);
 * - anything else keeps absolute positions inside its frame;
 * - text runs become TEXT with the computed font, size, weight, colour;
 * - <img>/<svg>/<video>/<canvas> become a placeholder RECTANGLE named after
 *   the source, since pixels are not captured.
 *
 * Pure: plain objects in, a create() spec out. Tested directly.
 */

export interface CapturedStyle {
  display?: string;
  flexDirection?: string;
  flexWrap?: string;
  gap?: string;
  rowGap?: string;
  columnGap?: string;
  justifyContent?: string;
  alignItems?: string;
  paddingTop?: string;
  paddingRight?: string;
  paddingBottom?: string;
  paddingLeft?: string;
  backgroundColor?: string;
  color?: string;
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  fontStyle?: string;
  lineHeight?: string;
  letterSpacing?: string;
  textAlign?: string;
  borderTopLeftRadius?: string;
  borderTopWidth?: string;
  borderTopColor?: string;
  borderTopStyle?: string;
  opacity?: string;
  boxShadow?: string;
  overflow?: string;
  position?: string;
}

export interface CapturedNode {
  tag: string;
  /** Direct text of this element (text nodes only, trimmed, collapsed). */
  text?: string;
  rect: { x: number; y: number; w: number; h: number };
  style: CapturedStyle;
  /** <img> src / alt, an <a> href — used for naming. */
  src?: string;
  alt?: string;
  id?: string;
  className?: string;
  children?: CapturedNode[];
}

export interface HtmlToFigmaOptions {
  /** Name of the root frame. */
  name?: string;
  /** Upper bound on nodes created (deepest/smallest are dropped first). */
  maxNodes?: number;
  /** Default font family when the computed one is a generic stack. */
  fallbackFont?: string;
}

type Spec = Record<string, unknown>;

const px = (v: string | undefined): number => {
  const n = parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};
const r1 = (n: number) => Math.round(n * 10) / 10;

/** `rgb(1, 2, 3)` / `rgba(1, 2, 3, 0.5)` / `#abc` → { hex, alpha }. Transparent → null. */
export function cssColor(v: string | undefined): { hex: string; alpha: number } | null {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  if (s === "transparent" || s === "none") return null;
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    if (a <= 0) return null;
    const h = (x: string) => Math.max(0, Math.min(255, Math.round(parseFloat(x)))).toString(16).padStart(2, "0");
    return { hex: `#${h(m[1]!)}${h(m[2]!)}${h(m[3]!)}`, alpha: Math.round(a * 1000) / 1000 };
  }
  const hx = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (hx) {
    const full = hx[1]!.length === 3 ? hx[1]!.split("").map((c) => c + c).join("") : hx[1]!;
    return { hex: `#${full}`, alpha: 1 };
  }
  return null;
}

function fill(v: string | undefined): string | undefined {
  const c = cssColor(v);
  if (!c) return undefined;
  if (c.alpha >= 0.999) return c.hex;
  return `${c.hex}${Math.round(c.alpha * 255).toString(16).padStart(2, "0")}`;
}

const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "-apple-system", "blinkmacsystemfont"]);

export function fontFamily(stack: string | undefined, fallback = "Inter"): string {
  for (const raw of String(stack ?? "").split(",")) {
    const f = raw.trim().replace(/^["']|["']$/g, "");
    if (f && !GENERIC.has(f.toLowerCase())) return f;
  }
  return fallback;
}

export function fontStyle(weight: string | undefined, italic?: string): string {
  const w = Math.round(px(weight) / 100) * 100 || 400;
  const name = w >= 900 ? "Black" : w >= 800 ? "Extra Bold" : w >= 700 ? "Bold" : w >= 600 ? "Semi Bold" : w >= 500 ? "Medium" : w <= 100 ? "Thin" : w <= 200 ? "Extra Light" : w <= 300 ? "Light" : "Regular";
  return italic === "italic" ? (name === "Regular" ? "Italic" : `${name} Italic`) : name;
}

const MEDIA = new Set(["img", "svg", "video", "canvas", "picture", "iframe"]);

function nameOf(n: CapturedNode): string {
  if (n.id) return `${n.tag}#${n.id}`;
  const cls = (n.className ?? "").trim().split(/\s+/).filter(Boolean)[0];
  if (cls) return `${n.tag}.${cls}`;
  return n.tag;
}

function align(v: string | undefined, axis: "primary" | "counter"): string | undefined {
  const s = String(v ?? "");
  if (/center/.test(s)) return "CENTER";
  if (/end|right|bottom/.test(s)) return "MAX";
  if (axis === "primary" && /space-between/.test(s)) return "SPACE_BETWEEN";
  if (axis === "counter" && /baseline/.test(s)) return "BASELINE";
  return undefined;
}

/** Do `kids` stack top-to-bottom (each starts at or below the previous one's bottom)? */
function stacksVertically(kids: CapturedNode[]): boolean {
  for (let i = 1; i < kids.length; i++) {
    if (kids[i]!.rect.y + 0.5 < kids[i - 1]!.rect.y + kids[i - 1]!.rect.h) return false;
  }
  return kids.length > 0;
}

function gapBetween(kids: CapturedNode[], dir: "x" | "y"): number {
  if (kids.length < 2) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < kids.length; i++) {
    const a = kids[i - 1]!.rect;
    const b = kids[i]!.rect;
    gaps.push(dir === "y" ? b.y - (a.y + a.h) : b.x - (a.x + a.w));
  }
  gaps.sort((p, q) => p - q);
  // Lower median: with uneven spacing, the tighter gap is the rhythm; the
  // wider one is usually a section break.
  return Math.max(0, Math.round(gaps[Math.floor((gaps.length - 1) / 2)]!));
}

function textSpec(n: CapturedNode, opts: HtmlToFigmaOptions): Spec {
  const st = n.style;
  const color = fill(st.color);
  const size = px(st.fontSize) || 16;
  const lh = st.lineHeight && st.lineHeight !== "normal" ? px(st.lineHeight) : undefined;
  const ls = st.letterSpacing && st.letterSpacing !== "normal" ? px(st.letterSpacing) : undefined;
  return {
    type: "TEXT",
    name: (n.text ?? "").slice(0, 40) || "text",
    characters: n.text ?? "",
    fontName: { family: fontFamily(st.fontFamily, opts.fallbackFont), style: fontStyle(st.fontWeight, st.fontStyle) },
    fontSize: r1(size),
    ...(lh ? { lineHeight: r1(lh) } : {}),
    ...(ls ? { letterSpacing: r1(ls) } : {}),
    ...(color ? { fill: color } : {}),
    ...(st.textAlign && /center|right|justify/.test(st.textAlign) ? { textAlignHorizontal: st.textAlign === "right" ? "RIGHT" : st.textAlign === "center" ? "CENTER" : "JUSTIFIED" } : {}),
    w: r1(n.rect.w),
    h: r1(n.rect.h),
  };
}

function decorate(spec: Spec, st: CapturedStyle): void {
  const bg = fill(st.backgroundColor);
  if (bg) spec.fill = bg;
  const radius = px(st.borderTopLeftRadius);
  if (radius > 0) spec.cornerRadius = r1(radius);
  const bw = px(st.borderTopWidth);
  const bc = fill(st.borderTopColor);
  if (bw > 0 && bc && st.borderTopStyle !== "none") {
    spec.stroke = bc;
    spec.strokeWeight = r1(bw);
  }
  const op = st.opacity !== undefined ? parseFloat(st.opacity) : 1;
  if (Number.isFinite(op) && op < 1) spec.opacity = Math.round(op * 100) / 100;
  if (st.overflow && /hidden|clip|auto|scroll/.test(st.overflow)) spec.clipsContent = true;
}

/** Count of nodes a capture would produce. */
export function countNodes(n: CapturedNode): number {
  return 1 + (n.children ?? []).reduce((s, c) => s + countNodes(c), 0);
}

/**
 * Drop the smallest leaves until the tree fits `max` — a 4,000-element page
 * becomes a 400-node frame that keeps the structure and the big pieces.
 */
export function pruneToBudget(root: CapturedNode, max: number): { root: CapturedNode; dropped: number } {
  let total = countNodes(root);
  let dropped = 0;
  if (total <= max) return { root, dropped };
  const clone = JSON.parse(JSON.stringify(root)) as CapturedNode;
  while (total > max) {
    // Collect leaves with their parents; drop the smallest-area leaf batch.
    const leaves: Array<{ parent: CapturedNode; i: number; area: number }> = [];
    const walk = (n: CapturedNode) => {
      (n.children ?? []).forEach((c, i) => {
        if (!c.children?.length) leaves.push({ parent: n, i, area: c.rect.w * c.rect.h });
        else walk(c);
      });
    };
    walk(clone);
    if (!leaves.length) break;
    leaves.sort((a, b) => a.area - b.area);
    const cut = leaves.slice(0, Math.max(1, Math.min(leaves.length, total - max)));
    const byParent = new Map<CapturedNode, number[]>();
    for (const l of cut) byParent.set(l.parent, [...(byParent.get(l.parent) ?? []), l.i]);
    for (const [p, idx] of byParent) {
      p.children = (p.children ?? []).filter((_, i) => !idx.includes(i));
      dropped += idx.length;
      total -= idx.length;
    }
  }
  return { root: clone, dropped };
}

/** What the conversion could not keep, said once each in the result. */
interface Notes {
  positioned: number;
  unparsedColors: Set<string>;
}

const isPositioned = (c: CapturedNode) => c.style.position === "absolute" || c.style.position === "fixed";

function noteColor(notes: Notes, v: string | undefined): void {
  if (v && !cssColor(v) && !/^(transparent|none|rgba?\(\s*0,\s*0,\s*0,\s*0\s*\))$/i.test(v.trim())) notes.unparsedColors.add(v.trim().slice(0, 40));
}

function convert(n: CapturedNode, parentRect: CapturedNode["rect"] | null, parentAuto: boolean, opts: HtmlToFigmaOptions, notes: Notes): Spec | null {
  if (n.rect.w < 0.5 || n.rect.h < 0.5) return null;
  const rel = parentRect ? { x: r1(n.rect.x - parentRect.x), y: r1(n.rect.y - parentRect.y) } : {};
  if (n.tag === "#text") {
    noteColor(notes, n.style.color);
    return { ...textSpec(n, opts), ...(parentAuto ? {} : rel) };
  }
  if (MEDIA.has(n.tag)) {
    const label = n.alt || (n.src ? n.src.split("/").pop()?.split("?")[0] : "") || n.tag;
    const spec: Spec = { type: "RECTANGLE", name: `${n.tag}: ${label}`.slice(0, 80), w: r1(n.rect.w), h: r1(n.rect.h), fill: "#e5e7eb", ...(parentAuto ? {} : rel) };
    const radius = px(n.style.borderTopLeftRadius);
    if (radius > 0) spec.cornerRadius = r1(radius);
    return spec;
  }
  const st = n.style;
  noteColor(notes, st.backgroundColor);
  let kids = (n.children ?? []).filter((c) => c.rect.w >= 0.5 && c.rect.h >= 0.5);
  const spec: Spec = { type: "FRAME", name: nameOf(n), w: r1(n.rect.w), h: r1(n.rect.h), ...(parentAuto ? {} : rel) };
  decorate(spec, st);
  // Auto-layout cannot hold a child that CSS takes out of the flow
  // (position: absolute/fixed — badges, overlays). Such a container keeps
  // absolute positions, so nothing moves.
  const positioned = kids.filter(isPositioned).length;
  if (positioned) notes.positioned += positioned;
  const flex = /flex/.test(st.display ?? "") && !positioned;
  const pad = { top: px(st.paddingTop), right: px(st.paddingRight), bottom: px(st.paddingBottom), left: px(st.paddingLeft) };
  let auto = false;
  if (flex) {
    const row = !/column/.test(st.flexDirection ?? "row");
    // *-reverse lays the DOM order out backwards; auto-layout follows child
    // order — so reorder by POSITION (left→right / top→bottom), which also
    // keeps the measured gap below positive.
    if (/reverse/.test(st.flexDirection ?? "")) kids = [...kids].sort((a, b) => (row ? a.rect.x - b.rect.x : a.rect.y - b.rect.y));
    spec.layoutMode = row ? "HORIZONTAL" : "VERTICAL";
    const gap = px(row ? st.columnGap ?? st.gap : st.rowGap ?? st.gap);
    spec.itemSpacing = gap > 0 ? r1(gap) : gapBetween(kids, row ? "x" : "y");
    const pa = align(st.justifyContent, "primary");
    const ca = align(st.alignItems, "counter");
    if (pa) spec.primaryAxisAlignItems = pa;
    if (ca && ca !== "BASELINE") spec.counterAxisAlignItems = ca;
    if (/wrap/.test(st.flexWrap ?? "") && row) spec.layoutWrap = "WRAP";
    auto = true;
  } else if (!positioned && kids.length > 1 && stacksVertically(kids)) {
    spec.layoutMode = "VERTICAL";
    spec.itemSpacing = gapBetween(kids, "y");
    auto = true;
  }
  if (auto) {
    spec.padding = pad;
    // The browser already sized everything: keep the captured box exactly.
    spec.primaryAxisSizingMode = "FIXED";
    spec.counterAxisSizingMode = "FIXED";
  }
  const children = kids.map((c) => convert(c, n.rect, auto, opts, notes)).filter((c): c is Spec => !!c);
  if (children.length) spec.children = children;
  return spec;
}

/** The whole capture → one root FRAME spec (absolute page coordinates dropped). */
export function domToFigma(root: CapturedNode, opts: HtmlToFigmaOptions = {}): { spec: Spec; nodes: number; dropped: number; warnings: string[] } {
  const max = opts.maxNodes && opts.maxNodes > 0 ? Math.floor(opts.maxNodes) : 600;
  const { root: pruned, dropped } = pruneToBudget(root, max);
  const notes: Notes = { positioned: 0, unparsedColors: new Set() };
  const warnings: string[] = [];
  let spec = convert(pruned, null, false, opts, notes);
  if (!spec) {
    // A body of height 0 (everything in it absolutely positioned) or a
    // selector that matched an empty element: say so instead of a blank frame.
    warnings.push(`The captured element has no size (${Math.round(pruned.rect.w)}×${Math.round(pruned.rect.h)}). Pass a selector for the element that holds the content (e.g. "#root", "main").`);
    spec = { type: "FRAME", w: Math.max(1, pruned.rect.w), h: Math.max(1, pruned.rect.h) };
  }
  if (opts.name) spec.name = opts.name;
  if (!spec.fill) spec.fill = "#ffffff";
  if (notes.positioned) warnings.push(`${notes.positioned} absolutely positioned element(s) kept their place, so their containers use absolute layout instead of auto-layout.`);
  if (notes.unparsedColors.size) warnings.push(`Colours that could not be read were left out: ${[...notes.unparsedColors].slice(0, 5).join(", ")}.`);
  return { spec, nodes: countNodes(pruned), dropped, warnings };
}
