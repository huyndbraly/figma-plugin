/**
 * persona: the people a product is for, one card each — who they are, what
 * they want, what gets in their way — grounded in a named research source.
 *
 *   source "4 phỏng vấn, 120 khảo sát (11/2026)"
 *   persona thu "Thu Trang" primary
 *     tag Nhân viên văn phòng, 28
 *     quote "Tôi muốn đặt vé trong giờ nghỉ trưa"
 *     bio Sống ở Hà Nội, đi xem phim 2 lần/tháng
 *     fact Thiết bị: iPhone 13
 *     behav Đặt vé phút chót
 *     goal Chọn ghế đẹp nhanh
 *     pain Phí ẩn khi thanh toán
 *     need Thấy tổng tiền sớm
 *     want Tích điểm
 *     level "Thành thạo công nghệ" 4
 *     app Shopee
 */
import { lines, takeQuoted } from "../diagram/text-util.js";
import { lineHeight, needsWideCoverage } from "../diagram/metrics.js";
import { fillDeep, unresolved, type PolicyValues } from "../model/policy.js";
import { BODY, INK, MUTED, PAD, RULE, SOFT, ellipse, header, initials, rect, text, textHeight, tint, tokens, type Spec } from "../board/emit.js";
import type { BoardBuild } from "../usecase/index.js";

export interface PersonaFact {
  label: string;
  value: string;
}

export interface PersonaLevel {
  label: string;
  /** 1 … 5 */
  value: number;
}

export interface Persona {
  id: string;
  name?: string;
  primary?: boolean;
  /** One-line role / demographic, e.g. "Office worker, 28". */
  tag?: string;
  quote?: string;
  bio?: string;
  facts?: PersonaFact[];
  behaviors?: string[];
  goals?: string[];
  pains?: string[];
  needs?: string[];
  wants?: string[];
  levels?: PersonaLevel[];
  apps?: string[];
}

export interface PersonaSpec {
  title?: string;
  subtitle?: string;
  source?: string;
  personas?: Persona[];
  text?: string;
  x?: number;
  y?: number;
  parentId?: string;
  options?: { font?: string; dryRun?: boolean; policies?: PolicyValues; [k: string]: unknown };
}

export interface PersonaModel {
  title: string;
  subtitle?: string;
  source?: string;
  personas: Persona[];
  options?: PersonaSpec["options"];
}

const LIST_KEYS: Record<string, keyof Persona> = {
  behav: "behaviors",
  behavior: "behaviors",
  goal: "goals",
  pain: "pains",
  need: "needs",
  want: "wants",
  app: "apps",
};

function body(t: string, word: string): string {
  const b = t.slice(word.length).trim();
  const q = takeQuoted(b);
  return (q.value !== undefined && !q.rest ? q.value : b).trim();
}

export function parsePersonaText(src: string): { source?: string; personas: Persona[]; warnings: string[] } {
  const personas: Persona[] = [];
  const warnings: string[] = [];
  let source: string | undefined;
  let cur: Persona | undefined;
  for (const l of lines(src)) {
    const t = l.text;
    const word = (/^(\w+)/.exec(t)?.[1] ?? "").toLowerCase();
    if (word === "source") {
      source = body(t, "source");
      continue;
    }
    if (word === "persona") {
      const m = /^persona\s+([\w.-]+)\s*(.*)$/.exec(t);
      if (!m) {
        warnings.push(`persona text, line ${l.no}: a persona needs an id — \`persona thu "Thu Trang" primary\`.`);
        continue;
      }
      const q = takeQuoted(m[2] ?? "");
      cur = { id: m[1]!, ...(q.value ? { name: q.value } : {}) };
      for (const w of q.rest.split(/\s+/).filter(Boolean)) {
        if (w === "primary") cur.primary = true;
        else warnings.push(`persona text, line ${l.no}: unknown word "${w}" — only \`primary\` may follow the name.`);
      }
      personas.push(cur);
      continue;
    }
    if (!cur) {
      warnings.push(`persona text, line ${l.no}: "${word}" before any \`persona\` — skipped.`);
      continue;
    }
    if (word === "tag" || word === "quote" || word === "bio") {
      cur[word] = body(t, word);
      continue;
    }
    if (word === "fact") {
      const raw = t.slice(4).trim();
      const tk = tokens(raw);
      if (tk.length >= 2 && raw.trim().startsWith('"')) cur.facts = [...(cur.facts ?? []), { label: tk[0]!, value: tk.slice(1).join(" ") }];
      else {
        const i = raw.indexOf(":");
        cur.facts = [...(cur.facts ?? []), i > 0 ? { label: raw.slice(0, i).trim(), value: raw.slice(i + 1).trim() } : { label: "", value: raw }];
      }
      continue;
    }
    if (word === "level") {
      const tk = tokens(t.slice(5).trim());
      const v = Number(tk[tk.length - 1]);
      if (tk.length < 2 || !Number.isFinite(v)) {
        warnings.push(`persona text, line ${l.no}: \`level\` needs a label and a 1–5 value — \`level "Tech savvy" 4\`.`);
        continue;
      }
      cur.levels = [...(cur.levels ?? []), { label: tk.slice(0, -1).join(" "), value: v }];
      continue;
    }
    const key = LIST_KEYS[word];
    if (key) {
      const v = body(t, word);
      if (v) (cur as unknown as Record<string, string[]>)[key] = [...((cur[key] as string[] | undefined) ?? []), v];
      continue;
    }
    warnings.push(`persona text, line ${l.no}: not understood, skipped — ${t}`);
  }
  return { ...(source ? { source } : {}), personas, warnings };
}

export function checkPersonas(source: string | undefined, personas: Persona[]): { personas: Persona[]; warnings: string[] } {
  const warnings: string[] = [];
  const out: Persona[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const p of personas) {
    if (!p?.id) continue;
    if (ids.has(p.id)) {
      warnings.push(`Two personas are both "${p.id}" — kept the first.`);
      continue;
    }
    ids.add(p.id);
    const q: Persona = { ...p };
    const name = q.name ?? q.id;
    if (names.has(name.toLowerCase())) warnings.push(`Two personas are named "${name}" — people tell them apart by name.`);
    names.add(name.toLowerCase());
    if (q.levels) {
      q.levels = q.levels.map((lv) => {
        if (lv.value < 1 || lv.value > 5) {
          warnings.push(`${name}: level "${lv.label}" = ${lv.value} is outside 1–5 — clamped.`);
          return { ...lv, value: Math.max(1, Math.min(5, lv.value)) };
        }
        return lv;
      });
    }
    if (!q.goals?.length) warnings.push(`${name} has no goal — a persona without a goal cannot guide a design decision.`);
    if (!q.pains?.length) warnings.push(`${name} has no pain — what stops them today?`);
    out.push(q);
  }
  if (!out.length) warnings.push("No personas — add at least one `persona`.");
  const primaries = out.filter((p) => p.primary).length;
  if (out.length > 1 && primaries === 0) warnings.push("No persona is `primary` — when they disagree, whose need wins?");
  if (primaries > 1) warnings.push(`${primaries} personas are primary — pick one; "primary" means the one you design for when they conflict.`);
  if (!source) warnings.push("No `source` — personas without research behind them are assumptions; say where they come from.");
  return { personas: out, warnings };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const CARD_W = 340;
const CARD_GAP = 28;
const IN = 22;

const SECTIONS: Array<{ key: keyof Persona; label: string; color: string }> = [
  { key: "goals", label: "Goals", color: "#2f9e44" },
  { key: "pains", label: "Pain points", color: "#e03131" },
  { key: "needs", label: "Needs", color: "#1c7ed6" },
  { key: "wants", label: "Wants", color: "#7048e8" },
  { key: "behaviors", label: "Behaviours", color: "#e8590c" },
];

function cardSpecs(p: Persona, x: number, y0: number, sectionLabels: Record<string, string> | undefined): { specs: Spec[]; h: number } {
  const specs: Spec[] = [];
  const name = p.name ?? p.id;
  const c = tint(p.id);
  const innerW = CARD_W - IN * 2;
  let y = y0 + IN;
  specs.push(ellipse(`persona:${p.id} avatar`, x + IN, y, 56, 56, { fill: c.soft }));
  specs.push(text(`persona:${p.id} initials`, x + IN, y + 17, 56, initials(name), { size: 18, weight: "Bold", color: c.strong, align: "CENTER" }));
  const nameX = x + IN + 70;
  const nameW = innerW - 70;
  specs.push(text(`persona:${p.id} name`, nameX, y + 4, nameW, name, { size: 18, weight: "Bold", color: INK }));
  let ny = y + 4 + textHeight(name, nameW, 18);
  if (p.tag) {
    specs.push(text(`persona:${p.id} tag`, nameX, ny + 2, nameW, p.tag, { size: 12, color: MUTED }));
    ny += 2 + textHeight(p.tag, nameW, 12);
  }
  if (p.primary) {
    specs.push(rect(`persona:${p.id} primary`, nameX, ny + 6, 64, 20, { fill: "#fff3bf", radius: 10 }));
    specs.push(text(`persona:${p.id} primary label`, nameX, ny + 9, 64, "PRIMARY", { size: 10, weight: "Bold", color: "#a35c00", align: "CENTER" }));
    ny += 28;
  }
  y = Math.max(y + 56, ny) + 16;
  if (p.quote) {
    specs.push(rect(`persona:${p.id} quote bar`, x + IN, y, 3, textHeight(`“${p.quote}”`, innerW - 14, 13), { fill: c.strong }));
    specs.push(text(`persona:${p.id} quote`, x + IN + 14, y, innerW - 14, `“${p.quote}”`, { size: 13, italic: true, color: INK }));
    y += textHeight(`“${p.quote}”`, innerW - 14, 13) + 14;
  }
  if (p.bio) {
    specs.push(text(`persona:${p.id} bio`, x + IN, y, innerW, p.bio, { size: 12, color: BODY }));
    y += textHeight(p.bio, innerW, 12) + 12;
  }
  if (p.facts?.length) {
    for (const f of p.facts) {
      const lw = f.label ? 110 : 0;
      if (f.label) specs.push(text(`persona:${p.id} fact label`, x + IN, y, lw - 8, f.label, { size: 11, weight: "Semi Bold", color: MUTED }));
      specs.push(text(`persona:${p.id} fact`, x + IN + lw, y, innerW - lw, f.value, { size: 12, color: INK }));
      y += Math.max(textHeight(f.label || " ", Math.max(20, lw - 8), 11), textHeight(f.value, innerW - lw, 12)) + 4;
    }
    y += 8;
  }
  for (const s of SECTIONS) {
    const items = p[s.key] as string[] | undefined;
    if (!items?.length) continue;
    specs.push(rect(`persona:${p.id} ${s.key} rule`, x + IN, y, innerW, 1, { fill: RULE }));
    y += 10;
    specs.push(text(`persona:${p.id} ${s.key} title`, x + IN, y, innerW, (sectionLabels?.[s.key] ?? s.label).toUpperCase(), { size: 10, weight: "Bold", color: s.color }));
    y += lineHeight(11) + 4;
    const list = items.map((i) => `• ${i}`).join("\n");
    specs.push(text(`persona:${p.id} ${s.key}`, x + IN, y, innerW, list, { size: 12, color: INK }));
    y += textHeight(list, innerW, 12) + 12;
  }
  if (p.levels?.length) {
    specs.push(rect(`persona:${p.id} levels rule`, x + IN, y, innerW, 1, { fill: RULE }));
    y += 12;
    for (const lv of p.levels) {
      const lw = 130;
      specs.push(text(`persona:${p.id} level label`, x + IN, y, lw - 8, lv.label, { size: 11, color: BODY }));
      const barX = x + IN + lw;
      const barW = innerW - lw;
      specs.push(rect(`persona:${p.id} level track`, barX, y + 5, barW, 6, { fill: SOFT, radius: 3 }));
      specs.push(rect(`persona:${p.id} level value`, barX, y + 5, Math.max(6, (barW * lv.value) / 5), 6, { fill: c.strong, radius: 3 }));
      y += Math.max(18, textHeight(lv.label, lw - 8, 11)) + 4;
    }
    y += 8;
  }
  if (p.apps?.length) {
    let cx = x + IN;
    let rowY = y;
    for (const a of p.apps) {
      const w = Math.min(innerW, Math.max(40, a.length * 7 + 20));
      if (cx + w > x + IN + innerW) {
        cx = x + IN;
        rowY += 28;
      }
      specs.push(rect(`persona:${p.id} app`, cx, rowY, w, 22, { fill: SOFT, radius: 11 }));
      specs.push(text(`persona:${p.id} app label`, cx, rowY + 4, w, a, { size: 11, color: BODY, align: "CENTER" }));
      cx += w + 6;
    }
    y = rowY + 22 + 12;
  }
  const h = y - y0 + IN - 12;
  specs.unshift({ ...rect(`persona:${p.id}`, x, y0, CARD_W, h, { fill: "#ffffff", stroke: p.primary ? c.strong : RULE, radius: 14, strokeWeight: p.primary ? 2 : 1 }) });
  return { specs, h };
}

export function buildPersona(spec: PersonaSpec): BoardBuild<PersonaModel> {
  const warnings: string[] = [];
  let source = spec.source;
  let personas = spec.personas ?? [];
  if (typeof spec.text === "string" && spec.text.trim()) {
    if (personas.length) warnings.push("Both `text` and `personas` were given — the text won. Pass one or the other.");
    const parsed = parsePersonaText(spec.text);
    personas = parsed.personas;
    source = parsed.source ?? source;
    warnings.push(...parsed.warnings);
  }
  const checked = checkPersonas(source, personas);
  warnings.push(...checked.warnings);
  const policies = spec.options?.policies ?? {};
  const missing = unresolved(checked.personas, policies);
  if (missing.length) warnings.push(`Nothing defines ${missing.map((n) => `\`@${n}\``).join(", ")} — drawn as written. Add it to options.policies.`);
  const drawn = fillDeep(checked.personas, policies);
  if (!spec.options?.font && needsWideCoverage(JSON.stringify(drawn))) {
    warnings.push("Labels use CJK/Hangul characters, which Inter cannot draw — pass options.font (e.g. \"Noto Sans KR\").");
  }
  // Primary first: it is the one read first.
  const ordered = drawn.slice().sort((a, b) => Number(!!b.primary) - Number(!!a.primary));
  const n = Math.max(1, ordered.length);
  const frameW = PAD * 2 + n * CARD_W + (n - 1) * CARD_GAP;
  const title = spec.title || "Personas";
  const subtitle = [spec.subtitle ?? "", source ? `Source: ${source}` : ""].filter(Boolean).join(" — ");
  const head = header(title, subtitle, frameW);
  const children: Spec[] = [...head.specs];
  let maxH = 0;
  const labels = spec.options?.sectionLabels as Record<string, string> | undefined;
  ordered.forEach((p, i) => {
    const card = cardSpecs(p, PAD + i * (CARD_W + CARD_GAP), head.bottom, labels);
    children.push(...card.specs);
    maxH = Math.max(maxH, card.h);
  });
  const frameH = head.bottom + maxH + PAD;
  return {
    draw: {
      kind: "persona",
      name: `Persona · ${title}`,
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
      ...(source ? { source } : {}),
      personas: checked.personas,
      ...(spec.options ? { options: spec.options } : {}),
    },
    warnings,
    stats: { personas: checked.personas.length, primary: checked.personas.filter((p) => p.primary).length, w: Math.round(frameW), h: Math.round(frameH) },
  };
}
