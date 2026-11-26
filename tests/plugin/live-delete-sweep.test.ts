import { beforeEach, describe, expect, it, vi } from "vitest";
import { installDiagramLive } from "../../src/plugin/diagram-live.js";
import { diagramKindOf, reflowAnyFrame } from "../../src/plugin/diagram-reflow.js";
import { findShape, scanBoxes, shapeIndex } from "../../src/plugin/diagram-apply.js";
import { HANDLERS } from "../../src/plugin/handlers/registry.js";
import { makeContext } from "../../src/plugin/context.js";
import { buildSitemap } from "../../src/shared/sitemap/index.js";

/**
 * What one DELETE on the page costs the live router.
 *
 * A DELETE arrives with no parent, so the sweep used to queue EVERY diagram
 * on the page for a full re-route — deleting a stray rectangle re-checked
 * them all, each pass looked every box up by scanning every child, and each
 * frame's graph JSON was parsed three or four times on the way. Now only a
 * frame that lost a layer is queued, boxes are found through one index, and
 * the graph is parsed once to pick the router.
 */

let page: any;
let seq = 0;
let pageListeners: Array<(e: any) => void>;

function base(id: string, type: string): any {
  const n: any = {
    id, type, name: "", x: 0, y: 0, width: 100, height: 100,
    visible: true, removed: false, opacity: 1, rotation: 0,
    fills: [], strokes: [], strokeWeight: 1, strokeAlign: "CENTER",
    strokeCap: "NONE", strokeJoin: "MITER", dashPattern: [], effects: [],
    cornerRadius: 0, clipsContent: false, children: [], vectorPaths: [],
    caps: [] as string[], characters: "", fontName: { family: "Inter", style: "Regular" },
    fontSize: 12, textAutoResize: "NONE", reactions: [],
    pluginData: {} as Record<string, string>,
    resize(w: number, h: number) { this.width = w; this.height = h; },
    appendChild(c: any) { this.children.push(c); c.parent = this; },
    insertChild(i: number, c: any) { this.children.splice(i, 0, c); c.parent = this; },
    setBoundVariable: vi.fn(),
    getPluginData(key: string) { return this.pluginData[key] ?? ""; },
    setPluginData(key: string, value: string) { this.pluginData[key] = value; },
    setVectorNetworkAsync: async function (net: any) {
      this.vectorNetwork = net;
      this.vectorPaths = [{ windingRule: "NONE", data: net.vertices.map((v: any, i: number) => `${i ? "L" : "M"} ${v.x} ${v.y}`).join(" ") }];
      this.caps = net.vertices.map((v: any) => v.strokeCap);
    },
    remove() { this.removed = true; if (this.parent) this.parent.children = this.parent.children.filter((c: any) => c !== this); },
    setReactionsAsync: vi.fn(),
  };
  if (type === "FRAME") n.layoutMode = "NONE";
  return n;
}

function findAllWithCriteria(this: any, criteria: { types?: string[]; pluginData?: { keys?: string[] } }) {
  const out: any[] = [];
  const walk = (nodes: any[]) => {
    for (const n of nodes) {
      const typeOk = !criteria.types || criteria.types.includes(n.type);
      const keys = criteria.pluginData?.keys;
      const dataOk = !keys || keys.some((k) => (n.pluginData?.[k] ?? "") !== "");
      if (typeOk && dataOk) out.push(n);
      if (n.children) walk(n.children);
    }
  };
  walk(this.children);
  return out;
}

const ctx = (params: Record<string, unknown>) => makeContext(params, () => {});
const drawData = (extra: Record<string, unknown> = {}) => ({
  ...(buildSitemap({ title: "T", text: `root "Root"\n  a "A"\n  b "B"` }).draw as unknown as Record<string, unknown>),
  ...extra,
});
const settle = () => new Promise((r) => setTimeout(r, 0));
const boxOf = (frame: any, id: string) => frame.children.find((c: any) => c.name.indexOf(`page:${id}`) === 0);
const layer = (frame: any, name: string) => frame.children.find((c: any) => c.name === name);
const pathOf = (frame: any, name: string): string => {
  const l = layer(frame, name);
  return `${l.x},${l.y} ${l.vectorPaths[0]?.data ?? ""}`;
};
const fire = (changes: any[]) => {
  for (const cb of pageListeners) cb({ nodeChanges: changes });
};

beforeEach(() => {
  seq = 0;
  pageListeners = [];
  page = {
    id: "0:1", type: "PAGE", children: [] as any[],
    appendChild(n: any) { this.children.push(n); n.parent = this; },
    insertChild(i: number, n: any) { this.children.splice(i, 0, n); n.parent = this; },
    on(type: string, cb: (e: any) => void) { if (type === "nodechange") pageListeners.push(cb); },
    off(type: string, cb: (e: any) => void) { pageListeners = pageListeners.filter((f) => f !== cb); },
    findAllWithCriteria,
  };
  (globalThis as any).figma = {
    currentPage: page,
    mixed: Symbol("mixed"),
    on: vi.fn(),
    loadFontAsync: vi.fn(async () => {}),
    listAvailableFontsAsync: vi.fn(async () => [{ fontName: { family: "Inter", style: "Regular" } }]),
    getNodeByIdAsync: vi.fn(async (id: string) => {
      const walk = (nodes: any[]): any => {
        for (const n of nodes) {
          if (n.id === id) return n;
          const hit = n.children ? walk(n.children) : null;
          if (hit) return hit;
        }
        return null;
      };
      return id === "0:1" ? page : walk(page.children);
    }),
    createFrame: vi.fn(() => base(`10:${++seq}`, "FRAME")),
    createText: vi.fn(() => base(`20:${++seq}`, "TEXT")),
    createVector: vi.fn(() => base(`30:${++seq}`, "VECTOR")),
    createPolygon: vi.fn(() => base(`40:${++seq}`, "POLYGON")),
    createRectangle: vi.fn(() => base(`50:${++seq}`, "RECTANGLE")),
  };
});

async function twoDiagrams(): Promise<{ a: any; b: any }> {
  await HANDLERS.create_sitemap(ctx(drawData()));
  await HANDLERS.create_sitemap(ctx(drawData({ x: 5000, y: 0 })));
  const frames = page.children.filter((c: any) => c.getPluginData?.("figma-plugin.sitemap"));
  expect(frames.length).toBe(2);
  return { a: frames[0], b: frames[1] };
}

describe("the DELETE sweep only re-checks diagrams that lost a layer", () => {
  it("re-routes the diagram a box left, and leaves the other one alone", async () => {
    const { a, b } = await twoDiagrams();
    installDiagramLive();
    // Moved with no event: a pass over B would re-route this arrow.
    const before = pathOf(b, "edge root->a");
    boxOf(b, "a").x += 300;

    const box = boxOf(a, "a");
    box.remove();
    fire([{ type: "DELETE", id: box.id }]);
    await settle();

    expect(layer(a, "edge root->a").visible, "the deleted box kept its arrow").toBe(false);
    expect(pathOf(b, "edge root->a"), "a diagram nothing was deleted from was re-routed").toBe(before);
  });

  it("deleting a layer outside every diagram re-routes none of them", async () => {
    const { a } = await twoDiagrams();
    const stray = base("60:1", "RECTANGLE");
    page.appendChild(stray);
    installDiagramLive();
    const before = pathOf(a, "edge root->a");
    boxOf(a, "a").x += 300;

    stray.remove();
    fire([{ type: "DELETE", id: stray.id }]);
    await settle();
    expect(pathOf(a, "edge root->a")).toBe(before);
  });

  it("a later delete from the same diagram is still answered", async () => {
    const { a } = await twoDiagrams();
    installDiagramLive();
    const first = boxOf(a, "a");
    first.remove();
    fire([{ type: "DELETE", id: first.id }]);
    await settle();
    const second = boxOf(a, "b");
    second.remove();
    fire([{ type: "DELETE", id: second.id }]);
    await settle();
    expect(layer(a, "edge root->b").visible).toBe(false);
  });

  it("a diagram drawn after the page was attached is checked on its first delete", async () => {
    installDiagramLive();
    const { a } = await twoDiagrams();
    const box = boxOf(a, "a");
    box.remove();
    fire([{ type: "DELETE", id: box.id }]);
    await settle();
    expect(layer(a, "edge root->a").visible).toBe(false);
  });
});

describe("one parse of the graph per live pass", () => {
  it("reads the marker once to pick the router, once to route", async () => {
    const { a } = await twoDiagrams();
    installDiagramLive();
    await settle();
    let reads = 0;
    const get = a.getPluginData;
    a.getPluginData = function (key: string) {
      if (key === "figma-plugin.sitemap") reads++;
      return get.call(this, key);
    };
    const before = pathOf(a, "edge root->a");
    const box = boxOf(a, "a");
    box.x += 120;
    fire([{ type: "PROPERTY_CHANGE", node: box, properties: ["x"] }]);
    await settle();
    expect(pathOf(a, "edge root->a"), "the pass did not run").not.toBe(before);
    expect(reads).toBeGreaterThan(0);
    // owningDiagram (1) + the drain's diagramKindOf (1) + the sitemap reflow
    // itself (1). It was six: isDiagramFrame, liveRouteOn and the dispatch
    // each parsed it again.
    expect(reads).toBeLessThanOrEqual(3);
    expect(diagramKindOf(a)).toEqual({ kind: "sitemap", liveRoute: true });
  });

  it("reflowAnyFrame takes the kind it was handed", async () => {
    const { a } = await twoDiagrams();
    const out = (await reflowAnyFrame(a, { onlyIfMoved: true }, "sitemap")) as any;
    expect(out.kind).toBe("sitemap");
  });
});

describe("shapeIndex", () => {
  const frameOf = (names: string[]) => ({ children: names.map((name, i) => ({ id: `n${i}`, name })) }) as any;

  it("answers exactly what findShape answers, first child winning", () => {
    const frame = frameOf(["edge a->b", "page:a · Home", "page:a", "page:ab", "page:b", "page:c d · two words"]);
    const index = shapeIndex(frame);
    for (const id of ["a", "ab", "b", "c d", "c", "zz"]) {
      expect(index.get(`page:${id}`) ?? null, id).toBe(findShape(frame, "page:", id));
    }
  });

  it("scanBoxes walks the children once, not once per box", () => {
    const names = Array.from({ length: 200 }, (_, i) => `page:n${i} · Page ${i}`);
    const kids = names.map((name, i) => ({ id: `n${i}`, name, x: 0, y: 0, width: 10, height: 10 }));
    let walks = 0;
    const frame = {
      get children() {
        walks++;
        return kids;
      },
    } as any;
    const scan = scanBoxes(frame, names.map((_, i) => ({ id: `n${i}` })), "page:");
    expect(scan.placed.size).toBe(200);
    expect(walks).toBe(1);
  });
});
