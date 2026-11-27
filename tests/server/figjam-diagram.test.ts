import { describe, expect, it, vi } from "vitest";
import { handleDiagram, type ToolContext } from "../../src/server/tools.js";
import { validateOperation } from "../../src/server/validate.js";

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
