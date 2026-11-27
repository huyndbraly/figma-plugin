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
export { FIGJAM_FILL, type FigjamShape, type FigjamColor } from "./style.js";

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
}

/** Kinds that become a FigJam-native drawing when the window is FigJam. */
export const FIGJAM_NATIVE_KINDS = ["userflow", "activity", "state", "sitemap"] as const;
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

/** Box size from the label: FigJam shapes grow with their text, so size up front. */
export function sizeFor(n: FigjamNode): { w: number; h: number } {
  const lines = n.label.split("\n");
  const longest = Math.max(1, ...lines.map((l) => l.length));
  if (n.shape === "ELLIPSE" && n.label.length <= 2) return { w: 48, h: 48 };
  const w = Math.min(320, Math.max(140, longest * 8 + 40));
  const h = Math.max(72, lines.length * 22 + 40);
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
  const ids = new Set(graph.nodes.map((n) => n.id));
  const edges = graph.edges.filter((e) => {
    const ok = ids.has(e.from) && ids.has(e.to);
    if (!ok) warnings.push(`Edge ${e.from} → ${e.to} names a node that does not exist; it was not drawn.`);
    return ok;
  });
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
