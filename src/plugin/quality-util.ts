/**
 * Pure helpers for the quality audits (accessibility, design-system
 * compliance, responsive). NO figma globals, so the judgement calls — what
 * counts as a control, when a value "is" a token — are testable on their own.
 */

/** Layer-name words that mean "a person taps this". */
const CONTROL_WORDS =
  /\b(button|btn|cta|tab|tabs|toggle|switch|checkbox|check box|radio|link|chip|pill|segmented|stepper|slider|dropdown|select|picker|menu|close|back|next|icon ?button|fab|input|field|text ?field|search|toolbar item|nav item|list item|cell|row action)\b/i;

/** Names Figma gives a layer nobody named. */
const DEFAULT_NAME = /^(frame|group|rectangle|ellipse|vector|instance|component|polygon|star|line|union|subtract|intersect|exclude|image|section|slice)( \d+)?$/i;

/** Words that name a kind of control, not what it does. */
const GENERIC_CONTROL = /^(button|btn|icon|icon ?button|cta|link|chip|tab|toggle|switch|control|action|item|cell|fab)( ?\d+)?$/i;

/**
 * Taller than this, a layer whose NAME says "menu" / "search" / "tab" is the
 * region that holds controls ("Settings menu", "Search results"), not one.
 */
export const NAMED_CONTROL_MAX_HEIGHT = 120;

/**
 * Is a layer a control? A tap reaction says so outright; a name only when the
 * layer is control-sized, so a "Tab bar" or "Search results" panel is a
 * container whose contents still get audited.
 */
export function isControlLike(name: string, height: number | undefined, hasTapReaction: boolean): boolean {
  if (hasTapReaction) return true;
  if (!looksLikeControl(name)) return false;
  return typeof height !== "number" || height <= NAMED_CONTROL_MAX_HEIGHT;
}

export function looksLikeControl(name: string): boolean {
  // Path-style names ("Button/Primary/Large") describe the component; any
  // segment that is a control word counts.
  return name.split("/").some((seg) => CONTROL_WORDS.test(seg.replace(/[_-]+/g, " ")));
}

export function isDefaultLayerName(name: string): boolean {
  return DEFAULT_NAME.test(name.trim());
}

/** "Button", "Icon button 2" — a name that says WHAT it is, never what it DOES. */
export function isGenericControlName(name: string): boolean {
  const last = name.split("/").pop() ?? name;
  return GENERIC_CONTROL.test(last.trim());
}

/** Reaction triggers that make a node interactive. */
export function isInteractiveTrigger(type: string | undefined): boolean {
  return (
    type === "ON_CLICK" ||
    type === "ON_PRESS" ||
    type === "ON_DRAG" ||
    type === "MOUSE_DOWN" ||
    type === "MOUSE_UP" ||
    type === "ON_KEY_DOWN"
  );
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** 0..1 channels → "#rrggbb". */
export function hex(c: Rgb): string {
  const h = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/** Largest per-channel difference on the 0..255 scale. */
export function channelDistance(a: Rgb, b: Rgb): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b)) * 255;
}

export interface ColorToken {
  id: string;
  name: string;
  color: Rgb;
  /** Opacity carried by the token itself (alpha), 0..1. */
  alpha: number;
}

export interface ColorMatch {
  token: ColorToken;
  /** 0 = exact. */
  distance: number;
}

/**
 * The token a literal colour stands for. Exact means within rounding (≤ 0.5
 * of a channel step, which is what a hex round-trip loses); `near` admits a
 * small drift for a suggestion but is never applied automatically.
 */
export function matchColor(
  color: Rgb,
  alpha: number,
  tokens: readonly ColorToken[],
  near = 3,
): { exact?: ColorMatch; near?: ColorMatch } {
  let best: ColorMatch | undefined;
  for (const t of tokens) {
    if (Math.abs(t.alpha - alpha) > 0.01) continue;
    const d = channelDistance(color, t.color);
    if (!best || d < best.distance || (d === best.distance && t.name.length < best.token.name.length)) {
      best = { token: t, distance: d };
    }
  }
  if (!best) return {};
  if (best.distance <= 0.5) return { exact: best };
  if (best.distance <= near) return { near: best };
  return {};
}

/** Line height / letter spacing as Figma stores them ({ unit, value }). */
export interface TypeLength {
  unit: string;
  value?: number;
}

/**
 * Everything a text style sets besides the font. Applying a style applies
 * these too, so a style that matches the font but not these reflows the text.
 * `null` = mixed on the node (a style would make it uniform).
 */
export interface TypeMetrics {
  lineHeight?: TypeLength | null;
  letterSpacing?: TypeLength | null;
  textCase?: string | null;
  textDecoration?: string | null;
}

export interface TypeStyle extends TypeMetrics {
  id: string;
  name: string;
  family: string;
  style: string;
  size: number;
}

/** A length in px at `size` ("auto" for AUTO line height); undefined = Figma's default. */
function lengthPx(l: TypeLength | undefined, size: number, def: "auto" | number): "auto" | number {
  if (!l) return def;
  if (l.unit === "AUTO") return "auto";
  const v = typeof l.value === "number" ? l.value : 0;
  return l.unit === "PERCENT" ? (size * v) / 100 : v;
}

function sameLength(a: TypeLength | null | undefined, b: TypeLength | null | undefined, size: number, def: "auto" | number): boolean {
  if (a === null || b === null) return false;
  const x = lengthPx(a, size, def);
  const y = lengthPx(b, size, def);
  if (x === "auto" || y === "auto") return x === y;
  return Math.abs(x - y) < 0.01;
}

/** Would applying style `s` leave the node's line height, tracking, case and decoration as they are? */
export function sameMetrics(node: TypeMetrics, s: TypeMetrics, size: number): boolean {
  const word = (v: string | null | undefined, def: string) => (v === null ? null : (v ?? def));
  return (
    sameLength(node.lineHeight, s.lineHeight, size, "auto") &&
    sameLength(node.letterSpacing, s.letterSpacing, size, 0) &&
    word(node.textCase, "ORIGINAL") === word(s.textCase, "ORIGINAL") &&
    word(node.textDecoration, "NONE") === word(s.textDecoration, "NONE")
  );
}

/**
 * The text style for a node's type. `exact` also matches line height, letter
 * spacing, case and decoration — binding it changes nothing on the canvas.
 * `near` matches family, style and size only: binding it would reflow the
 * text, so it is a suggestion and never applied unless asked (includeNear).
 */
export function matchTextStyle(
  family: string,
  style: string,
  size: number,
  styles: readonly TypeStyle[],
  metrics: TypeMetrics = {},
): { exact?: TypeStyle; near?: TypeStyle } {
  const hits = styles
    .filter((s) => s.family.toLowerCase() === family.toLowerCase() && s.style.toLowerCase() === style.toLowerCase() && Math.abs(s.size - size) < 0.01)
    // Shortest name first: "body" over "body/legacy-copy".
    .sort((a, b) => a.name.length - b.name.length);
  const exact = hits.find((s) => sameMetrics(metrics, s, size));
  if (exact) return { exact };
  return hits[0] ? { near: hits[0] } : {};
}

export interface NumberToken {
  id: string;
  name: string;
  value: number;
  scopes: readonly string[];
}

const RADIUS_NAME = /radius|corner|round/i;
const SPACE_NAME = /space|spacing|gap|padding|inset|gutter/i;

/** Number tokens that may stand for a corner radius / a spacing value. */
export function numberTokensFor(kind: "radius" | "spacing", tokens: readonly NumberToken[]): NumberToken[] {
  const scope = kind === "radius" ? "CORNER_RADIUS" : "GAP";
  const named = kind === "radius" ? RADIUS_NAME : SPACE_NAME;
  return tokens.filter((t) => {
    const scoped = t.scopes.length > 0 && !t.scopes.includes("ALL_SCOPES");
    if (scoped) return t.scopes.includes(scope) || (kind === "spacing" && t.scopes.includes("WIDTH_HEIGHT") && named.test(t.name));
    return named.test(t.name);
  });
}

export function matchNumber(value: number, tokens: readonly NumberToken[]): NumberToken | undefined {
  return tokens
    .filter((t) => Math.abs(t.value - value) < 0.01)
    .sort((a, b) => a.name.length - b.name.length)[0];
}

/** A named viewport for the responsive audit. */
export interface Viewport {
  name: string;
  width: number;
  height?: number;
}

export const VIEWPORT_PRESETS: Record<string, Viewport> = {
  "iphone-se": { name: "iPhone SE", width: 375, height: 667 },
  "iphone": { name: "iPhone", width: 402, height: 874 },
  "iphone-max": { name: "iPhone Pro Max", width: 440, height: 956 },
  "iphone-landscape": { name: "iPhone landscape", width: 874, height: 402 },
  "ipad": { name: "iPad portrait", width: 834, height: 1194 },
  "ipad-landscape": { name: "iPad landscape", width: 1194, height: 834 },
  "android": { name: "Android", width: 412, height: 915 },
  "tablet": { name: "Tablet", width: 768, height: 1024 },
  "laptop": { name: "Laptop", width: 1280, height: 800 },
  "desktop": { name: "Desktop", width: 1440, height: 900 },
};

/**
 * Viewports to try. Explicit sizes win; otherwise presets by name; otherwise
 * a default spread chosen from the frame's own width (a phone screen is tried
 * against other phones and landscape, a desktop page against smaller screens).
 */
export function resolveViewports(baseWidth: number, sizes?: unknown, presets?: unknown): { viewports: Viewport[]; unknown: string[] } {
  const unknown: string[] = [];
  if (Array.isArray(sizes) && sizes.length) {
    const out: Viewport[] = [];
    for (const s of sizes) {
      if (typeof s === "number" && s > 0) out.push({ name: `${s}w`, width: s });
      else if (s && typeof s === "object" && typeof (s as Viewport).width === "number" && (s as Viewport).width > 0) {
        const v = s as Viewport;
        out.push({ name: v.name || `${v.width}×${v.height ?? "auto"}`, width: v.width, ...(typeof v.height === "number" ? { height: v.height } : {}) });
      } else if (typeof s === "string") {
        const p = VIEWPORT_PRESETS[s.toLowerCase()];
        if (p) out.push(p);
        else unknown.push(s);
      }
    }
    return { viewports: out, unknown };
  }
  if (Array.isArray(presets) && presets.length) {
    const out: Viewport[] = [];
    for (const name of presets) {
      const p = VIEWPORT_PRESETS[String(name).toLowerCase()];
      if (p) out.push(p);
      else unknown.push(String(name));
    }
    return { viewports: out, unknown };
  }
  const keys =
    baseWidth <= 500
      ? ["iphone-se", "iphone-max", "iphone-landscape", "ipad"]
      : baseWidth <= 1100
        ? ["iphone", "ipad", "ipad-landscape", "laptop"]
        : ["ipad", "laptop", "desktop", "iphone"];
  return { viewports: keys.map((k) => VIEWPORT_PRESETS[k]!), unknown };
}
