import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBoard } from "../../src/plugin/handlers/board.js";
import { getDiagramSpec } from "../../src/plugin/handlers/diagram-spec.js";
import { makeContext } from "../../src/plugin/context.js";
import { buildBoard } from "../../src/server/board.js";
import { JOURNEY_MARKER, PERSONA_MARKER, USECASE_MARKER } from "../../src/plugin/diagram-mark.js";

/**
 * The board kinds end to end on the plugin side: the server's laid-out specs
 * draw into one frame, every model id maps to the node drawn for it, and the
 * frame carries its model so get_diagram_spec / update + patch work.
 */

let page: any;
let seq = 0;
let pageListeners: Array<(e: any) => void>;

function base(id: string, type: string): any {
  const n: any = {
    id,
    type,
    name: "",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    visible: true,
    removed: false,
    opacity: 1,
    rotation: 0,
    fills: [],
    strokes: [],
    strokeWeight: 1,
    strokeAlign: "CENTER",
    strokeCap: "NONE",
    strokeJoin: "MITER",
    dashPattern: [],
    effects: [],
    cornerRadius: 0,
    clipsContent: false,
    children: [],
    vectorPaths: [],
    pointCount: 3,
    characters: "",
    fontName: { family: "Inter", style: "Regular" },
    fontSize: 12,
    textAutoResize: "NONE",
    reactions: [],
    pluginData: {} as Record<string, string>,
    resize(w: number, h: number) {
      this.width = w;
      this.height = h;
    },
    appendChild(c: any) {
      this.children.push(c);
      c.parent = this;
    },
    insertChild(i: number, c: any) {
      this.children.splice(i, 0, c);
      c.parent = this;
    },
    setBoundVariable: vi.fn(),
    getPluginData(key: string) {
      return this.pluginData[key] ?? "";
    },
    setPluginData(key: string, value: string) {
      this.pluginData[key] = value;
    },
    setVectorNetworkAsync: async function (net: any) {
      // Mirror Figma: the network becomes the node's path data.
      this.vectorNetwork = net;
      this.vectorPaths = [
        {
          windingRule: "NONE",
          data: net.vertices.map((v: any, i: number) => `${i ? "L" : "M"} ${v.x} ${v.y}`).join(" "),
        },
      ];
      this.caps = net.vertices.map((v: any) => v.strokeCap);
    },
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((c: any) => c !== this);
    },
    setReactionsAsync: vi.fn(),
  };
  if (type === "FRAME") n.layoutMode = "NONE";
  return n;
}


const ctx = (params: Record<string, unknown>) => makeContext(params, () => {});

function draw(kind: "usecase" | "journey" | "persona", spec: Record<string, unknown>) {
  const built = buildBoard(kind, spec);
  return { built, params: { ...built.draw, source: built.model } as unknown as Record<string, unknown> };
}

beforeEach(() => {
  seq = 0;
  pageListeners = [];
  page = {
    id: "0:1",
    type: "PAGE",
    children: [] as any[],
    appendChild(n: any) {
      this.children.push(n);
      n.parent = this;
    },
    insertChild(i: number, n: any) {
      this.children.splice(i, 0, n);
      n.parent = this;
    },
    on(type: string, cb: (e: any) => void) {
      if (type === "nodechange") pageListeners.push(cb);
    },
    off() {},
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
    createEllipse: vi.fn(() => base(`60:${++seq}`, "ELLIPSE")),
  };
});


describe("createBoard", () => {
  it("draws a use case diagram, maps ids to nodes and stores the model", async () => {
    const { built, params } = draw("usecase", { title: "Booking", text: 'system "Ticketing"\nactor visitor "Visitor"\nuc book "Book seats"\nuc hold "Hold seats"\nvisitor - book\nbook => hold' });
    const res = (await createBoard(ctx(params))) as any;
    const frame = page.children[0];
    expect(res.frameId).toBe(frame.id);
    expect(frame.name).toBe("Use case · Booking");
    expect(frame.children).toHaveLength(built.draw.children.length);
    expect(Object.keys(res.nodes).sort()).toEqual(["book", "hold", "visitor"]);
    const mark = JSON.parse(frame.getPluginData(USECASE_MARKER));
    expect(mark.kind).toBe("usecase");
    expect(mark.source.links).toHaveLength(2);
    const spec = (await getDiagramSpec(ctx({ nodeId: frame.id }))) as any;
    expect(spec.kind).toBe("usecase");
    expect(spec.spec.system).toBe("Ticketing");
  });

  it("draws a journey map and a persona set with their own markers", async () => {
    const j = draw("journey", { title: "First booking", persona: "Thu", phases: [{ id: "a", label: "Find", actions: ["Open"], feeling: 1 }, { id: "b", label: "Pay", actions: ["Card"], feeling: -2, pains: ["Fees"], ideas: ["Show total"] }] });
    await createBoard(ctx(j.params));
    const p = draw("persona", { title: "People", source: "4 interviews", personas: [{ id: "thu", name: "Thu Trang", primary: true, goals: ["Fast"], pains: ["Fees"] }] });
    await createBoard(ctx(p.params));
    const [jf, pf] = page.children;
    expect(JSON.parse(jf.getPluginData(JOURNEY_MARKER)).source.persona).toBe("Thu");
    expect(JSON.parse(pf.getPluginData(PERSONA_MARKER)).source.personas[0].name).toBe("Thu Trang");
    // The second frame keeps clear of the first.
    expect(pf.y >= jf.y + jf.height || pf.x >= jf.x + jf.width).toBe(true);
  });

  it("refuses data it cannot draw before touching the canvas", async () => {
    await expect(createBoard(ctx({ kind: "bpmn", children: [] }))).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(createBoard(ctx({ kind: "usecase", name: "x", title: "x", x: 0, y: 0, w: 10, h: 10, children: [{ name: "no type" }] }))).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    expect(page.children).toHaveLength(0);
  });
});
