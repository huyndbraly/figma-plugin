/**
 * Prototype reactions as MOTION an agent can turn into animation code:
 * trigger, action, transition type (SMART_ANIMATE, MOVE_IN, DISSOLVE…),
 * duration, easing (named curve, cubic-bezier, or spring) — plus a ready CSS
 * timing string where CSS can express it.
 *
 * The compact `reactions` strings in serialize.ts say WHERE a click goes;
 * this says HOW it gets there, which is what an implementation needs. Pure:
 * takes the plain reaction objects, no figma globals.
 */

export interface MotionEasing {
  type: string;
  /** cubic-bezier(x1, y1, x2, y2) control points (named curves included). */
  bezier?: [number, number, number, number];
  spring?: { mass: number; stiffness: number; damping: number };
}

export interface MotionTransition {
  type: string;
  /** Seconds. */
  duration?: number;
  easing?: MotionEasing;
  direction?: string;
  matchLayers?: boolean;
  /** `300ms cubic-bezier(0.42, 0, 0.58, 1)` — absent for springs. */
  css?: string;
}

export interface MotionAction {
  type: string;
  destinationId?: string | null;
  navigation?: string;
  url?: string;
  overlayRelativePosition?: { x: number; y: number };
  resetScrollPosition?: boolean;
  transition?: MotionTransition;
}

export interface MotionEntry {
  trigger: { type: string; delay?: number; timeout?: number; keyCodes?: number[]; device?: string };
  actions: MotionAction[];
}

/** The bezier Figma means by each named easing (its documented curves). */
export const NAMED_EASINGS: Record<string, [number, number, number, number]> = {
  LINEAR: [0, 0, 1, 1],
  EASE_IN: [0.42, 0, 1, 1],
  EASE_OUT: [0, 0, 0.58, 1],
  EASE_IN_AND_OUT: [0.42, 0, 0.58, 1],
  EASE_IN_BACK: [0.3, -0.05, 0.7, -0.5],
  EASE_OUT_BACK: [0.45, 1.45, 0.8, 1],
  EASE_IN_AND_OUT_BACK: [0.7, -0.4, 0.4, 1.4],
};

/** Figma's spring presets (mass, stiffness, damping). */
export const NAMED_SPRINGS: Record<string, { mass: number; stiffness: number; damping: number }> = {
  GENTLE: { mass: 1, stiffness: 100, damping: 15 },
  QUICK: { mass: 1, stiffness: 300, damping: 20 },
  BOUNCY: { mass: 1, stiffness: 600, damping: 15 },
  SLOW: { mass: 1, stiffness: 80, damping: 20 },
};

const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** Figma stores ms as 32-bit floats; seconds rounded to what was typed. */
const secs = (v: unknown, unit: "s" | "ms"): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.round((unit === "ms" ? v / 1000 : v) * 1000) / 1000 : undefined;

type Json = Record<string, unknown>;

export function describeEasing(raw: unknown): MotionEasing | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const e = raw as Json;
  const type = String(e.type ?? "LINEAR");
  const out: MotionEasing = { type };
  const fn = e.easingFunctionCubicBezier as Json | undefined;
  const sp = e.easingFunctionSpring as Json | undefined;
  if (fn && typeof fn.x1 === "number") out.bezier = [r3(fn.x1), r3(Number(fn.y1)), r3(Number(fn.x2)), r3(Number(fn.y2))];
  else if (NAMED_EASINGS[type]) out.bezier = NAMED_EASINGS[type];
  if (sp && typeof sp.mass === "number") out.spring = { mass: sp.mass, stiffness: Number(sp.stiffness), damping: Number(sp.damping) };
  else if (NAMED_SPRINGS[type]) out.spring = NAMED_SPRINGS[type];
  return out;
}

export function describeTransition(raw: unknown): MotionTransition | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const t = raw as Json;
  // Transition duration is SECONDS in the Plugin API.
  const duration = secs(t.duration, "s");
  const easing = describeEasing(t.easing);
  const out: MotionTransition = {
    type: String(t.type ?? "INSTANT"),
    ...(duration !== undefined ? { duration } : {}),
    ...(easing ? { easing } : {}),
    ...(typeof t.direction === "string" ? { direction: t.direction } : {}),
    ...(typeof t.matchLayers === "boolean" ? { matchLayers: t.matchLayers } : {}),
  };
  if (duration !== undefined && easing?.bezier && !easing.spring) {
    out.css = `${Math.round(duration * 1000)}ms cubic-bezier(${easing.bezier.join(", ")})`;
  }
  return out;
}

function describeAction(raw: unknown): MotionAction | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Json;
  const type = String(a.type ?? "?");
  const transition = describeTransition(a.transition);
  return {
    type,
    ...(a.destinationId !== undefined ? { destinationId: (a.destinationId as string | null) ?? null } : {}),
    ...(typeof a.navigation === "string" ? { navigation: a.navigation } : {}),
    ...(typeof a.url === "string" ? { url: a.url } : {}),
    ...(a.overlayRelativePosition && typeof a.overlayRelativePosition === "object" ? { overlayRelativePosition: a.overlayRelativePosition as { x: number; y: number } } : {}),
    ...(typeof a.resetScrollPosition === "boolean" ? { resetScrollPosition: a.resetScrollPosition } : {}),
    ...(transition ? { transition } : {}),
  };
}

/** Every reaction on a node, structured. `[]` when there are none. */
export function describeMotion(reactions: readonly unknown[] | null | undefined): MotionEntry[] {
  const out: MotionEntry[] = [];
  for (const raw of reactions ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Json;
    const tr = (r.trigger ?? {}) as Json;
    const trigger: MotionEntry["trigger"] = {
      type: String(tr.type ?? "?"),
      // Trigger delay/timeout are MILLISECONDS in the Plugin API.
      ...(secs(tr.delay, "ms") !== undefined ? { delay: secs(tr.delay, "ms") } : {}),
      ...(secs(tr.timeout, "ms") !== undefined ? { timeout: secs(tr.timeout, "ms") } : {}),
      ...(Array.isArray(tr.keyCodes) ? { keyCodes: tr.keyCodes as number[] } : {}),
      ...(typeof tr.device === "string" ? { device: tr.device } : {}),
    };
    const list = [...(Array.isArray(r.actions) ? (r.actions as unknown[]) : []), ...(!Array.isArray(r.actions) && r.action ? [r.action] : [])];
    const actions = list.map(describeAction).filter((a): a is MotionAction => !!a);
    out.push({ trigger, actions });
  }
  return out;
}
