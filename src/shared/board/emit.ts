/**
 * Spec builders shared by the board kinds (use case, journey, persona).
 *
 * Each returns a plain create() spec in frame coordinates. Text is measured
 * with the same table the graph kinds use (shared/diagram/metrics), so a box
 * is sized for the words that will actually be drawn in it.
 */
import { lineHeight, wrapToWidth } from "../diagram/metrics.js";
import { INK, MUTED } from "../diagram/palette.js";

export type Spec = Record<string, unknown>;

export const PAD = 32;
export const RULE = "#dfe4ea";
export const BODY = "#33404f";
export const SOFT = "#f5f7fa";
export { INK, MUTED };

export interface TextOpts {
  size?: number;
  weight?: "Regular" | "Medium" | "Semi Bold" | "Bold";
  color?: string;
  align?: "LEFT" | "CENTER" | "RIGHT";
  italic?: boolean;
}

/** Wrapped lines of `s` at `width`, honouring explicit newlines. */
export function wrap(s: string, width: number, size: number): string[] {
  const out: string[] = [];
  for (const para of String(s ?? "").split("\n")) out.push(...wrapToWidth(para, Math.max(20, width), size));
  return out.length ? out : [""];
}

/** Height a wrapped block takes. */
export function textHeight(s: string, width: number, size: number): number {
  return wrap(s, width, size).length * lineHeight(size);
}

export function text(name: string, x: number, y: number, width: number, characters: string, o: TextOpts = {}): Spec {
  const size = o.size ?? 13;
  return {
    type: "TEXT",
    name,
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(20, Math.round(width)),
    characters: wrap(characters, width, size).join("\n"),
    fontSize: size,
    fontStyle: o.italic ? (o.weight && o.weight !== "Regular" ? `${o.weight} Italic` : "Italic") : (o.weight ?? "Regular"),
    fill: o.color ?? BODY,
    textAutoResize: "HEIGHT",
    lineHeight: lineHeight(size),
    ...(o.align && o.align !== "LEFT" ? { textAlignHorizontal: o.align } : {}),
  };
}

export function rect(name: string, x: number, y: number, w: number, h: number, o: { fill?: string; stroke?: string; radius?: number; dashed?: boolean; strokeWeight?: number } = {}): Spec {
  return {
    type: "RECTANGLE",
    name,
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(1, Math.round(w)),
    height: Math.max(1, Math.round(h)),
    ...(o.fill ? { fill: o.fill } : { fills: [] }),
    ...(o.stroke ? { strokes: o.stroke, strokeWeight: o.strokeWeight ?? 1 } : { strokes: [] }),
    ...(o.radius ? { cornerRadius: o.radius } : {}),
    ...(o.dashed ? { dashPattern: [6, 4] } : {}),
  };
}

export function ellipse(name: string, x: number, y: number, w: number, h: number, o: { fill?: string; stroke?: string; strokeWeight?: number } = {}): Spec {
  return {
    type: "ELLIPSE",
    name,
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(1, Math.round(w)),
    height: Math.max(1, Math.round(h)),
    ...(o.fill ? { fill: o.fill } : { fills: [] }),
    ...(o.stroke ? { strokes: o.stroke, strokeWeight: o.strokeWeight ?? 1.5 } : { strokes: [] }),
  };
}

export type Pt = [number, number];

export function line(name: string, points: Pt[], o: { color?: string; dashed?: boolean; arrow?: boolean | "line"; weight?: number; closed?: boolean; fill?: string } = {}): Spec {
  return {
    type: "VECTOR",
    name,
    points: points.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]),
    strokes: o.color ?? MUTED,
    strokeWeight: o.weight ?? 1.5,
    strokeJoin: "ROUND",
    ...(o.closed ? { closed: true, ...(o.fill ? { fill: o.fill } : { fills: [] }) } : { fills: [] }),
    ...(o.dashed ? { dashPattern: [6, 4] } : {}),
    ...(o.arrow ? { endArrow: o.arrow } : {}),
  };
}

/** Title + optional subtitle at the top of the frame; returns where content may start. */
export function header(title: string, subtitle: string, frameW: number): { specs: Spec[]; bottom: number } {
  const specs: Spec[] = [text("title", PAD, 24, frameW - PAD * 2, title, { size: 20, weight: "Bold", color: INK })];
  let bottom = 24 + lineHeight(20) + 22;
  if (subtitle.trim()) {
    specs.push(text("subtitle", PAD, 56, frameW - PAD * 2, subtitle, { size: 13, color: MUTED }));
    bottom = Math.max(bottom, 56 + textHeight(subtitle, frameW - PAD * 2, 13) + 22);
  }
  return { specs, bottom };
}

/** Initials for an avatar: "Nguyễn Thu Trang" → "NT"… last-first is wrong for VN names, so first + last word. */
export function initials(name: string): string {
  const w = name.trim().split(/\s+/).filter(Boolean);
  if (!w.length) return "?";
  const first = w[0]![0] ?? "";
  const last = w.length > 1 ? (w[w.length - 1]![0] ?? "") : (w[0]![1] ?? "");
  return (first + last).toUpperCase();
}

/** A stable soft colour per string, for avatars and phase chips. */
const SOFT_COLORS = ["#dbeafe", "#dcfce7", "#fef3c7", "#fce7f3", "#ede9fe", "#cffafe", "#ffedd5", "#e0e7ff"];
const STRONG_COLORS = ["#1d4ed8", "#15803d", "#b45309", "#be185d", "#6d28d9", "#0e7490", "#c2410c", "#4338ca"];
export function tint(key: string): { soft: string; strong: string } {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const i = h % SOFT_COLORS.length;
  return { soft: SOFT_COLORS[i]!, strong: STRONG_COLORS[i]! };
}

/** Quoted-string tokens of a line: `"a" "b" c` → ["a", "b", "c"]. */
export function tokens(src: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push(m[1] !== undefined ? m[1].replace(/\\(["\\])/g, "$1") : m[2]!);
  return out;
}
