/// <reference types="@figma/plugin-typings" />
/**
 * One door for "put this diagram's arrows back on its boxes", whichever kind
 * of diagram it is. The live watcher and the reflow op both come through here,
 * so adding a diagram kind means adding it in ONE place rather than teaching
 * every caller about the new marker.
 */
import { reflowFrame, userflowFrames, userflowGraphOf, type ReflowReport } from "./userflow-reflow.js";
import {
  activityFrames,
  activityGraphOf,
  reflowActivityFrame,
  type ActivityReflowReport,
} from "./activity-reflow.js";
import { erdFrames, erdGraphOf, reflowErdFrame, type ErdReflowReport } from "./erd-reflow.js";
import {
  reflowSequenceFrame,
  sequenceFrames,
  sequenceGraphOf,
  type SequenceReflowReport,
} from "./sequence-reflow.js";
import { reflowStateFrame, stateFrames, stateGraphOf, type StateReflowReport } from "./state-reflow.js";
import {
  reflowSitemapFrame,
  sitemapFrames,
  sitemapGraphOf,
  type SitemapReflowReport,
} from "./sitemap-reflow.js";
import { insideInstanceOrComponent, markedDiagramFrames } from "./diagram-apply.js";

export type DiagramReport =
  | ReflowReport
  | ActivityReflowReport
  | ErdReflowReport
  | SequenceReflowReport
  | StateReflowReport
  | SitemapReflowReport;

export interface ReflowOpts {
  grow?: boolean;
  onlyIfMoved?: boolean;
  /** Re-route even the arrows somebody moved by hand. */
  force?: boolean;
  /** Boxes were deleted (or the caller asked): an empty frame is not mid-write. See scanBoxes. */
  deleted?: boolean;
}

export type DiagramKind = "userflow" | "activity" | "erd" | "sequence" | "state" | "sitemap";

/**
 * Which re-routable diagram this node carries, and whether it routes live —
 * from ONE parse of the stored graph.
 *
 * isDiagramFrame, liveRouteOn and reflowAnyFrame each used to walk the six
 * graph readers on their own, so a live pass parsed a large graph's JSON three
 * times per frame before the re-route parsed it once more. The readers are
 * tried in the same order as before, and each one only parses when its own
 * marker key is set, so the first hit is the only parse.
 */
export function diagramKindOf(node: BaseNode): { kind: DiagramKind; liveRoute: boolean } | null {
  const flow = userflowGraphOf(node);
  if (flow) return { kind: "userflow", liveRoute: flow.liveRoute };
  const activity = activityGraphOf(node);
  if (activity) return { kind: "activity", liveRoute: activity.liveRoute };
  const erd = erdGraphOf(node);
  if (erd) return { kind: "erd", liveRoute: erd.liveRoute };
  const seq = sequenceGraphOf(node);
  if (seq) return { kind: "sequence", liveRoute: seq.liveRoute };
  const state = stateGraphOf(node);
  if (state) return { kind: "state", liveRoute: state.liveRoute };
  const sitemap = sitemapGraphOf(node);
  if (sitemap) return { kind: "sitemap", liveRoute: sitemap.liveRoute };
  return null;
}

/** Does this node carry a diagram we know how to re-route? */
export function isDiagramFrame(node: BaseNode): boolean {
  return !!diagramKindOf(node);
}

/** Is live re-routing switched on for this frame? */
export function liveRouteOn(frame: FrameNode): boolean {
  return diagramKindOf(frame)?.liveRoute ?? false;
}

/**
 * `kind` is what diagramKindOf already answered: pass it and the dispatch
 * does not parse the graph again just to pick the router.
 */
export async function reflowAnyFrame(
  frame: FrameNode,
  opts?: ReflowOpts,
  kind?: DiagramKind,
): Promise<DiagramReport | null> {
  switch (kind ?? diagramKindOf(frame)?.kind) {
    case "userflow":
      return reflowFrame(frame, opts);
    case "activity":
      return reflowActivityFrame(frame, opts);
    case "erd":
      return reflowErdFrame(frame, opts);
    case "sequence":
      return reflowSequenceFrame(frame, opts);
    case "state":
      return reflowStateFrame(frame, opts);
    case "sitemap":
      return reflowSitemapFrame(frame, opts);
    default:
      return null;
  }
}

/**
 * Every re-routable diagram on the page, at ANY depth.
 *
 * The per-kind lists only look at the page and its sections, so a diagram
 * drawn with `parentId` into a plain frame (or dragged into one) was never in
 * the DELETE sweep: deleting one of its boxes left its arrows dangling, and
 * reflow_diagram with no frameId skipped it. One native search, narrowed to
 * frames that carry one of our markers, is what keeps this cheap enough to run
 * on every delete on a large page — the JSON of a graph is only parsed for
 * the handful of frames that have one.
 */
export function diagramFrames(page: PageNode): FrameNode[] {
  // An API surface without the criterion: fall back to the shallow lists,
  // which still cover every diagram on the page or in a section.
  const marked = markedDiagramFrames(page);
  if (!marked) return shallowDiagramFrames(page);
  return marked.filter((frame) => isDiagramFrame(frame));
}

/**
 * The frames that MAY carry a re-routable diagram, without parsing a graph:
 * every marked frame (boards included — diagramKindOf says no to those later).
 * The DELETE sweep runs on every delete anywhere on the page and only needs to
 * know which frames lost a layer; the graphs are parsed for those alone.
 */
export function diagramFrameCandidates(page: PageNode): FrameNode[] {
  return markedDiagramFrames(page) ?? shallowDiagramFrames(page);
}

function shallowDiagramFrames(page: PageNode): FrameNode[] {
  const out: FrameNode[] = [];
  const seen = new Set<string>();
  for (const frame of userflowFrames(page).concat(activityFrames(page), erdFrames(page), sequenceFrames(page), stateFrames(page), sitemapFrames(page))) {
    if (seen.has(frame.id)) continue;
    seen.add(frame.id);
    out.push(frame);
  }
  return out;
}

/**
 * Walk up from a changed node to the diagram frame that owns it — all the way
 * to the page, like owningMarkedFrame in handlers/diagram.ts. The old four-hop
 * limit missed an ERD column's text (text → cell → row → entity → diagram is
 * five), so editing it re-routed nothing. The nearest diagram still wins.
 *
 * This runs for every node of every change batch, so `memo` (one per batch)
 * remembers the answer for each ancestor already walked: a paste of a thousand
 * layers into one frame climbs that frame's ancestry once, not a thousand
 * times, and a graph's JSON is parsed once per frame.
 */
export function owningDiagram(
  node: BaseNode | null,
  memo?: Map<string, FrameNode | null>,
): FrameNode | null {
  const walked: string[] = [];
  let found: FrameNode | null = null;
  let cur: BaseNode | null = node;
  while (cur && cur.type !== "PAGE" && cur.type !== "DOCUMENT") {
    const known = memo?.get(cur.id);
    if (known !== undefined) {
      found = known;
      break;
    }
    walked.push(cur.id);
    if (cur.type === "FRAME" && isDiagramFrame(cur)) {
      found = insideInstanceOrComponent(cur) ? null : (cur as FrameNode);
      break;
    }
    cur = cur.parent;
  }
  if (memo) for (const id of walked) memo.set(id, found);
  return found;
}
