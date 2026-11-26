/**
 * usecase: who uses the system for what — actors, use cases inside a system
 * boundary, and the association / «include» / «extend» / generalization
 * links between them. The agent supplies the model; this module checks it,
 * lays it out and emits create() specs for the board handler.
 *
 *   system "Ticketing"
 *   actor visitor "Visitor"
 *   actor pay "Payment gateway" system
 *   uc book "Book seats"
 *   uc hold "Hold seats"
 *   uc login "Log in"
 *   visitor - book
 *   book => hold          # book «include» hold
 *   login +> book         # login «extend» book
 *   member :> visitor     # member is a kind of visitor
 *   book - pay
 */
import { lines, splitDetail, takeQuoted } from "../diagram/text-util.js";
import { lineHeight, needsWideCoverage, textWidth } from "../diagram/metrics.js";
import { fillDeep, unresolved, type PolicyValues } from "../model/policy.js";
import { BODY, INK, MUTED, PAD, RULE, ellipse, header, line, rect, text, textHeight, wrap, type Pt, type Spec } from "../board/emit.js";

export interface UcActor {
  id: string;
  name?: string;
  /** human (stick figure, default) or system (a box) — a system is a secondary actor. */
  kind?: "human" | "system";
  /** Which side of the boundary; default: humans left, systems right. */
  side?: "left" | "right";
  detail?: string;
}

export interface UcCase {
  id: string;
  label?: string;
  detail?: string;
}

export type UcLinkKind = "association" | "include" | "extend" | "generalization";

export interface UcLink {
  from: string;
  to: string;
  kind?: UcLinkKind;
  label?: string;
}

export interface UsecaseSpec {
  title?: string;
  subtitle?: string;
  system?: string;
  actors?: UcActor[];
  useCases?: UcCase[];
  links?: UcLink[];
  text?: string;
  x?: number;
  y?: number;
  parentId?: string;
  options?: { font?: string; dryRun?: boolean; policies?: PolicyValues; [k: string]: unknown };
}

export interface UsecaseModel {
  title: string;
  subtitle?: string;
  system?: string;
  actors: UcActor[];
  useCases: UcCase[];
  links: UcLink[];
  options?: UsecaseSpec["options"];
}

export interface BoardBuild<M> {
  draw: { kind: string; name: string; title: string; x: number; y: number; w: number; h: number; parentId?: string; font?: string; children: Spec[] };
  model: M;
  warnings: string[];
  stats: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const LINK = /^([\w.-]+)\s*(=>|\+>|:>|-)\s*([\w.-]+)\s*(?::\s*(.*))?$/;
const LINK_KIND: Record<string, UcLinkKind> = { "-": "association", "=>": "include", "+>": "extend", ":>": "generalization" };

export function parseUsecaseText(src: string): { system?: string; actors: UcActor[]; useCases: UcCase[]; links: UcLink[]; warnings: string[] } {
  const actors: UcActor[] = [];
  const useCases: UcCase[] = [];
  const links: UcLink[] = [];
  const warnings: string[] = [];
  let system: string | undefined;
  for (const l of lines(src)) {
    const t = l.text;
    if (/^system\b/.test(t)) {
      system = takeQuoted(t.slice(6)).value ?? t.slice(6).trim();
      continue;
    }
    const decl = /^(actor|uc|usecase)\s+([\w.-]+)\s*(.*)$/.exec(t);
    if (decl) {
      const { head, detail } = splitDetail(decl[3] ?? "");
      const q = takeQuoted(head);
      const words = q.rest.split(/\s+/).filter(Boolean);
      if (decl[1] === "actor") {
        const a: UcActor = { id: decl[2]!, ...(q.value ? { name: q.value } : {}), ...(detail ? { detail } : {}) };
        for (const w of words) {
          if (w === "system" || w === "external") a.kind = "system";
          else if (w === "human" || w === "person") a.kind = "human";
          else if (w === "left" || w === "right") a.side = w;
          else warnings.push(`usecase text, line ${l.no}: unknown word "${w}" on an actor — use system | left | right.`);
        }
        actors.push(a);
      } else {
        useCases.push({ id: decl[2]!, ...(q.value ? { label: q.value } : {}), ...(detail ? { detail } : {}) });
        if (words.length) warnings.push(`usecase text, line ${l.no}: ignored "${words.join(" ")}" after the use case label.`);
      }
      continue;
    }
    const q = takeQuoted(t);
    const m = LINK.exec(q.rest);
    if (m) {
      links.push({ from: m[1]!, to: m[3]!, kind: LINK_KIND[m[2]!]!, ...((m[4] ?? q.value) ? { label: (m[4] ?? q.value)!.trim() } : {}) });
      continue;
    }
    warnings.push(`usecase text, line ${l.no}: not understood, skipped — ${t}`);
  }
  return { ...(system ? { system } : {}), actors, useCases, links, warnings };
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

export function checkUsecase(spec: { actors: UcActor[]; useCases: UcCase[]; links: UcLink[] }): { actors: UcActor[]; useCases: UcCase[]; links: UcLink[]; warnings: string[] } {
  const warnings: string[] = [];
  const actors: UcActor[] = [];
  const useCases: UcCase[] = [];
  const seen = new Set<string>();
  for (const a of spec.actors) {
    if (!a?.id) continue;
    if (seen.has(a.id)) {
      warnings.push(`Two things are both "${a.id}" — kept the first; ids are shared by actors and use cases.`);
      continue;
    }
    seen.add(a.id);
    actors.push({ ...a });
  }
  for (const u of spec.useCases) {
    if (!u?.id) continue;
    if (seen.has(u.id)) {
      warnings.push(`Two things are both "${u.id}" — kept the first; ids are shared by actors and use cases.`);
      continue;
    }
    seen.add(u.id);
    useCases.push({ ...u });
  }
  const isActor = (id: string) => actors.some((a) => a.id === id);
  const isCase = (id: string) => useCases.some((u) => u.id === id);

  // Ids that exist only in links are generated — the compact form promises
  // it — but only where the other end makes the type unambiguous.
  for (const l of spec.links) {
    const kind = l.kind ?? "association";
    for (const [id, other] of [[l.from, l.to], [l.to, l.from]] as const) {
      if (!id || seen.has(id)) continue;
      if (kind === "include" || kind === "extend") {
        useCases.push({ id });
        seen.add(id);
      } else if (kind === "association" && isCase(other)) {
        actors.push({ id });
        seen.add(id);
      } else if (kind === "association" && isActor(other)) {
        useCases.push({ id });
        seen.add(id);
      } else if (kind === "generalization" && isActor(other)) {
        actors.push({ id });
        seen.add(id);
      } else if (kind === "generalization" && isCase(other)) {
        useCases.push({ id });
        seen.add(id);
      }
    }
  }

  const links: UcLink[] = [];
  for (const l of spec.links) {
    const kind = l.kind ?? "association";
    const tag = `${l.from} ${kind} ${l.to}`;
    if (!seen.has(l.from) || !seen.has(l.to)) {
      warnings.push(`Link ${tag} names something that does not exist — dropped. Declare it with \`actor\` or \`uc\`.`);
      continue;
    }
    if (l.from === l.to) {
      warnings.push(`Link ${tag} connects "${l.from}" to itself — dropped.`);
      continue;
    }
    if (kind === "association" && isActor(l.from) === isActor(l.to)) {
      warnings.push(`Association ${tag} must join an ACTOR to a USE CASE — dropped. Use cases relate by «include»/«extend» (=> / +>), actors by generalization (:>).`);
      continue;
    }
    if ((kind === "include" || kind === "extend") && (!isCase(l.from) || !isCase(l.to))) {
      warnings.push(`«${kind}» ${tag} must join two use cases — dropped.`);
      continue;
    }
    if (kind === "generalization" && isActor(l.from) !== isActor(l.to)) {
      warnings.push(`Generalization ${tag} must join two actors or two use cases — dropped.`);
      continue;
    }
    // Association always reads actor → use case, whichever way it was written.
    links.push(kind === "association" && isCase(l.from) ? { ...l, from: l.to, to: l.from, kind } : { ...l, kind });
  }

  // Who does what: an actor inherits what its parent does.
  const parentOf = new Map<string, string[]>();
  for (const l of links) if (l.kind === "generalization") parentOf.set(l.from, [...(parentOf.get(l.from) ?? []), l.to]);
  const acts = (id: string, depth = 0): boolean =>
    links.some((l) => l.kind === "association" && l.from === id) || (depth < 8 && (parentOf.get(id) ?? []).some((p) => acts(p, depth + 1)));
  for (const a of actors) {
    if (!acts(a.id) && !links.some((l) => l.kind === "generalization" && l.to === a.id)) {
      warnings.push(`Actor "${a.name ?? a.id}" uses nothing — give it an association to the use case it starts, or remove it.`);
    }
  }

  // Which use cases somebody can reach: associated, or pulled in by include /
  // extend / generalization from one that is.
  const reached = new Set(links.filter((l) => l.kind === "association").map((l) => l.to));
  for (let changed = true; changed; ) {
    changed = false;
    for (const l of links) {
      if (l.kind === "include" && reached.has(l.from) && !reached.has(l.to)) (reached.add(l.to), (changed = true));
      if (l.kind === "extend" && reached.has(l.to) && !reached.has(l.from)) (reached.add(l.from), (changed = true));
      if (l.kind === "generalization" && reached.has(l.to) && !reached.has(l.from)) (reached.add(l.from), (changed = true));
    }
  }
  for (const u of useCases) {
    if (!reached.has(u.id)) warnings.push(`Use case "${u.label ?? u.id}" has no actor and nothing includes or extends it — nobody can start it.`);
  }

  // «include» cycles mean "to do A you must do B, which needs A".
  const inc = new Map<string, string[]>();
  for (const l of links) if (l.kind === "include") inc.set(l.from, [...(inc.get(l.from) ?? []), l.to]);
  const visiting = new Set<string>();
  const done = new Set<string>();
  const cycle = (id: string, path: string[]): string[] | null => {
    if (visiting.has(id)) return [...path.slice(path.indexOf(id)), id];
    if (done.has(id)) return null;
    visiting.add(id);
    for (const n of inc.get(id) ?? []) {
      const c = cycle(n, [...path, id]);
      if (c) return c;
    }
    visiting.delete(id);
    done.add(id);
    return null;
  };
  for (const id of inc.keys()) {
    const c = cycle(id, []);
    if (c) {
      warnings.push(`«include» goes round in a circle: ${c.join(" → ")}. An included use case cannot need the one that includes it.`);
      break;
    }
  }
  return { actors, useCases, links, warnings };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const ACTOR_W = 140;
const ACTOR_H = 120;
const UC_GAP = 26;
const COL_GAP = 90;
const BOUND_PAD = 36;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function caseSize(u: UcCase): { w: number; h: number; lines: string[] } {
  const label = u.label ?? u.id;
  const w = Math.max(150, Math.min(240, textWidth(label, 13) + 56));
  const ls = wrap(label, w - 44, 13);
  const detailH = u.detail ? textHeight(u.detail, w - 44, 11) : 0;
  return { w, h: Math.max(60, ls.length * lineHeight(13) + detailH + 30), lines: ls };
}

function ellipsePoint(b: Box, toward: Pt): Pt {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const dx = toward[0] - cx;
  const dy = toward[1] - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const t = 1 / Math.sqrt((dx / (b.w / 2)) ** 2 + (dy / (b.h / 2)) ** 2);
  return [cx + dx * t, cy + dy * t];
}

function center(b: Box): Pt {
  return [b.x + b.w / 2, b.y + b.h / 2];
}

function actorSpecs(a: UcActor, x: number, y: number): { specs: Spec[]; anchor: { left: Pt; right: Pt } } {
  const name = a.name ?? a.id;
  const specs: Spec[] = [];
  const cx = x + ACTOR_W / 2;
  if (a.kind === "system") {
    specs.push({ ...rect(`usecase:${a.id}`, cx - 40, y + 8, 80, 52, { fill: "#f5f7fa", stroke: MUTED, radius: 6 }) });
    specs.push(text(`usecase:${a.id} stereotype`, cx - 40, y + 14, 80, "«system»", { size: 10, color: MUTED, align: "CENTER" }));
  } else {
    specs.push(ellipse(`usecase:${a.id}`, cx - 11, y, 22, 22, { stroke: INK, fill: "#ffffff" }));
    specs.push(line(`usecase:${a.id} body`, [[cx, y + 22], [cx, y + 48]], { color: INK }));
    specs.push(line(`usecase:${a.id} arms`, [[cx - 18, y + 32], [cx + 18, y + 32]], { color: INK }));
    specs.push(line(`usecase:${a.id} legs`, [[cx - 16, y + 68], [cx, y + 48], [cx + 16, y + 68]], { color: INK }));
  }
  specs.push(text(`usecase:${a.id} name`, x, y + 74, ACTOR_W, name, { size: 12, weight: "Semi Bold", color: INK, align: "CENTER" }));
  if (a.detail) specs.push(text(`usecase:${a.id} detail`, x, y + 74 + textHeight(name, ACTOR_W, 12) + 2, ACTOR_W, a.detail, { size: 11, color: MUTED, align: "CENTER" }));
  const shoulder = y + 34;
  return { specs, anchor: { left: [cx - 24, shoulder], right: [cx + 24, shoulder] } };
}

export function buildUsecase(spec: UsecaseSpec): BoardBuild<UsecaseModel> {
  const warnings: string[] = [];
  let input = { system: spec.system, actors: spec.actors ?? [], useCases: spec.useCases ?? [], links: spec.links ?? [] };
  if (typeof spec.text === "string" && spec.text.trim()) {
    if (input.actors.length || input.useCases.length) warnings.push("Both `text` and arrays were given — the text won. Pass one or the other.");
    const parsed = parseUsecaseText(spec.text);
    input = { system: parsed.system ?? spec.system, actors: parsed.actors, useCases: parsed.useCases, links: parsed.links };
    warnings.push(...parsed.warnings);
  }
  const checked = checkUsecase(input);
  warnings.push(...checked.warnings);
  if (!checked.useCases.length) warnings.push("No use cases — a use case diagram needs at least one `uc`.");

  const policies = spec.options?.policies ?? {};
  const missing = unresolved({ actors: checked.actors, useCases: checked.useCases, links: checked.links }, policies);
  if (missing.length) warnings.push(`Nothing defines ${missing.map((n) => `\`@${n}\``).join(", ")} — drawn as written. Add it to options.policies.`);
  const drawn = fillDeep({ actors: checked.actors, useCases: checked.useCases, links: checked.links, system: input.system }, policies);

  if (!spec.options?.font) {
    const all = [...drawn.actors.map((a) => a.name ?? a.id), ...drawn.useCases.map((u) => u.label ?? u.id), drawn.system ?? ""].join(" ");
    if (needsWideCoverage(all)) warnings.push("Labels use CJK/Hangul characters, which Inter cannot draw — pass options.font (e.g. \"Noto Sans KR\").");
  }

  // Sides: humans left, systems right, unless told otherwise.
  const left = drawn.actors.filter((a) => (a.side ?? (a.kind === "system" ? "right" : "left")) === "left");
  const right = drawn.actors.filter((a) => (a.side ?? (a.kind === "system" ? "right" : "left")) === "right");

  // Primary column: use cases an actor reaches directly; secondary: the ones
  // only pulled in by «include»/«extend», placed beside the case they serve.
  const associated = new Set(drawn.links.filter((l) => l.kind === "association" || (l.kind === "generalization" && drawn.useCases.some((u) => u.id === l.to))).map((l) => (l.kind === "association" ? l.to : l.from)));
  const primary = drawn.useCases.filter((u) => associated.has(u.id) || !drawn.links.some((l) => (l.kind === "include" && l.to === u.id) || (l.kind === "extend" && l.from === u.id)));
  const secondary = drawn.useCases.filter((u) => !primary.includes(u));
  // Order the primary column by where its actors stand, so lines cross less.
  const actorRank = new Map<string, number>();
  left.forEach((a, i) => actorRank.set(a.id, i));
  right.forEach((a, i) => actorRank.set(a.id, i));
  const rank = (u: UcCase) => {
    const r = drawn.links.filter((l) => l.kind === "association" && l.to === u.id).map((l) => actorRank.get(l.from) ?? 0);
    return r.length ? r.reduce((s, v) => s + v, 0) / r.length : Number.MAX_SAFE_INTEGER;
  };
  primary.sort((a, b) => rank(a) - rank(b));

  const sizes = new Map(drawn.useCases.map((u) => [u.id, caseSize(u)]));
  const colW = (us: UcCase[]) => us.reduce((m, u) => Math.max(m, sizes.get(u.id)!.w), 0);
  const priW = Math.max(150, colW(primary));
  const secW = secondary.length ? colW(secondary) : 0;

  const title = spec.title || drawn.system || "Use cases";
  const boundW = BOUND_PAD * 2 + priW + (secondary.length ? COL_GAP + secW : 0);
  const leftW = left.length ? ACTOR_W + 70 : 0;
  const rightW = right.length ? ACTOR_W + 70 : 0;
  const frameW = Math.max(520, PAD * 2 + leftW + boundW + rightW);
  const head = header(title, spec.subtitle ?? "", frameW);
  const boundX = PAD + leftW;
  const boundY = head.bottom + 8;
  const sysLabelH = drawn.system ? lineHeight(14) + 14 : 0;

  // Stack the primary column, then hang each secondary case beside the first
  // case that includes it / that it extends.
  const boxes = new Map<string, Box>();
  let y = boundY + BOUND_PAD + sysLabelH;
  for (const u of primary) {
    const s = sizes.get(u.id)!;
    boxes.set(u.id, { x: boundX + BOUND_PAD + (priW - s.w) / 2, y, w: s.w, h: s.h });
    y += s.h + UC_GAP;
  }
  let secY = boundY + BOUND_PAD + sysLabelH;
  const secX = boundX + BOUND_PAD + priW + COL_GAP;
  for (const u of secondary) {
    const s = sizes.get(u.id)!;
    const base = drawn.links.find((l) => (l.kind === "include" && l.to === u.id) || (l.kind === "extend" && l.from === u.id));
    const anchorId = base ? (base.kind === "include" ? base.from : base.to) : undefined;
    const anchor = anchorId ? boxes.get(anchorId) : undefined;
    const want = anchor ? anchor.y + anchor.h / 2 - s.h / 2 : secY;
    const at = Math.max(want, secY);
    boxes.set(u.id, { x: secX + (secW - s.w) / 2, y: at, w: s.w, h: s.h });
    secY = at + s.h + UC_GAP;
  }
  const contentBottom = Math.max(y, secY) - UC_GAP + BOUND_PAD;
  const boundH = Math.max(contentBottom - boundY, ACTOR_H * Math.max(left.length, right.length, 1) + BOUND_PAD);

  // Actors centred on the boundary's height.
  const actorBlock = (list: UcActor[]) => list.length * ACTOR_H;
  const actorY0 = (list: UcActor[]) => boundY + Math.max(0, (boundH - actorBlock(list)) / 2);
  const anchors = new Map<string, Pt>();
  /** Where each actor stands: figure centre x, top of the head, bottom of its name. */
  const figures = new Map<string, { cx: number; top: number; bottom: number }>();
  const actorSpecsAll: Spec[] = [];
  const place = (a: UcActor, x: number, y: number, side: "left" | "right") => {
    const r = actorSpecs(a, x, y);
    actorSpecsAll.push(...r.specs);
    anchors.set(a.id, side === "left" ? r.anchor.right : r.anchor.left);
    const nameH = textHeight(a.name ?? a.id, ACTOR_W, 12);
    figures.set(a.id, { cx: x + ACTOR_W / 2, top: y, bottom: y + 74 + nameH + 4 });
  };
  left.forEach((a, i) => place(a, PAD, actorY0(left) + i * ACTOR_H, "left"));
  right.forEach((a, i) => place(a, boundX + boundW + 70, actorY0(right) + i * ACTOR_H, "right"));

  /**
   * A straight line from an actor that passes through ANOTHER use case reads
   * as a link to that one (the ellipse is painted over the line). Detour
   * above or below the first ellipse in the way.
   */
  const blockedBy = (a: Pt, b: Pt, skip: string): Box | undefined => {
    for (const [id, box] of boxes) {
      if (id === skip) continue;
      const rx = box.w / 2 + 6;
      const ry = box.h / 2 + 6;
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      for (let t = 0.04; t < 0.96; t += 0.02) {
        const x = a[0] + (b[0] - a[0]) * t;
        const y = a[1] + (b[1] - a[1]) * t;
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) return box;
      }
    }
    return undefined;
  };
  const routeTo = (from: Pt, target: Box, targetId: string): Pt[] => {
    const direct = ellipsePoint(target, from);
    const hit = blockedBy(from, direct, targetId);
    if (!hit) return [from, direct];
    const cx = hit.x + hit.w / 2;
    const above: Pt = [cx, hit.y - 14];
    const below: Pt = [cx, hit.y + hit.h + 14];
    const targetCy = target.y + target.h / 2;
    const wp = Math.abs(above[1] - targetCy) <= Math.abs(below[1] - targetCy) ? above : below;
    return [from, wp, ellipsePoint(target, wp)];
  };

  const children: Spec[] = [...head.specs];
  children.push(rect("system boundary", boundX, boundY, boundW, boundH, { fill: "#fbfcfd", stroke: RULE, radius: 12 }));
  if (drawn.system) children.push(text("system name", boundX + BOUND_PAD, boundY + 14, boundW - BOUND_PAD * 2, drawn.system, { size: 14, weight: "Bold", color: INK }));

  // Lines under the shapes.
  for (const l of drawn.links) {
    const name = `link ${l.from} ${l.kind} ${l.to}`;
    if (l.kind === "association") {
      const from = anchors.get(l.from);
      const to = boxes.get(l.to);
      if (!from || !to) continue;
      children.push(line(name, routeTo(from, to, l.to), { color: MUTED }));
    } else if (l.kind === "generalization") {
      const isActorLink = anchors.has(l.from);
      let start: Pt;
      let tip: Pt;
      if (isActorLink) {
        const c = figures.get(l.from);
        const p = figures.get(l.to);
        if (!c || !p) continue;
        // Stacked on one side: head of the child straight up to under the
        // parent's name. Otherwise centre to centre.
        if (Math.abs(c.cx - p.cx) < 1) {
          start = c.top > p.top ? [c.cx, c.top - 4] : [c.cx, c.bottom];
          tip = c.top > p.top ? [p.cx, p.bottom] : [p.cx, p.top - 4];
        } else {
          start = [c.cx, (c.top + c.bottom) / 2];
          tip = [p.cx + (c.cx > p.cx ? 30 : -30), (p.top + p.bottom) / 2];
        }
      } else {
        const a = boxes.get(l.from);
        const b = boxes.get(l.to);
        if (!a || !b) continue;
        start = ellipsePoint(a, center(b));
        tip = ellipsePoint(b, center(a));
      }
      const dx = tip[0] - start[0];
      const dy = tip[1] - start[1];
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const baseP: Pt = [tip[0] - ux * 14, tip[1] - uy * 14];
      children.push(line(name, [start, baseP], { color: MUTED }));
      children.push(line(`${name} head`, [tip, [baseP[0] + uy * 8, baseP[1] - ux * 8], [baseP[0] - uy * 8, baseP[1] + ux * 8]], { color: MUTED, closed: true, fill: "#ffffff" }));
    } else {
      // «include»: base → included. «extend»: extension → base. Arrow at `to`.
      const a = boxes.get(l.from);
      const b = boxes.get(l.to);
      if (!a || !b) continue;
      const p1 = ellipsePoint(a, center(b));
      const p2 = ellipsePoint(b, center(a));
      children.push(line(name, [p1, p2], { color: MUTED, dashed: true, arrow: "line" }));
      const mx = (p1[0] + p2[0]) / 2;
      const my = (p1[1] + p2[1]) / 2;
      children.push(text(`${name} label`, mx - 50, my - 18, 100, l.label ? `«${l.kind}» ${l.label}` : `«${l.kind}»`, { size: 10, color: MUTED, align: "CENTER" }));
    }
  }
  for (const l of drawn.links) {
    if (l.kind === "association" && l.label) {
      const from = anchors.get(l.from);
      const to = boxes.get(l.to);
      if (!from || !to) continue;
      const path = routeTo(from, to, l.to);
      const p = path[path.length - 1]!;
      children.push(text(`link ${l.from} ${l.to} label`, (from[0] + p[0]) / 2 - 50, (from[1] + p[1]) / 2 - 18, 100, l.label, { size: 10, color: MUTED, align: "CENTER" }));
    }
  }
  children.push(...actorSpecsAll);
  for (const u of drawn.useCases) {
    const b = boxes.get(u.id)!;
    const s = sizes.get(u.id)!;
    children.push(ellipse(`usecase:${u.id}`, b.x, b.y, b.w, b.h, { fill: "#eef4ff", stroke: "#3b5bdb" }));
    const textH = s.lines.length * lineHeight(13) + (u.detail ? textHeight(u.detail, b.w - 44, 11) : 0);
    const ty = b.y + (b.h - textH) / 2;
    children.push(text(`usecase:${u.id} label`, b.x + 22, ty, b.w - 44, u.label ?? u.id, { size: 13, weight: "Medium", color: INK, align: "CENTER" }));
    if (u.detail) children.push(text(`usecase:${u.id} detail`, b.x + 22, ty + s.lines.length * lineHeight(13), b.w - 44, u.detail, { size: 11, color: BODY, align: "CENTER" }));
  }

  const frameH = boundY + boundH + PAD;
  const count = (k: UcLinkKind) => checked.links.filter((l) => l.kind === k).length;
  return {
    draw: {
      kind: "usecase",
      name: `Use case · ${title}`,
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
      ...(input.system ? { system: input.system } : {}),
      actors: checked.actors,
      useCases: checked.useCases,
      links: checked.links,
      ...(spec.options ? { options: spec.options } : {}),
    },
    warnings,
    stats: {
      actors: checked.actors.length,
      useCases: checked.useCases.length,
      associations: count("association"),
      includes: count("include"),
      extends: count("extend"),
      generalizations: count("generalization"),
      w: Math.round(frameW),
      h: Math.round(frameH),
    },
  };
}
