import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDesignContext, scanNodesByTypes, searchNodes } from "../../../src/plugin/handlers/read.js";
import { screenshot, SCREENSHOT_MAX_SIDE } from "../../../src/plugin/handlers/export.js";
import { makeContext, HandlerContext } from "../../../src/plugin/context.js";

/**
 * Read ops that could answer with the whole file. A depth limit does not
 * bound a page (400 screens × 40 layers at depth 3 is 16 000 nodes), "every
 * FRAME" on a big file is thousands of nodes, and a whole-page screenshot at
 * the default scale was a 30 000-pixel PNG.
 */

const warnings: string[] = [];
const ctx = (params: Record<string, unknown>): HandlerContext => {
  const c = makeContext(params, () => {});
  const warn = c.warn;
  c.warn = (m: string) => {
    warnings.push(m);
    warn(m);
  };
  return c;
};

function frame(id: string, children: any[] = []): any {
  return { id, name: id, type: "FRAME", x: 0, y: 0, width: 100, height: 100, visible: true, children };
}

let page: any;
beforeEach(() => {
  warnings.length = 0;
  // 50 screens × 50 layers each.
  const screens = Array.from({ length: 50 }, (_, s) =>
    frame(`s${s}`, Array.from({ length: 50 }, (_, l) => frame(`s${s}-l${l}`))),
  );
  const all = screens.flatMap((s) => [s, ...s.children]);
  page = {
    id: "0:1",
    name: "Page",
    type: "PAGE",
    children: screens,
    selection: [],
    loadAsync: vi.fn(async () => {}),
    findAllWithCriteria: vi.fn(() => all),
    findAll: vi.fn((cb?: (n: any) => boolean) => (cb ? all.filter(cb) : all)),
    exportAsync: vi.fn(async () => new Uint8Array([1, 2, 3])),
  };
  for (const s of screens) s.absoluteBoundingBox = { x: 0, y: 0, width: 0, height: 0 };
  (globalThis as any).figma = { currentPage: page, mixed: Symbol("mixed"), getNodeByIdAsync: vi.fn(async () => null) };
});

const count = (n: any): number => 1 + (n.children ?? []).reduce((s: number, c: any) => s + count(c), 0);

describe("get_design_context", () => {
  it("stops at maxNodes, breadth-first, and says so", async () => {
    const out = (await getDesignContext(ctx({ maxNodes: 500 }))) as any;
    expect(out.truncated).toBe(true);
    expect(count(out.tree)).toBeLessThanOrEqual(500);
    // The outline survives: every screen is there; the insides that did not
    // fit are marked with how many children they hold.
    expect(out.tree.children).toHaveLength(50);
    expect(out.tree.children[0].children).toHaveLength(50);
    expect(out.tree.children[49].children).toBeUndefined();
    expect(out.tree.children[49].childrenTruncated).toBe(50);
  });

  it("caps at 3000 by default and is untouched below it", async () => {
    const out = (await getDesignContext(ctx({}))) as any;
    expect(out.truncated).toBeUndefined();
    expect(count(out.tree)).toBe(1 + 50 + 2500);
    const huge = (await getDesignContext(ctx({ maxNodes: 100_000 }))) as any;
    expect(count(huge.tree)).toBe(count(out.tree));
  });
});

describe("scan_nodes_by_types", () => {
  it("returns 200 by default with hasMore and the real total", async () => {
    const out = (await scanNodesByTypes(ctx({ types: ["FRAME"] }))) as any;
    expect(out.count).toBe(200);
    expect(out.nodes).toHaveLength(200);
    expect(out.hasMore).toBe(true);
    expect(out.totalMatched).toBe(2550);
  });

  it("honours an explicit limit", async () => {
    const out = (await scanNodesByTypes(ctx({ types: ["FRAME"], limit: 5000 }))) as any;
    expect(out.count).toBe(2550);
    expect(out.hasMore).toBeUndefined();
  });
});

describe("search_nodes", () => {
  it("asks for every node without a per-node callback", async () => {
    await searchNodes(ctx({ query: "s1-l1" }));
    expect(page.findAll).toHaveBeenCalledWith();
  });
});

describe("screenshot", () => {
  it("clamps the scale so the longest side stays within the cap, and warns", async () => {
    page.children[0].absoluteBoundingBox = { x: 0, y: 0, width: 20_000, height: 2_000 };
    page.children[1].absoluteBoundingBox = { x: 30_000, y: 0, width: 10_000, height: 2_000 };
    const out = (await screenshot(ctx({}))) as any;
    expect(out.scale).toBeCloseTo(SCREENSHOT_MAX_SIDE / 40_000);
    expect(page.exportAsync).toHaveBeenCalledWith({ format: "PNG", constraint: { type: "SCALE", value: out.scale } });
    expect(warnings.join(" ")).toMatch(/longest side/);
  });

  it("leaves a small page at the asked scale", async () => {
    page.children[0].absoluteBoundingBox = { x: 0, y: 0, width: 1440, height: 900 };
    const out = (await screenshot(ctx({ scale: 2 }))) as any;
    expect(out.scale).toBe(2);
    expect(warnings).toEqual([]);
  });
});
