/**
 * Diagrams drawn with FigJam's OWN nodes — shapes-with-text, stickies and
 * connectors — instead of the frames-and-vectors drawing Figma Design needs.
 *
 * In FigJam a connector is a real node that follows its shapes, so none of
 * the live re-routing the Design path carries is needed: the server places
 * the boxes (dagre), the plugin creates the shapes and connects them, and
 * FigJam routes the lines. Pure: no figma globals — the plugin handler
 * (`create_figjam_diagram`) only draws what this module placed.
 *
 * Graph kinds convert: userflow, activity, state, sitemap. The model is
 * still proof-read by the kind's own checker (a dry run) before drawing.
 */
import dagre from "@dagrejs/dagre";
import { parseActivityText } from "../activity/text.js";
import { parseStateText } from "../state/text.js";
import { parseSitemapText } from "../sitemap/text.js";
import { parseMermaid } from "../userflow/mermaid.js";
import type { FigjamShape, FigjamColor } from "./style.js";
import { buildUsecase, type UsecaseSpec } from "../usecase/index.js";
import { buildJourney, type JourneySpec } from "../journey/index.js";
import { buildPersona, type PersonaSpec } from "../persona/index.js";

export { FIGJAM_FILL, FIGJAM_MARKER, type FigjamShape, type FigjamColor } from "./style.js";

export interface FigjamNode {
  id: string;
  label: string;
  shape: FigjamShape;
  color: FigjamColor;
  /** Placed by layoutFigjam (top-left, px). */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export interface FigjamEdge {
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
}

export interface FigjamGraph {
  title: string;
  nodes: FigjamNode[];
  edges: FigjamEdge[];
  rankdir: "TB" | "LR";
  /** Boards (persona, journey) come with every x/y set: a grid, not a graph to lay out. */
  placed?: boolean;
}

/**
 * Kinds that become a FigJam-native drawing when the window is FigJam.
 * Sequence and ERD are deliberately NOT here: a sequence needs lifelines in
 * strict vertical order, which FigJam's self-routing connectors scramble, and
 * an ERD needs crow's-foot ends, which FigJam connectors do not have. Both
 * keep their Figma Design drawing, which renders fine on a FigJam board.
 */
export const FIGJAM_NATIVE_KINDS = ["userflow", "activity", "state", "sitemap", "usecase", "journey", "persona"] as const;
export type FigjamNativeKind = (typeof FIGJAM_NATIVE_KINDS)[number];

export function isFigjamNativeKind(k: unknown): k is FigjamNativeKind {
  return typeof k === "string" && (FIGJAM_NATIVE_KINDS as readonly string[]).includes(k);
}

type Json = Record<string, unknown>;
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);

function labelOf(n: Json): string {
  const label = str(n.label, str(n.id));
  const detail = str(n.detail);
  return detail ? `${label}\n${detail}` : label;
}

/** The kind's model → a plain graph with FigJam shapes. */
export function toFigjamGraph(kind: FigjamNativeKind, spec: Json): FigjamGraph {
  const title = str(spec.title, kind);
  const options = (spec.options ?? {}) as Json;
  if (kind === "userflow") {
    const parsed = typeof spec.mermaid === "string" && !Array.isArray(spec.nodes) ? parseMermaid(spec.mermaid) : null;
    const nodes = parsed ? (parsed.nodes as unknown as Json[]) : arr(spec.nodes);
    const edges = parsed ? (parsed.edges as unknown as Json[]) : arr(spec.edges);
    return {
      title,
      rankdir: options.rankdir === "TB" ? "TB" : parsed?.rankdir === "TB" ? "TB" : "LR",
      nodes: nodes.map((n) => {
        const k = str(n.kind, "screen");
        return {
          id: str(n.id),
          label: labelOf(n),
          shape: k === "decision" ? "DIAMOND" : k === "terminal" ? "ELLIPSE" : k === "external" ? "PARALLELOGRAM_RIGHT" : k === "state" ? "SQUARE" : "ROUNDED_RECTANGLE",
          color: n.cls === "error" ? "red" : n.cls === "success" ? "green" : k === "decision" ? "yellow" : k === "external" ? "gray" : "blue",
        } satisfies FigjamNode;
      }),
      edges: edges.map((e) => ({ from: str(e.from), to: str(e.to), ...(str(e.label) ? { label: str(e.label) } : {}), ...(e.kind === "return" ? { dashed: true } : {}) })),
    };
  }
  if (kind === "activity") {
    const parsed = typeof spec.text === "string" ? parseActivityText(spec.text) : null;
    const nodes = parsed ? (parsed.nodes as unknown as Json[]) : arr(spec.nodes);
    const edges = parsed ? (parsed.edges as unknown as Json[]) : arr(spec.edges);
    const lanes = parsed ? (parsed.lanes as unknown as Json[]) : arr(spec.lanes);
    const laneName = new Map(lanes.map((l) => [str(l.id), str(l.label, str(l.id))]));
    return {
      title,
      rankdir: options.rankdir === "TB" || parsed?.rankdir === "TB" ? "TB" : "LR",
      nodes: nodes.map((n) => {
        const k = str(n.kind, "action");
        const lane = laneName.get(str(n.lane));
        const label = labelOf(n);
        return {
          id: str(n.id),
          // FigJam has no swimlane node; the owner leads the label instead.
          label: lane && k !== "start" && k !== "end" ? `${lane}: ${label}` : label,
          shape: k === "decision" ? "DIAMOND" : k === "start" || k === "end" ? "ELLIPSE" : k === "event" ? "PARALLELOGRAM_RIGHT" : k === "fork" || k === "join" ? "SQUARE" : "ROUNDED_RECTANGLE",
          color: k === "start" ? "green" : k === "end" ? "gray" : k === "decision" ? "yellow" : k === "external" ? "gray" : n.cls === "error" ? "red" : "blue",
        } satisfies FigjamNode;
      }),
      edges: edges.map((e) => ({ from: str(e.from), to: str(e.to), ...(str(e.label) ? { label: str(e.label) } : {}) })),
    };
  }
  if (kind === "state") {
    const parsed = typeof spec.text === "string" ? parseStateText(spec.text) : null;
    const states = parsed ? (parsed.states as unknown as Json[]) : arr(spec.states);
    const transitions = parsed ? (parsed.transitions as unknown as Json[]) : arr(spec.transitions);
    return {
      title,
      rankdir: options.rankdir === "TB" ? "TB" : "LR",
      nodes: states.map((s) => {
        const k = str(s.kind, "state");
        const inner = [str(s.entry) && `entry / ${str(s.entry)}`, str(s.do) && `do / ${str(s.do)}`, str(s.exit) && `exit / ${str(s.exit)}`].filter(Boolean).join("\n");
        return {
          id: str(s.id),
          label: k === "initial" ? "●" : k === "final" ? "◉" : inner ? `${str(s.label, str(s.id))}\n${inner}` : str(s.label, str(s.id)),
          shape: k === "choice" ? "DIAMOND" : k === "initial" || k === "final" ? "ELLIPSE" : k === "fork" || k === "join" ? "SQUARE" : "ROUNDED_RECTANGLE",
          color: k === "initial" || k === "final" ? "gray" : k === "choice" ? "yellow" : "violet",
        } satisfies FigjamNode;
      }),
      edges: transitions.map((t) => {
        const ev = str(t.event);
        const guard = str(t.guard);
        const action = str(t.action);
        const label = `${ev}${guard ? ` [${guard}]` : ""}${action ? ` / ${action}` : ""}`.trim();
        return { from: str(t.from), to: str(t.to), ...(label ? { label } : {}) };
      }),
    };
  }
  if (kind === "usecase") {
    const m = buildUsecase(spec as UsecaseSpec).model;
    return {
      title: m.title,
      rankdir: "LR",
      nodes: [
        ...m.actors.map((a) => ({ id: a.id, label: `${a.kind === "system" ? "⚙ " : "🧑 "}${a.name ?? a.id}`, shape: "SQUARE" as FigjamShape, color: (a.kind === "system" ? "gray" : "orange") as FigjamColor })),
        ...m.useCases.map((u) => ({ id: u.id, label: u.detail ? `${u.label ?? u.id}\n${u.detail}` : (u.label ?? u.id), shape: "ELLIPSE" as FigjamShape, color: "blue" as FigjamColor })),
      ],
      edges: m.links.map((l) => {
        const k = l.kind ?? "association";
        const label = k === "include" ? "«include»" : k === "extend" ? "«extend»" : k === "generalization" ? "generalizes" : (l.label ?? undefined);
        return { from: l.from, to: l.to, ...(label ? { label } : {}), ...(k === "include" || k === "extend" ? { dashed: true } : {}) };
      }),
    };
  }
  if (kind === "persona") {
    const m = buildPersona(spec as PersonaSpec).model;
    const nodes: FigjamNode[] = [];
    const COL = STICKY_SIDE + GRID_GAP;
    m.personas.forEach((p, c) => {
      const header = [`${p.primary ? "★ " : ""}${p.name ?? p.id}`, p.tag, p.quote ? `“${p.quote}”` : undefined].filter(Boolean).join("\n");
      const rows: Array<[string, FigjamColor, string[] | undefined]> = [
        ["Goals", "green", p.goals],
        ["Pains", "red", p.pains],
        ["Needs", "blue", p.needs],
        ["Behaviours", "yellow", p.behaviors],
        ["Facts", "gray", p.facts?.map((f) => `${f.label}: ${f.value}`)],
      ];
      nodes.push({ id: `${p.id}#head`, label: header, shape: "STICKY", color: "violet", x: c * COL, y: 0 });
      let r = 1;
      for (const [name, color, items] of rows) {
        if (!items?.length) continue;
        nodes.push({ id: `${p.id}#${name.toLowerCase()}`, label: `${name}\n${items.map((i) => `• ${i}`).join("\n")}`, shape: "STICKY", color, x: c * COL, y: r++ * COL });
      }
    });
    return { title: m.title, rankdir: "LR", nodes, edges: [], placed: true };
  }
  if (kind === "journey") {
    const m = buildJourney(spec as JourneySpec).model;
    const nodes: FigjamNode[] = [];
    const edges: FigjamEdge[] = [];
    const COL = STICKY_SIDE + GRID_GAP;
    m.phases.forEach((ph, c) => {
      const x = c * COL;
      nodes.push({ id: `${ph.id}#phase`, label: ph.label ?? ph.id, shape: "ROUNDED_RECTANGLE", color: "teal", x, y: 0, w: STICKY_SIDE, h: 80 });
      if (c > 0) edges.push({ from: `${m.phases[c - 1]!.id}#phase`, to: `${ph.id}#phase` });
      const feeling = typeof ph.feeling === "number" ? ph.feeling : undefined;
      const rows: Array<[string, FigjamColor, string[] | undefined]> = [
        ["Actions", "yellow", ph.actions],
        ["Touchpoints", "blue", ph.touchpoints],
        ["Thinks", "violet", ph.thoughts],
        [feeling === undefined ? "Feels" : `Feels ${feeling > 0 ? "🙂" : feeling < 0 ? "🙁" : "😐"} ${feeling > 0 ? "+" : ""}${feeling}`, feeling !== undefined && feeling < 0 ? "red" : "green", ph.feelingNote ? [ph.feelingNote] : feeling !== undefined ? [] : undefined],
        ["Pains", "red", ph.pains],
        ["Ideas", "green", ph.ideas],
      ];
      let r = 0;
      for (const [name, color, items] of rows) {
        if (items === undefined || (!items.length && !name.startsWith("Feels "))) continue;
        nodes.push({ id: `${ph.id}#${name.split(" ")[0]!.toLowerCase()}`, label: items.length ? `${name}\n${items.map((i) => `• ${i}`).join("\n")}` : name, shape: "STICKY", color, x, y: 110 + r++ * COL });
      }
    });
    return { title: m.title, rankdir: "LR", nodes, edges, placed: true };
  }
  // sitemap: containment tree, drawn top-down.
  const parsed = typeof spec.text === "string" ? parseSitemapText(spec.text) : null;
  const pages = parsed ? (parsed.pages as unknown as Json[]) : arr(spec.pages);
  return {
    title,
    rankdir: "TB",
    nodes: pages.map((p) => {
      const k = str(p.kind, "page");
      return {
        id: str(p.id),
        label: labelOf(p),
        shape: k === "modal" ? "SQUARE" : k === "external" ? "PARALLELOGRAM_RIGHT" : "ROUNDED_RECTANGLE",
        color: k === "section" ? "teal" : k === "modal" ? "orange" : k === "external" ? "gray" : "blue",
      } satisfies FigjamNode;
    }),
    edges: pages.filter((p) => str(p.parent)).map((p) => ({ from: str(p.parent), to: str(p.id) })),
  };
}

/** FigJam's sticky is a fixed square; boards are a grid of them. */
export const STICKY_SIDE = 240;
export const GRID_GAP = 40;
const MAX_BOX_W = 320;
const CHAR_W = 8;

/** Box size from the label: FigJam shapes grow with their text, so size up front. */
export function sizeFor(n: FigjamNode): { w: number; h: number } {
  const lines = n.label.split("\n");
  const longest = Math.max(1, ...lines.map((l) => l.length));
  if (n.shape === "ELLIPSE" && n.label.length <= 2) return { w: 48, h: 48 };
  const w = Math.min(MAX_BOX_W, Math.max(140, longest * CHAR_W + 40));
  // A line longer than the box wraps: count the WRAPPED lines, or the box is
  // too short and FigJam grows it over its neighbour.
  const perLine = Math.max(1, Math.floor((w - 40) / CHAR_W));
  const wrapped = lines.reduce((sum, l) => sum + Math.max(1, Math.ceil(l.length / perLine)), 0);
  const h = Math.max(72, wrapped * 22 + 40);
  if (n.shape === "DIAMOND") return { w: Math.max(w, 160), h: Math.max(h, 120) };
  if (n.shape === "STICKY") return { w: 240, h: 240 };
  return { w, h };
}

/**
 * Place every node (dagre, ranks along `rankdir`). Edges to unknown ids are
 * dropped and listed in `warnings` — FigJam would otherwise draw a connector
 * with a loose end, which reads as a bug in the model.
 */
export function layoutFigjam(graph: FigjamGraph, origin: { x?: number; y?: number } = {}): { graph: FigjamGraph; width: number; height: number; warnings: string[] } {
  const warnings: string[] = [];
  // Ids are compared as strings everywhere downstream; a duplicate would draw
  // two shapes on one spot and the plugin's id map would keep only one.
  const seenIds = new Set<string>();
  const nodes0: FigjamNode[] = [];
  for (const raw of graph.nodes) {
    const id = String(raw.id ?? "").trim();
    if (!id) {
      warnings.push(`A node with no id ("${raw.label.split("\n")[0]}") was not drawn.`);
      continue;
    }
    if (seenIds.has(id)) {
      warnings.push(`Node id "${id}" is used twice; only the first was drawn.`);
      continue;
    }
    seenIds.add(id);
    nodes0.push({ ...raw, id });
  }
  graph = { ...graph, nodes: nodes0, edges: graph.edges.map((e) => ({ ...e, from: String(e.from), to: String(e.to) })) };
  const ids = new Set(graph.nodes.map((n) => n.id));
  const edges = graph.edges.filter((e) => {
    const ok = ids.has(e.from) && ids.has(e.to);
    if (!ok) warnings.push(`Edge ${e.from} → ${e.to} names a node that does not exist; it was not drawn.`);
    return ok;
  });
  if (graph.placed) {
    // A board: positions are the grid the kind chose. Only sizes are filled in.
    // Same margins dagre gets (marginx 40, marginy 80): clear of the section's title.
    const ox0 = origin.x ?? 40;
    const oy0 = origin.y ?? 80;
    const nodes = graph.nodes.map((n) => {
      const s = n.w && n.h ? { w: n.w, h: n.h } : sizeFor(n);
      return { ...n, x: ox0 + (n.x ?? 0), y: oy0 + (n.y ?? 0), w: s.w, h: s.h };
    });
    const width = Math.max(0, ...nodes.map((n) => n.x! + n.w!)) + 40;
    const height = Math.max(0, ...nodes.map((n) => n.y! + n.h!)) + 40;
    return { graph: { ...graph, nodes, edges }, width, height, warnings };
  }
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: graph.rankdir, nodesep: 60, ranksep: 110, marginx: 40, marginy: 80 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of graph.nodes) {
    const s = sizeFor(n);
    g.setNode(n.id, { width: s.w, height: s.h });
  }
  edges.forEach((e, i) => g.setEdge(e.from, e.to, { label: e.label ?? "", width: e.label ? Math.min(200, e.label.length * 7) : 0, height: e.label ? 20 : 0 }, `e${i}`));
  dagre.layout(g);
  const ox = origin.x ?? 0;
  const oy = origin.y ?? 0;
  const nodes = graph.nodes.map((n) => {
    const p = g.node(n.id) as { x: number; y: number; width: number; height: number };
    return { ...n, x: Math.round(ox + p.x - p.width / 2), y: Math.round(oy + p.y - p.height / 2), w: p.width, h: p.height };
  });
  const gl = g.graph() as { width?: number; height?: number };
  return { graph: { ...graph, nodes, edges }, width: Math.round(gl.width ?? 0), height: Math.round(gl.height ?? 0), warnings };
}
