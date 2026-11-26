/**
 * journey: one persona walking through one scenario, phase by phase — what
 * they do, where (touchpoint), what they think, how they feel, what hurts and
 * what could be better. Drawn as a grid with an emotion curve.
 *
 *   persona "Thu, 28, đặt vé lần đầu"
 *   phase find "Tìm phim"
 *     do Mở app, lướt danh sách
 *     at App · Trang chủ
 *     think "Phim nào đang hot?"
 *     feel 1 Tò mò
 *   phase pay "Thanh toán"
 *     do Nhập thẻ
 *     feel -2 Lo lắng
 *     pain Không rõ phí dịch vụ
 *     fix Hiện tổng tiền trước bước thẻ
 */
import { lines, takeQuoted } from "../diagram/text-util.js";
import { needsWideCoverage, textWidth } from "../diagram/metrics.js";
import { fillDeep, unresolved, type PolicyValues } from "../model/policy.js";
import { INK, MUTED, PAD, RULE, SOFT, ellipse, header, line, rect, text, textHeight, tint, wrap, type Pt, type Spec } from "../board/emit.js";
import type { BoardBuild } from "../usecase/index.js";

export interface JourneyPhase {
  id: string;
  label?: string;
  /** What the persona does. */
  actions?: string[];
  /** Where it happens — screen, channel, person. */
  touchpoints?: string[];
  thoughts?: string[];
  /** -2 (awful) … 2 (delighted). */
  feeling?: number;
  feelingNote?: string;
  pains?: string[];
  /** Opportunities — what would fix the pain. */
  ideas?: string[];
}

export interface JourneySpec {
  title?: string;
  subtitle?: string;
  persona?: string;
  phases?: JourneyPhase[];
  text?: string;
  x?: number;
  y?: number;
  parentId?: string;
  options?: { font?: string; dryRun?: boolean; policies?: PolicyValues; [k: string]: unknown };
}

export interface JourneyModel {
  title: string;
  subtitle?: string;
  persona?: string;
  phases: JourneyPhase[];
  options?: JourneySpec["options"];
}

const ROW_KEYS: Record<string, keyof JourneyPhase> = {
  do: "actions",
  action: "actions",
  at: "touchpoints",
  touch: "touchpoints",
  think: "thoughts",
  pain: "pains",
  fix: "ideas",
  idea: "ideas",
};

function rest(t: string, word: string): string {
  const body = t.slice(word.length).trim();
  const q = takeQuoted(body);
  return (q.value !== undefined && !q.rest ? q.value : body.replace(/^"|"$/g, "")).trim();
}

export function parseJourneyText(src: string): { persona?: string; phases: JourneyPhase[]; warnings: string[] } {
  const phases: JourneyPhase[] = [];
  const warnings: string[] = [];
  let persona: string | undefined;
  let cur: JourneyPhase | undefined;
  for (const l of lines(src)) {
    const t = l.text;
    const word = (/^(\w+)/.exec(t)?.[1] ?? "").toLowerCase();
    if (word === "persona") {
      persona = rest(t, "persona");
      continue;
    }
    if (word === "phase" || word === "stage") {
      // Ids in any script: `phase tìm "Tìm phim"` is "tìm", not "t".
      const m = /^\w+\s+([\p{L}\p{M}\p{N}_.-]+)\s*(.*)$/u.exec(t);
      if (!m) {
        warnings.push(`journey text, line ${l.no}: a phase needs an id — \`phase pay "Thanh toán"\`.`);
        continue;
      }
      const q = takeQuoted(m[2] ?? "");
      cur = { id: m[1]!, ...(q.value ? { label: q.value } : m[2] ? { label: m[2].trim() } : {}) };
      phases.push(cur);
      continue;
    }
    if (!cur) {
      warnings.push(`journey text, line ${l.no}: "${word}" before any \`phase\` — skipped.`);
      continue;
    }
    if (word === "feel" || word === "emotion") {
      const m = /^\w+\s+(-?\d+(?:\.\d+)?)\s*(.*)$/.exec(t);
      if (!m) {
        warnings.push(`journey text, line ${l.no}: \`feel\` needs a score from -2 to 2 — \`feel -1 Bối rối\`.`);
        continue;
      }
      cur.feeling = Number(m[1]);
      const note = (takeQuoted(m[2] ?? "").value ?? m[2] ?? "").trim();
      if (note) cur.feelingNote = note;
      continue;
    }
    const key = ROW_KEYS[word];
    if (key) {
      const v = rest(t, word);
      if (v) ((cur[key] as string[] | undefined) ?? ((cur as unknown as Record<string, string[]>)[key] = [])).push(v);
      continue;
    }
    warnings.push(`journey text, line ${l.no}: not understood, skipped — ${t}`);
  }
  return { ...(persona ? { persona } : {}), phases, warnings };
}

export function checkJourney(persona: string | undefined, phases: JourneyPhase[]): { phases: JourneyPhase[]; warnings: string[] } {
  const warnings: string[] = [];
  const out: JourneyPhase[] = [];
  const seen = new Set<string>();
  for (const p of phases) {
    if (!p?.id) continue;
    if (seen.has(p.id)) {
      warnings.push(`Two phases are both "${p.id}" — kept the first.`);
      continue;
    }
    seen.add(p.id);
    const q: JourneyPhase = { ...p };
    if (typeof q.feeling === "number" && (q.feeling < -2 || q.feeling > 2)) {
      warnings.push(`Phase "${q.label ?? q.id}": feeling ${q.feeling} is outside -2…2 — clamped.`);
      q.feeling = Math.max(-2, Math.min(2, q.feeling));
    }
    out.push(q);
  }
  if (!persona) warnings.push("No `persona` — a journey is one person's; name who walks it.");
  if (out.length < 2) warnings.push("A journey needs at least two phases to show a change.");
  for (const p of out) {
    const name = p.label ?? p.id;
    if (!p.actions?.length) warnings.push(`Phase "${name}" says nothing the persona DOES — add a \`do\`.`);
    if (typeof p.feeling === "number" && p.feeling <= -1 && !p.pains?.length) {
      warnings.push(`Phase "${name}" feels bad (${p.feeling}) but names no pain — what causes it?`);
    }
    if (p.pains?.length && !p.ideas?.length) warnings.push(`Phase "${name}" has a pain and no opportunity (\`fix\`) — the map is for deciding what to change.`);
  }
  const felt = out.filter((p) => typeof p.feeling === "number").length;
  if (out.length && felt === 0) warnings.push("No `feel` anywhere — the emotion curve is the point of a journey map.");
  else if (felt && felt < out.length) warnings.push(`${out.length - felt} phase(s) have no \`feel\` — the curve skips them.`);
  return { phases: out, warnings };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const LABEL_W = 150;
const COL_W = 230;
const CELL_PAD = 14;
const CURVE_H = 150;

const ROWS: Array<{ key: keyof JourneyPhase; label: string; color?: string }> = [
  { key: "actions", label: "Doing" },
  { key: "touchpoints", label: "Touchpoints" },
  { key: "thoughts", label: "Thinking" },
  { key: "feeling", label: "Feeling" },
  { key: "pains", label: "Pain points", color: "#fdecec" },
  { key: "ideas", label: "Opportunities", color: "#e8f7ee" },
];

const FACE = ["😣", "🙁", "😐", "🙂", "😄"];

function bullets(items: string[] | undefined): string {
  return (items ?? []).map((s) => `• ${s}`).join("\n");
}

export function buildJourney(spec: JourneySpec): BoardBuild<JourneyModel> {
  const warnings: string[] = [];
  let persona = spec.persona;
  let phases = spec.phases ?? [];
  if (typeof spec.text === "string" && spec.text.trim()) {
    if (phases.length) warnings.push("Both `text` and `phases` were given — the text won. Pass one or the other.");
    const parsed = parseJourneyText(spec.text);
    phases = parsed.phases;
    persona = parsed.persona ?? persona;
    warnings.push(...parsed.warnings);
  }
  const checked = checkJourney(persona, phases);
  warnings.push(...checked.warnings);
  const policies = spec.options?.policies ?? {};
  const missing = unresolved(checked.phases, policies);
  if (missing.length) warnings.push(`Nothing defines ${missing.map((n) => `\`@${n}\``).join(", ")} — drawn as written. Add it to options.policies.`);
  const drawn = fillDeep(checked.phases, policies);
  if (!spec.options?.font && needsWideCoverage(JSON.stringify(drawn) + (persona ?? ""))) {
    warnings.push("Labels use CJK/Hangul characters, which Inter cannot draw — pass options.font (e.g. \"Noto Sans KR\").");
  }

  const title = spec.title || "Customer journey";
  const n = Math.max(1, drawn.length);
  const frameW = PAD * 2 + LABEL_W + n * COL_W;
  const subtitle = [persona ? `Persona: ${persona}` : "", spec.subtitle ?? ""].filter(Boolean).join(" — ");
  const head = header(title, subtitle, frameW);
  const children: Spec[] = [...head.specs];
  const gridX = PAD + LABEL_W;
  let y = head.bottom;

  // Phase header chips.
  const chipH = 40;
  drawn.forEach((p, i) => {
    const c = tint(p.id);
    const x = gridX + i * COL_W;
    children.push(rect(`journey:${p.id}`, x + 4, y, COL_W - 8, chipH, { fill: c.soft, radius: 8 }));
    children.push(text(`journey:${p.id} label`, x + 16, y + 11, COL_W - 32, `${i + 1}. ${p.label ?? p.id}`, { size: 13, weight: "Bold", color: c.strong }));
  });
  y += chipH + 10;

  // The emotion curve: notes sit above a bad dot and below a good one, and
  // the row grows (above the scale and below it) until the tallest note fits.
  const NOTE_W = COL_W - 24;
  const SCALE_H = CURVE_H - 48;
  const noteText = (p: JourneyPhase) => `${FACE[Math.round(p.feeling ?? 0) + 2] ?? ""} ${p.feelingNote ?? ""}`.trim();
  const along = (f: number) => ((2 - f) / 4) * SCALE_H;
  let curveTop = 18;
  let curveH = CURVE_H;
  for (const p of drawn) {
    if (typeof p.feeling !== "number") continue;
    const h = textHeight(noteText(p), NOTE_W, 11);
    if (p.feeling < 0) curveTop = Math.max(curveTop, 14 + h - along(p.feeling));
  }
  for (const p of drawn) {
    if (typeof p.feeling !== "number" || p.feeling < 0) continue;
    curveH = Math.max(curveH, curveTop + along(p.feeling) + 12 + textHeight(noteText(p), NOTE_W, 11) + 16);
  }
  curveH = Math.max(curveH, curveTop + SCALE_H + 30);

  for (const row of ROWS) {
    const cellW = COL_W - 8 - CELL_PAD * 2;
    let rowH: number;
    if (row.key === "feeling") rowH = curveH;
    else {
      const hs = drawn.map((p) => textHeight(bullets(p[row.key] as string[] | undefined) || " ", cellW, 12));
      rowH = Math.max(56, ...hs.map((h) => h + CELL_PAD * 2));
    }
    const rowLabel = (spec.options?.rowLabels as Record<string, string> | undefined)?.[row.key] ?? row.label;
    children.push(text(`row ${row.key}`, PAD, y + 12, LABEL_W - 16, rowLabel, { size: 12, weight: "Semi Bold", color: INK }));
    children.push(line(`row ${row.key} rule`, [[PAD, y - 5], [frameW - PAD, y - 5]], { color: RULE, weight: 1 }));
    if (row.key === "feeling") {
      const top = y + curveTop;
      const yFor = (f: number) => top + along(f);
      children.push(line("feeling neutral", [[gridX, yFor(0)], [gridX + n * COL_W, yFor(0)]], { color: RULE, dashed: true, weight: 1 }));
      const pts: Pt[] = [];
      drawn.forEach((p, i) => {
        if (typeof p.feeling !== "number") return;
        pts.push([gridX + i * COL_W + COL_W / 2, yFor(p.feeling)]);
      });
      if (pts.length >= 2) children.push(line("feeling curve", pts, { color: "#3b5bdb", weight: 2.5 }));
      drawn.forEach((p, i) => {
        if (typeof p.feeling !== "number") return;
        const cx = gridX + i * COL_W + COL_W / 2;
        const cy = yFor(p.feeling);
        const bad = p.feeling < 0;
        children.push(ellipse(`journey:${p.id} feeling`, cx - 7, cy - 7, 14, 14, { fill: bad ? "#e03131" : p.feeling > 0 ? "#2f9e44" : "#868e96", stroke: "#ffffff", strokeWeight: 2 }));
        const note = noteText(p);
        const noteH = textHeight(note, NOTE_W, 11);
        const noteY = bad ? cy - 10 - noteH : cy + 12;
        // The curve runs through the cell the note sits in; a white backdrop
        // keeps a two-line note readable where the line crosses it.
        const noteW = Math.min(NOTE_W, Math.max(...wrap(note, NOTE_W, 11).map((l) => textWidth(l, 11))) + 8);
        children.push(rect(`journey:${p.id} feeling note bg`, cx - noteW / 2, noteY - 2, noteW, noteH + 4, { fill: "#ffffff", radius: 4 }));
        children.push(text(`journey:${p.id} feeling note`, cx - COL_W / 2 + 12, noteY, NOTE_W, note, { size: 11, color: MUTED, align: "CENTER" }));
      });
    } else {
      drawn.forEach((p, i) => {
        const items = p[row.key] as string[] | undefined;
        const x = gridX + i * COL_W + 4;
        if (row.color && items?.length) children.push(rect(`journey:${p.id} ${row.key} cell`, x, y, COL_W - 8, rowH - 10, { fill: row.color, radius: 8 }));
        else if (!row.color) children.push(rect(`journey:${p.id} ${row.key} cell`, x, y, COL_W - 8, rowH - 10, { fill: SOFT, radius: 8 }));
        if (items?.length) {
          children.push(text(`journey:${p.id} ${row.key}`, x + CELL_PAD, y + CELL_PAD - 4, COL_W - 8 - CELL_PAD * 2, bullets(items), { size: 12, color: INK, italic: row.key === "thoughts" }));
        }
      });
    }
    y += rowH + 10;
  }
  const frameH = y + PAD - 10;
  return {
    draw: {
      kind: "journey",
      name: `Journey · ${title}`,
      title,
      x: spec.x ?? 0,
      y: spec.y ?? 0,
      w: Math.round(frameW),
      h: Math.round(frameH),
      ...(spec.parentId ? { parentId: spec.parentId } : {}),
      ...(spec.options?.font ? { font: spec.options.font } : {}),
      children,
    },
    model: {
      title,
      ...(spec.subtitle ? { subtitle: spec.subtitle } : {}),
      ...(persona ? { persona } : {}),
      phases: checked.phases,
      ...(spec.options ? { options: spec.options } : {}),
    },
    warnings,
    stats: {
      phases: checked.phases.length,
      pains: checked.phases.reduce((s, p) => s + (p.pains?.length ?? 0), 0),
      ideas: checked.phases.reduce((s, p) => s + (p.ideas?.length ?? 0), 0),
      w: Math.round(frameW),
      h: Math.round(frameH),
    },
  };
}
