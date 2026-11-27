import { describe, expect, it, vi } from "vitest";
import { handleDiagram, type ToolContext } from "../../src/server/tools.js";
import { validateOperation } from "../../src/server/validate.js";
import { checkConsistency } from "../../src/shared/model/check.js";

/**
 * figma_diagram in a FigJam window draws with FigJam's own nodes — and still
 * proof-reads the model. Asserted on the OPS the call sent: the native op,
 * never the frame-drawing one, and the checker's findings in the answer.
 */

function ctxFor(editorType: string) {
  const calls: Array<[string, any]> = [];
  const ctx = {
    runValidated: vi.fn(async (op: string, params: any) => {
      calls.push([op, params]);
      if (op === "list_channels") return [{ channel: "c1", plugin: { fileName: "Board", editorType } }];
      // The plugin's answer, after the same validation a real call gets.
      validateOperation(op, params);
      if (op === "create_figjam_diagram") return { sectionId: "5:5", nodeIds: {}, shapes: params.nodes.length, connectors: params.edges.length };
      if (op === "layout_audit") return { nodeCount: 1, summary: { issues: [], styleHints: [] } };
      return { frameId: "9:9" };
    }),
  } as unknown as ToolContext;
  return { ctx, calls };
}

const FLOW = {
  title: "Login",
  nodes: [
    { id: "a", label: "Login", screenId: "01" },
    { id: "b", label: "Valid?", kind: "decision" },
    { id: "c", label: "Home", screenId: "02" },
  ],
  edges: [
    { from: "a", to: "b" },
    { from: "b", to: "c", label: "yes" },
  ],
};

describe("figma_diagram in FigJam", () => {
  it("sends create_figjam_diagram with placed nodes, not create_userflow", async () => {
    const { ctx, calls } = ctxFor("figjam");
    const out = (await handleDiagram(ctx, "userflow", FLOW)) as any;
    const ops = calls.map((c) => c[0]);
    expect(ops).toContain("create_figjam_diagram");
    expect(ops).not.toContain("create_userflow");
    const sent = calls.find((c) => c[0] === "create_figjam_diagram")![1];
    expect(sent.nodes.map((n: any) => n.shape)).toEqual(["ROUNDED_RECTANGLE", "DIAMOND", "ROUNDED_RECTANGLE"]);
    expect(sent.nodes.every((n: any) => typeof n.x === "number" && typeof n.y === "number")).toBe(true);
    expect(out.native).toBe("figjam");
  });

  it("still reports the model's findings (a decision with one way out)", async () => {
    const { ctx } = ctxFor("figjam");
    const out = (await handleDiagram(ctx, "userflow", FLOW)) as any;
    expect((out.warnings ?? []).join("\n")).toMatch(/Valid\?|decision/i);
  });

  it("checkFirst with findings draws nothing", async () => {
    const { ctx, calls } = ctxFor("figjam");
    const out = (await handleDiagram(ctx, "userflow", { ...FLOW, options: { checkFirst: true } })) as any;
    expect(out.checkedOnly).toBe(true);
    expect(calls.map((c) => c[0])).not.toContain("create_figjam_diagram");
  });

  it("in Figma Design the frame-drawing path is unchanged", async () => {
    const { ctx, calls } = ctxFor("figma");
    await handleDiagram(ctx, "userflow", FLOW);
    const ops = calls.map((c) => c[0]);
    expect(ops).toContain("create_userflow");
    expect(ops).not.toContain("create_figjam_diagram");
  });

  it("kinds with no FigJam form (erd) keep the Design drawing even in FigJam", async () => {
    const { ctx, calls } = ctxFor("figjam");
    await handleDiagram(ctx, "erd", { title: "DB", entities: [{ id: "u", name: "users", columns: [{ name: "id", pk: true }] }] }).catch(() => undefined);
    expect(calls.map((c) => c[0])).not.toContain("create_figjam_diagram");
  });
});


describe("board kinds and stored models in FigJam (review D2)", () => {
  it("persona in FigJam sends stickies AND the model the section will store", async () => {
    const { ctx, calls } = ctxFor("figjam");
    const out = (await handleDiagram(ctx, "persona", { title: "People", source: "interviews", personas: [{ id: "a", name: "An", primary: true, goals: ["g"], pains: ["p"] }], options: { checkFirst: false } })) as any;
    const sent = calls.find((c) => c[0] === "create_figjam_diagram")![1];
    expect(sent.nodes.every((n: any) => n.shape === "STICKY")).toBe(true);
    expect(sent.source).toMatchObject({ title: "People", personas: [{ id: "a" }] });
    expect(sent.source.options).not.toHaveProperty("checkFirst"); // draw-only options are not stored
    expect(out.native).toBe("figjam");
  });

  it("sequence and erd keep the Figma Design drawing in FigJam", async () => {
    const { ctx, calls } = ctxFor("figjam");
    await handleDiagram(ctx, "sequence", { title: "S", participants: [{ id: "a", label: "A" }, { id: "b", label: "B" }], messages: [{ from: "a", to: "b", label: "hi" }] }).catch(() => undefined);
    expect(calls.map((c) => c[0])).not.toContain("create_figjam_diagram");
  });

  it("a patch on a FigJam section redraws INTO that section, natively", async () => {
    const calls: Array<[string, any]> = [];
    const ctx = {
      runValidated: vi.fn(async (op: string, params: any) => {
        calls.push([op, params]);
        if (op === "list_channels") return [{ channel: "c1", plugin: { fileName: "Board", editorType: "figjam" } }];
        if (op === "get_diagram_spec") return { nodeId: "9:9", kind: "userflow", native: "figjam", spec: FLOW };
        if (op === "create_figjam_diagram") return { sectionId: params.intoSectionId, redrawn: true };
        return {};
      }),
    } as unknown as ToolContext;
    const out = (await handleDiagram(ctx, undefined, { update: "9:9", patch: [{ collection: "nodes", id: "c", set: { label: "Dashboard" } }] })) as any;
    const sent = calls.find((c) => c[0] === "create_figjam_diagram")![1];
    expect(sent.intoSectionId).toBe("9:9");
    expect(sent.nodes.find((n: any) => n.id === "c").label).toBe("Dashboard");
    expect(sent.source.nodes.find((n: any) => n.id === "c").label).toBe("Dashboard");
    expect(calls.map((c) => c[0])).not.toContain("create_userflow");
    expect(out.patched).toBeTruthy();
  });
});

// Two diagrams that disagree: the sequence says "Shipper" sends, the state
// machine of the same entity never mentions it, and the policies differ.
const PAGE = [
  { nodeId: "5:5", kind: "state", title: "Order", spec: { title: "Order", states: [{ id: "new", label: "New" }, { id: "paid", label: "Paid" }], transitions: [{ from: "new", to: "paid", event: "pay" }], options: { policies: { "hold-minutes": 10 } } } },
  { nodeId: "6:6", kind: "state", title: "Order v2", spec: { title: "Order", states: [{ id: "new", label: "New" }, { id: "cancelled", label: "Cancelled" }], transitions: [{ from: "new", to: "cancelled", event: "cancel" }], options: { policies: { "hold-minutes": 15 } } } },
];

describe("FigJam update, second pass (review)", () => {
  it("a get_diagram_spec failure on a full-spec update does NOT fall through to the Design drawing", async () => {
    const calls: string[] = [];
    const ctx = {
      runValidated: vi.fn(async (op: string) => {
        calls.push(op);
        if (op === "list_channels") return [{ channel: "c1", plugin: { fileName: "Board", editorType: "figjam" } }];
        if (op === "get_diagram_spec") throw Object.assign(new Error("Plugin timed out"), { code: "PLUGIN_TIMEOUT" });
        return { frameId: "1:1" };
      }),
    } as unknown as ToolContext;
    await expect(handleDiagram(ctx, "userflow", { ...FLOW, update: "9:9" })).rejects.toMatchObject({ code: "PLUGIN_TIMEOUT" });
    expect(calls).not.toContain("create_userflow");
  });

  it("a FigJam draw returns `consistency` from the page model the plugin handed back", async () => {
    const ctx = {
      runValidated: vi.fn(async (op: string, params: any) => {
        if (op === "list_channels") return [{ channel: "c1", plugin: { fileName: "Board", editorType: "figjam" } }];
        if (op === "create_figjam_diagram") return { sectionId: "5:5", pageModel: PAGE };
        validateOperation(op, params);
        return {};
      }),
    } as unknown as ToolContext;
    const out = (await handleDiagram(ctx, "state", { title: "Order", states: [{ id: "paid", label: "Paid" }], transitions: [] })) as any;
    expect(out).not.toHaveProperty("pageModel");
    expect(out.native).toBe("figjam");
    const expected = checkConsistency(PAGE as never);
    expect(expected.length).toBeGreaterThan(0); // the fixture really disagrees with itself
    expect(out.consistency).toEqual(expected);
  });
});


describe("legacy FigJam sections, third pass (review)", () => {
  function legacyCtx() {
    const calls: Array<[string, any]> = [];
    const ctx = {
      runValidated: vi.fn(async (op: string, params: any) => {
        calls.push([op, params]);
        if (op === "list_channels") return [{ channel: "c1", plugin: { fileName: "Board", editorType: "figjam" } }];
        // What the plugin now answers for a section with no stored model: STRUCTURE, not an error.
        if (op === "get_diagram_spec") return { nodeId: "7:7", native: "figjam", spec: null, hint: "…" };
        if (op === "create_figjam_diagram") return { sectionId: params.intoSectionId ?? "new", redrawn: !!params.intoSectionId };
        return {};
      }),
    } as unknown as ToolContext;
    return { ctx, calls };
  }

  it("a full-spec update redraws INTO the legacy section — no duplicate section", async () => {
    const { ctx, calls } = legacyCtx();
    const out = (await handleDiagram(ctx, "userflow", { ...FLOW, update: "7:7" })) as any;
    const sent = calls.find((c) => c[0] === "create_figjam_diagram")![1];
    expect(sent.intoSectionId).toBe("7:7");
    expect(out.sectionId).toBe("7:7");
    expect(calls.map((c) => c[0])).not.toContain("create_userflow");
  });

  it("a PATCH on it says there is no model to patch, and how to redraw", async () => {
    const { ctx } = legacyCtx();
    await expect(handleDiagram(ctx, undefined, { update: "7:7", patch: [{ collection: "nodes", id: "a", set: { label: "x" } }] })).rejects.toMatchObject({
      code: "INVALID_PARAMS",
      hint: expect.stringMatching(/full spec with `type` and `update`/),
    });
  });

  it("a Design frame NAMED like FigJam is still redrawn as a Design frame (no message sniffing)", async () => {
    const calls: string[] = [];
    const ctx = {
      runValidated: vi.fn(async (op: string, params: any) => {
        calls.push(op);
        if (op === "list_channels") return [{ channel: "c1", plugin: { fileName: "Board", editorType: "figma" } }];
        if (op === "get_diagram_spec") throw Object.assign(new Error('"FigJam flow v1" was drawn before the model was stored on the frame.'), { code: "INVALID_PARAMS" });
        if (op === "layout_audit") return { nodeCount: 1, summary: { issues: [], styleHints: [] } };
        validateOperation(op, params);
        return { frameId: "9:9" };
      }),
    } as unknown as ToolContext;
    await handleDiagram(ctx, "userflow", { ...FLOW, update: "9:9" });
    expect(calls).toContain("create_userflow");
  });
});

describe("FigJam redraw, fourth pass (review)", () => {
  it("an OLDER plugin's legacy-section error still redraws into the section, not as a Design frame", async () => {
    const calls: Array<[string, any]> = [];
    const ctx = {
      runValidated: vi.fn(async (op: string, params: any) => {
        calls.push([op, params]);
        if (op === "list_channels") return [{ channel: "c1", plugin: { fileName: "Board", editorType: "figjam" } }];
        if (op === "get_diagram_spec") throw Object.assign(new Error('"Checkout" is a FigJam section drawn before the model was stored on it.'), { code: "INVALID_PARAMS" });
        if (op === "create_figjam_diagram") return { sectionId: params.intoSectionId ?? "new", redrawn: !!params.intoSectionId };
        return {};
      }),
    } as unknown as ToolContext;
    await handleDiagram(ctx, "userflow", { ...FLOW, update: "7:7" });
    expect(calls.find((c) => c[0] === "create_figjam_diagram")![1].intoSectionId).toBe("7:7");
    expect(calls.map((c) => c[0])).not.toContain("create_userflow");
  });
});
