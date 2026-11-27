import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeContext } from "../../../src/plugin/context.js";
import { createFigjamDiagram, getSlides, createSlide } from "../../../src/plugin/handlers/surfaces.js";

/**
 * FigJam and Slides handlers against a fake `figma`. What matters is what the
 * CONNECTORS point at — a connector whose endpoints name the wrong shape
 * draws a confident, wrong diagram — and that the wrong editor is refused
 * with a next step instead of a TypeError deep inside createShapeWithText.
 */

const ctx = (params: Record<string, unknown>) => makeContext(params, () => {});
let seq = 0;
let made: any[];

function base(type: string): any {
  const n: any = { id: `${++seq}:1`, type, name: "", x: 0, y: 0, width: 100, height: 100, fills: [], children: [], data: {} as Record<string, string> };
  n.setPluginData = (k: string, v: string) => (n.data[k] = v);
  n.appendChild = (c: any) => {
    n.children.push(c);
    c.parent = n;
  };
  n.resize = n.resizeWithoutConstraints = (w: number, h: number) => {
    n.width = w;
    n.height = h;
  };
  n.text = { fontName: { family: "Inter", style: "Medium" }, characters: "" };
  made.push(n);
  return n;
}

function install(editorType: string): void {
  made = [];
  (globalThis as any).figma = {
    editorType,
    mixed: Symbol("mixed"),
    viewport: { center: { x: 500, y: 400 }, slidesView: "grid" },
    loadFontAsync: vi.fn(async () => {}),
    createSection: () => base("SECTION"),
    createShapeWithText: () => base("SHAPE_WITH_TEXT"),
    createSticky: () => base("STICKY"),
    createConnector: () => base("CONNECTOR"),
    createSlide: vi.fn((row?: number, col?: number) => Object.assign(base("SLIDE"), { width: 1920, height: 1080, row, col })),
    getSlideGrid: () => [
      [Object.assign(base("SLIDE"), { name: "Title" }), Object.assign(base("SLIDE"), { name: "Agenda", isSkippedSlide: true })],
      [Object.assign(base("SLIDE"), { name: "Q&A" })],
    ],
    currentPage: { name: "Deck" },
  };
}

beforeEach(() => install("figjam"));

const DIAGRAM = {
  kind: "userflow",
  title: "Checkout",
  width: 600,
  height: 300,
  nodes: [
    { id: "cart", label: "Cart", shape: "ROUNDED_RECTANGLE", color: "blue", x: 0, y: 0, w: 160, h: 80 },
    { id: "ok", label: "Paid?", shape: "DIAMOND", color: "yellow", x: 300, y: 0, w: 160, h: 120 },
    { id: "note", label: "Ask legal", shape: "STICKY", color: "yellow", x: 0, y: 200 },
  ],
  edges: [
    { from: "cart", to: "ok", label: "pay" },
    { from: "ok", to: "cart", dashed: true },
    { from: "ok", to: "ghost" },
  ],
};

describe("create_figjam_diagram", () => {
  it("draws shapes and stickies inside a titled section, at the placed positions", async () => {
    const out = (await createFigjamDiagram(ctx(DIAGRAM))) as any;
    const section = made.find((n) => n.type === "SECTION");
    expect(section.name).toBe("Checkout");
    const shapes = section.children.filter((n: any) => n.type === "SHAPE_WITH_TEXT");
    expect(shapes.map((s: any) => [s.shapeType, s.text.characters, s.x, s.width])).toEqual([
      ["ROUNDED_RECTANGLE", "Cart", 0, 160],
      ["DIAMOND", "Paid?", 300, 160],
    ]);
    expect(section.children.find((n: any) => n.type === "STICKY").text.characters).toBe("Ask legal");
    expect(out).toMatchObject({ sectionId: section.id, shapes: 3, connectors: 2 });
  });

  it("each connector's endpoints are the shapes its edge names", async () => {
    const out = (await createFigjamDiagram(ctx(DIAGRAM))) as any;
    const connectors = made.filter((n) => n.type === "CONNECTOR");
    expect(connectors[0].connectorStart).toEqual({ endpointNodeId: out.nodeIds.cart, magnet: "AUTO" });
    expect(connectors[0].connectorEnd).toEqual({ endpointNodeId: out.nodeIds.ok, magnet: "AUTO" });
    expect(connectors[0].text.characters).toBe("pay");
    expect(connectors[0].connectorEndStrokeCap).toBe("ARROW_LINES");
    expect(connectors[1].dashPattern).toEqual([10, 6]);
  });

  it("an edge to a missing node is a warning, not a dangling connector", async () => {
    const c = ctx(DIAGRAM);
    await createFigjamDiagram(c);
    expect(made.filter((n) => n.type === "CONNECTOR")).toHaveLength(2);
    expect(c.warnings[0]).toMatch(/ghost/);
  });

  it("refuses in Figma Design with a next step", async () => {
    install("figma");
    await expect(createFigjamDiagram(ctx(DIAGRAM))).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION", hint: expect.stringMatching(/FigJam/) });
    expect(made).toHaveLength(0);
  });
});

describe("Slides", () => {
  it("get_slides returns the grid as rows, skipped slides flagged", async () => {
    install("slides");
    const out = (await getSlides(ctx({}))) as any;
    expect(out.slideCount).toBe(3);
    expect(out.rows[0].map((s: any) => [s.name, s.row, s.col, !!s.skipped])).toEqual([
      ["Title", 0, 0, false],
      ["Agenda", 0, 1, true],
    ]);
  });

  it("create_slide puts it where asked and names it", async () => {
    install("slides");
    const out = (await createSlide(ctx({ name: "Roadmap", row: 1, col: 0 }))) as any;
    expect((globalThis as any).figma.createSlide).toHaveBeenCalledWith(1, 0);
    expect(out).toMatchObject({ name: "Roadmap", width: 1920, height: 1080 });
  });

  it("refuses outside Slides", async () => {
    install("figjam");
    await expect(getSlides(ctx({}))).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
  });
});
