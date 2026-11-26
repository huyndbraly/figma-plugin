/// <reference types="@figma/plugin-typings" />
/**
 * The tag a drawn userflow leaves on its frame, and the lookup that lets the
 * screen-drawing path notice it. This is what makes "did anyone map the flow
 * before we started drawing screens?" a question the tooling can ask instead
 * of one everybody forgets.
 */
import type { RouteGraph } from "../shared/userflow/route.js";
import { nameMatchesScreenId } from "../shared/model/screen-id.js";

/** Re-exported so the plugin keeps one import site; defined in shared. */
export { nameMatchesScreenId } from "../shared/model/screen-id.js";

export const FLOW_MARKER = "figma-plugin.userflow";
/** The key 0.1.0 wrote before the tool was renamed. Read, never written. */
export const LEGACY_FLOW_MARKER = "figma-plugin.flowchart";

export interface FlowMark {
  frameId: string;
  frameName: string;
  title: string;
  /** Flow node ids. */
  nodes: string[];
  /** flow node id → screenId. */
  screens: Record<string, string>;
  /** The routing graph, present on frames drawn with live re-routing. */
  graph?: RouteGraph;
}

/** The marker payload as it is stored, on either key. */
export function readMarkData(node: BaseNode): Partial<FlowMark> | null {
  let raw = "";
  try {
    raw = node.getPluginData(FLOW_MARKER) || node.getPluginData(LEGACY_FLOW_MARKER);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Partial<FlowMark>;
  } catch {
    // Unreadable marker data still means "a flow lives here".
    return {};
  }
}

/**
 * The page-level items that carry a userflow marker: the page's children and
 * a SECTION's — a SECTION only groups the canvas, so a userflow parked inside
 * one still maps the screens it names (the same descent `linkScreens` makes).
 *
 * This runs for every screen-sized frame a create draws, and the walk read
 * the marker of every layer on the page each time. One native search narrowed
 * by the marker keys returns only the frames that have one, in document
 * order; the walk stays for a runtime without it.
 */
function flowMarkedItems(page: PageNode): readonly BaseNode[] {
  try {
    if (typeof page.findAllWithCriteria === "function") {
      const marked = page.findAllWithCriteria({ pluginData: { keys: [FLOW_MARKER, LEGACY_FLOW_MARKER] } });
      // By id: two handles on the same node are not guaranteed to be ===.
      return marked.filter((n) => {
        const parent = n.parent;
        if (!parent) return false;
        return parent.id === page.id || (parent.type === "SECTION" && parent.parent?.id === page.id);
      });
    }
  } catch {
    // fall back to the walk
  }
  const items: BaseNode[] = [];
  for (const child of page.children) {
    if (child.type === "SECTION") items.push(...child.children);
    else items.push(child);
  }
  return items;
}

/** Every userflow frame on a page, newest declaration order preserved. */
export function readFlowMarks(page: PageNode): FlowMark[] {
  const out: FlowMark[] = [];
  for (const item of flowMarkedItems(page)) {
    const parsed = readMarkData(item);
    if (!parsed) continue;
    out.push({
      frameId: item.id,
      frameName: item.name,
      title: typeof parsed.title === "string" ? parsed.title : item.name,
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes.map(String) : [],
      screens:
        parsed.screens && typeof parsed.screens === "object"
          ? (parsed.screens as Record<string, string>)
          : {},
      ...(parsed.graph ? { graph: parsed.graph } : {}),
    });
  }
  return out;
}

/** Does any flow already cover a screen with this artboard name? */
export function flowCoversScreen(marks: FlowMark[], artboardName: string): boolean {
  for (const mark of marks) {
    for (const key of Object.keys(mark.screens)) {
      const screenId = String(mark.screens[key] ?? "");
      if (screenId && nameMatchesScreenId(artboardName, screenId)) return true;
    }
  }
  return false;
}
