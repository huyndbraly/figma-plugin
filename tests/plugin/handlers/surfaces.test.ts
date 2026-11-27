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
  n.getPluginData = (k: string) => n.data[k] ?? "";
  n.remove = () => {
    n.removed = true;
    if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1);
  };
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
    getNodeByIdAsync: async (id: string) => made.find((n) => n.id === id) ?? null,
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


describe("create_figjam_diagram: the section remembers its model (review D2)", () => {
  it("stores { kind, title, source, native } on the section", async () => {
    const out = (await createFigjamDiagram(ctx({ ...DIAGRAM, source: { title: "Checkout", nodes: [] } }))) as any;
    const section = made.find((n) => n.id === out.sectionId);
    const mark = JSON.parse(section.data["figma-plugin.figjam"]);
    expect(mark).toMatchObject({ kind: "userflow", title: "Checkout", source: { title: "Checkout", nodes: [] }, native: "figjam" });
    // …and exactly which nodes it drew, so a redraw removes only those.
    expect(mark.drawn.sort()).toEqual(section.children.map((c: any) => c.id).sort());
  });

  it("intoSectionId redraws in place: same section, old shapes gone", async () => {
    const first = (await createFigjamDiagram(ctx(DIAGRAM))) as any;
    const section = made.find((n) => n.id === first.sectionId);
    section.x = 777; // the user moved it
    const oldIds = section.children.map((c: any) => c.id);
    const again = (await createFigjamDiagram(ctx({ ...DIAGRAM, title: "Checkout v2", intoSectionId: section.id }))) as any;
    expect(again).toMatchObject({ sectionId: section.id, redrawn: true });
    expect(section.x).toBe(777);
    expect(section.name).toBe("Checkout v2");
    expect(section.children.some((c: any) => oldIds.includes(c.id))).toBe(false);
    expect(made.filter((n) => n.type === "SECTION")).toHaveLength(1);
  });

  it("refuses to redraw into something that is not a FigJam diagram section", async () => {
    const plain = (globalThis as any).figma.createSection();
    await expect(createFigjamDiagram(ctx({ ...DIAGRAM, intoSectionId: plain.id }))).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });

  it("a failure part-way removes the section it created — no half-drawn diagram", async () => {
    (globalThis as any).figma.loadFontAsync = vi.fn(async () => {
      throw new Error("font missing");
    });
    await expect(createFigjamDiagram(ctx(DIAGRAM))).rejects.toThrow(/font missing/);
    expect(made.find((n) => n.type === "SECTION").removed).toBe(true);
  });
});

describe("createSlide col without row (review)", () => {
  it("puts it in row 0 and says so", async () => {
    install("slides");
    const c = ctx({ col: 2 });
    await createSlide(c);
    expect((globalThis as any).figma.createSlide).toHaveBeenCalledWith(0, 2);
    expect(c.warnings[0]).toMatch(/row 0/);
  });
});

describe("a FigJam section reads back like a diagram frame (review D2)", () => {
  it("readDiagramSource / get_diagram_spec see kind, model and native:figjam", async () => {
    const { readDiagramSource } = await import("../../../src/plugin/diagram-apply.js");
    const out = (await createFigjamDiagram(ctx({ ...DIAGRAM, source: { title: "Checkout", nodes: [{ id: "cart" }] } }))) as any;
    const section = made.find((n) => n.id === out.sectionId);
    expect(readDiagramSource(section)).toEqual({ kind: "userflow", title: "Checkout", source: { title: "Checkout", nodes: [{ id: "cart" }] }, native: "figjam" });
  });
});

describe("redraw into a section, second pass (review)", () => {
  it("a failed redraw keeps the PREVIOUS drawing, its name and its stored model", async () => {
    const first = (await createFigjamDiagram(ctx({ ...DIAGRAM, source: { v: 1 } }))) as any;
    const section = made.find((n) => n.id === first.sectionId);
    const before = section.children.map((c: any) => c.id);
    const marker = section.data["figma-plugin.figjam"];
    let calls = 0;
    (globalThis as any).figma.loadFontAsync = vi.fn(async () => {
      if (++calls > 1) throw new Error("font missing");
    });
    await expect(createFigjamDiagram(ctx({ ...DIAGRAM, title: "v2", source: { v: 2 }, intoSectionId: section.id }))).rejects.toThrow(/font missing/);
    expect(section.children.map((c: any) => c.id)).toEqual(before);
    expect(section.name).toBe("Checkout");
    expect(section.data["figma-plugin.figjam"]).toBe(marker);
  });

  it("a redraw keeps what the USER added inside the section", async () => {
    const first = (await createFigjamDiagram(ctx(DIAGRAM))) as any;
    const section = made.find((n) => n.id === first.sectionId);
    const note = base("STICKY");
    section.appendChild(note); // the user's own sticky: no figjam-id
    await createFigjamDiagram(ctx({ ...DIAGRAM, intoSectionId: section.id }));
    expect(section.children).toContain(note);
    expect(section.children.filter((c: any) => c.data["figjam-id"] === "cart")).toHaveLength(1); // old copy gone
  });

  it("a section from the first FigJam build (legacy key) reads back as FigJam with no model", async () => {
    const { readDiagramSource } = await import("../../../src/plugin/diagram-apply.js");
    const old = (globalThis as any).figma.createSection();
    old.setPluginData("figjam-diagram", JSON.stringify({ kind: "userflow", title: "Old" }));
    expect(readDiagramSource(old)).toEqual({ kind: "userflow", title: "Old", native: "figjam" });
  });

  it("the draw hands back the page's diagrams (sections included) for the cross-check", async () => {
    const page = { type: "PAGE", children: [] as any[], findAllWithCriteria: ({ types }: { types: string[] }) => made.filter((n) => types.includes(n.type) && (n.data["figma-plugin.figjam"] || n.data["figjam-diagram"])) };
    const first = (await createFigjamDiagram(ctx({ ...DIAGRAM, source: { title: "A" } }))) as any;
    made.find((n) => n.id === first.sectionId).parent = page;
    const second = (globalThis as any).figma.createSection();
    second.parent = page;
    second.setPluginData("figma-plugin.figjam", JSON.stringify({ kind: "state", title: "Order", source: { title: "Order" }, native: "figjam" }));
    const out = (await createFigjamDiagram(ctx({ ...DIAGRAM, intoSectionId: first.sectionId, source: { title: "A2" } }))) as any;
    expect(out.pageModel.map((d: any) => d.kind).sort()).toEqual(["state", "userflow"]);
  });
});


describe("redraw, third pass (review)", () => {
  it("a copy the USER pasted of a tool shape (same figjam-id tag) survives a redraw", async () => {
    const first = (await createFigjamDiagram(ctx(DIAGRAM))) as any;
    const section = made.find((n) => n.id === first.sectionId);
    const copy = base("SHAPE_WITH_TEXT");
    copy.data["figjam-id"] = "cart"; // Figma copies plugin data with the node
    section.appendChild(copy);
    await createFigjamDiagram(ctx({ ...DIAGRAM, intoSectionId: section.id }));
    expect(section.children).toContain(copy);
  });

  it("the user's connector to a redrawn shape is moved to the new shape", async () => {
    const first = (await createFigjamDiagram(ctx(DIAGRAM))) as any;
    const section = made.find((n) => n.id === first.sectionId);
    const note = base("STICKY");
    section.appendChild(note);
    const userArrow = base("CONNECTOR");
    section.appendChild(userArrow);
    userArrow.connectorStart = { endpointNodeId: note.id, magnet: "AUTO" };
    userArrow.connectorEnd = { endpointNodeId: first.nodeIds.cart, magnet: "AUTO" };
    const again = (await createFigjamDiagram(ctx({ ...DIAGRAM, intoSectionId: section.id }))) as any;
    expect(section.children).toContain(userArrow);
    expect(userArrow.connectorEnd.endpointNodeId).toBe(again.nodeIds.cart);
    expect(userArrow.connectorStart.endpointNodeId).toBe(note.id);
  });

  it("a page-model failure after a successful draw is a warning, not an error", async () => {
    const c = ctx(DIAGRAM);
    const out = (await (async () => {
      const r = (await createFigjamDiagram(c)) as any;
      return r;
    })()) as any;
    expect(out.sectionId).toBeTruthy();
    // pageModel reads parent chains; a section with no page parent returns [] — make it throw instead:
    const section = made.find((n) => n.id === out.sectionId);
    Object.defineProperty(section, "parent", { get() { throw new Error("page walk failed"); } });
    const c2 = ctx({ ...DIAGRAM, intoSectionId: section.id });
    const again = (await createFigjamDiagram(c2)) as any;
    expect(again.redrawn).toBe(true);
    expect(again).not.toHaveProperty("pageModel");
    expect(c2.warnings.join("\n")).toMatch(/not cross-checked/);
  });
});

describe("redraw, fourth pass (review)", () => {
  it("a DUPLICATED section (marker list names the original's ids) still replaces its own drawing", async () => {
    const first = (await createFigjamDiagram(ctx(DIAGRAM))) as any;
    const original = made.find((n) => n.id === first.sectionId);
    const dup = (globalThis as any).figma.createSection();
    dup.data["figma-plugin.figjam"] = original.data["figma-plugin.figjam"]; // copied plugin data
    for (const c of original.children) {
      const k = base(c.type);
      k.data = { ...c.data };
      dup.appendChild(k); // new ids, same tags
    }
    const before = dup.children.length;
    await createFigjamDiagram(ctx({ ...DIAGRAM, intoSectionId: dup.id }));
    expect(dup.children.length).toBe(before); // replaced, not doubled
    expect(original.children.length).toBe(before); // the original is untouched
  });

  it("a user connector OUTSIDE the section is re-pointed too; one that cannot be moved is a warning", async () => {
    const page: any = { type: "PAGE", children: [] as any[], findAllWithCriteria: ({ types }: { types: string[] }) => made.filter((n) => types.includes(n.type) && !n.removed) };
    const first = (await createFigjamDiagram(ctx(DIAGRAM))) as any;
    const section = made.find((n) => n.id === first.sectionId);
    section.parent = page;
    const outside = base("CONNECTOR"); // on the page, not in the section
    outside.connectorStart = { endpointNodeId: "elsewhere", magnet: "AUTO" };
    outside.connectorEnd = { endpointNodeId: first.nodeIds.cart, magnet: "AUTO" };
    const locked = base("CONNECTOR");
    locked.connectorStart = { endpointNodeId: first.nodeIds.ok, magnet: "AUTO" };
    let end = { endpointNodeId: "elsewhere", magnet: "AUTO" };
    Object.defineProperty(locked, "connectorEnd", { get: () => end, set: () => { throw new Error("locked"); } });
    Object.defineProperty(locked, "connectorStart", { get: () => ({ endpointNodeId: first.nodeIds.ok, magnet: "AUTO" }), set: () => { throw new Error("locked"); } });
    const c2 = ctx({ ...DIAGRAM, intoSectionId: section.id });
    const again = (await createFigjamDiagram(c2)) as any;
    expect(outside.connectorEnd.endpointNodeId).toBe(again.nodeIds.cart);
    expect(again.redrawn).toBe(true); // the locked connector did not abort the redraw
    expect(c2.warnings.join("\n")).toMatch(/1 end\(s\) of connectors you drew/);
    void end;
  });

  it("a section whose marker JSON is corrupt reads back as FigJam, not as a Design frame", async () => {
    const { readDiagramSource } = await import("../../../src/plugin/diagram-apply.js");
    const s = (globalThis as any).figma.createSection();
    s.setPluginData("figma-plugin.figjam", "{not json");
    expect(readDiagramSource(s)).toEqual({ native: "figjam" });
  });
});
