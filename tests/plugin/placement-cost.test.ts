import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertInto } from "../../src/plugin/insert.js";
import { keepClearOnCanvas, resetKeepClearGroups } from "../../src/plugin/keep-clear.js";
import { readFlowMarks, FLOW_MARKER } from "../../src/plugin/flow-mark.js";
import { makeContext } from "../../src/plugin/context.js";

/**
 * What placing one more node on a big page costs. Each of these read every
 * layer on the page for every node created, so drawing N screens onto a page
 * of M layers was N×M reads: insertInto read every child id to find the end
 * of the list, keepClearOnCanvas read every sibling's geometry, and the
 * userflow check read every layer's plugin data.
 */

const ctx = (params: Record<string, unknown> = {}) => makeContext(params, () => {});

/** A sibling whose geometry reads are counted. */
function counted(id: string, x: number, y: number, w: number, h: number, tally: { reads: number }): any {
  const n: any = { id, name: id, type: "FRAME", visible: true, removed: false, width: w, height: h, x, y };
  for (const k of ["x", "y", "width", "height"] as const) {
    let v = n[k];
    Object.defineProperty(n, k, {
      get: () => {
        tally.reads++;
        return v;
      },
      set: (nv) => {
        v = nv;
      },
    });
  }
  return n;
}

function pageOf(children: any[]): any {
  const page: any = {
    id: "0:1",
    type: "PAGE",
    _kids: children,
    get children() {
      return this._kids;
    },
    appendChild(n: any) {
      this._kids = this._kids.filter((c: any) => c !== n).concat([n]);
      n.parent = this;
    },
    insertChild(i: number, n: any) {
      const rest = this._kids.filter((c: any) => c !== n);
      rest.splice(i, 0, n);
      this._kids = rest;
      n.parent = this;
    },
  };
  for (const c of children) c.parent = page;
  return page;
}

beforeEach(() => {
  resetKeepClearGroups();
  (globalThis as any).figma = { mixed: Symbol("mixed") };
});

describe("insertInto", () => {
  it("appends without reading a single child id", () => {
    const kids = Array.from({ length: 5 }, (_, i) => ({ id: `1:${i}` }));
    let idReads = 0;
    for (const k of kids) {
      const id = k.id;
      Object.defineProperty(k, "id", { get: () => (idReads++, id) });
    }
    const page = pageOf(kids);
    const node: any = { id: "9:9" };
    insertInto(page, node, undefined);
    insertInto(page, node, "top");
    expect(page.children[page.children.length - 1]).toBe(node);
    insertInto(page, node, "bottom");
    expect(page.children[0]).toBe(node);
    expect(idReads).toBe(0);
  });

  it("an index or a neighbour still lands where it was asked", () => {
    const kids = [{ id: "1:0" }, { id: "1:1" }, { id: "1:2" }];
    const page = pageOf(kids);
    const node: any = { id: "9:9" };
    insertInto(page, node, { above: "1:0" });
    expect(page.children.map((c: any) => c.id)).toEqual(["1:0", "9:9", "1:1", "1:2"]);
  });
});

describe("keepClearOnCanvas within one figma_write call", () => {
  it("reads the page's layers once, not once per new node — and still keeps clear", () => {
    const tally = { reads: 0 };
    const existing = Array.from({ length: 100 }, (_, i) => counted(`1:${i}`, i * 500, 0, 400, 800, tally));
    const page = pageOf(existing);
    const c = ctx();
    const placed: any[] = [];
    for (let i = 0; i < 10; i++) {
      // Asked for a spot under existing work, one row: all must move together.
      const node: any = { id: `9:${i}`, name: `New ${i}`, type: "FRAME", visible: true, x: i * 500, y: 100, width: 400, height: 300 };
      page.appendChild(node);
      keepClearOnCanvas(node, { placeGroup: "w1" }, c);
      placed.push(node);
    }
    // One pass over the 100 (4 geometry reads each), plus the few hits that
    // are re-read before they may push a node away. It was a full pass per
    // new node: 4 000+.
    expect(tally.reads).toBeLessThan(1000);
    for (const n of placed) expect(n.y).toBeGreaterThanOrEqual(800);
    expect(new Set(placed.map((n) => n.y)).size, "the row came out on several levels").toBe(1);
  });

  it("a later node in the same call keeps clear of an earlier one", () => {
    const page = pageOf([]);
    const c = ctx();
    const a: any = { id: "9:1", name: "A", type: "FRAME", visible: true, x: 0, y: 0, width: 400, height: 300 };
    page.appendChild(a);
    keepClearOnCanvas(a, {}, c);
    const b: any = { id: "9:2", name: "B", type: "FRAME", visible: true, x: 0, y: 0, width: 400, height: 300 };
    page.appendChild(b);
    keepClearOnCanvas(b, {}, c);
    expect(b.y).toBeGreaterThanOrEqual(300);
  });

  it("a layer moved away earlier in the call no longer blocks the spot it left", () => {
    const tally = { reads: 0 };
    const old = counted("1:1", 0, 0, 400, 800, tally);
    const page = pageOf([old]);
    const first: any = { id: "9:1", name: "First", type: "FRAME", visible: true, x: 2000, y: 0, width: 100, height: 100 };
    page.appendChild(first);
    keepClearOnCanvas(first, { placeGroup: "w2" }, ctx());
    old.x = 5000; // another op of the same call moved it
    const next: any = { id: "9:2", name: "Next", type: "FRAME", visible: true, x: 0, y: 0, width: 400, height: 300 };
    page.appendChild(next);
    keepClearOnCanvas(next, { placeGroup: "w2" }, ctx());
    expect(next.y).toBe(0);
  });
});

describe("readFlowMarks", () => {
  it("asks the native search for marked frames instead of reading every layer", () => {
    const flow: any = { id: "5:1", name: "Flow", type: "FRAME", getPluginData: (k: string) => (k === FLOW_MARKER ? JSON.stringify({ title: "Checkout", screens: { a: "1.1" } }) : "") };
    const nested: any = { id: "5:2", name: "Inner", type: "FRAME", getPluginData: (k: string) => (k === FLOW_MARKER ? "{}" : "") };
    const holder: any = { id: "5:3", type: "FRAME", children: [nested] };
    nested.parent = holder;
    const page: any = {
      id: "0:1",
      type: "PAGE",
      get children(): any[] {
        throw new Error("walked every layer");
      },
      findAllWithCriteria: vi.fn(() => [flow, nested]),
    };
    flow.parent = page;
    holder.parent = page;
    const marks = readFlowMarks(page);
    expect(marks.map((m) => m.title)).toEqual(["Checkout"]);
    expect(page.findAllWithCriteria).toHaveBeenCalledWith({ pluginData: { keys: [FLOW_MARKER, "figma-plugin.flowchart"] } });
  });

  it("still finds a flow inside a SECTION", () => {
    const page: any = { id: "0:1", type: "PAGE" };
    const section: any = { id: "6:1", type: "SECTION", parent: page };
    const flow: any = { id: "5:1", name: "Flow", type: "FRAME", parent: section, getPluginData: (k: string) => (k === FLOW_MARKER ? "{}" : "") };
    page.findAllWithCriteria = () => [flow];
    expect(readFlowMarks(page).map((m) => m.frameId)).toEqual(["5:1"]);
  });
});

describe("getNodeByIdSafe after a stall", () => {
  afterEach(() => vi.useRealTimers());

  it("a slow-but-healthy first lookup still wins while the page load is in flight", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const node = { id: "1:2", type: "FRAME" };
    let release!: (v: unknown) => void;
    const slow = new Promise((r) => (release = r));
    const loadAll = vi.fn(() => new Promise(() => {})); // a whole-document load that takes ages
    (globalThis as any).figma = { getNodeByIdAsync: vi.fn(() => slow), loadAllPagesAsync: loadAll };
    const { getNodeByIdSafe } = await import("../../src/plugin/context.js");

    const pending = getNodeByIdSafe("1:2");
    await vi.advanceTimersByTimeAsync(2600);
    expect(loadAll).toHaveBeenCalledTimes(1);
    release(node);
    await expect(pending).resolves.toBe(node);
  });

  it("when the first lookup fails late, the retry's answer is used", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const node = { id: "1:2", type: "FRAME" };
    let rejectFirst!: (e: unknown) => void;
    const first = new Promise((_, rej) => (rejectFirst = rej));
    let call = 0;
    (globalThis as any).figma = {
      getNodeByIdAsync: vi.fn(() => (++call === 1 ? first : Promise.resolve(node))),
      loadAllPagesAsync: vi.fn(async () => {}),
    };
    const { getNodeByIdSafe } = await import("../../src/plugin/context.js");
    const pending = getNodeByIdSafe("1:2");
    await vi.advanceTimersByTimeAsync(2600);
    rejectFirst(new Error("Unable to establish connection to Figma after 10 seconds"));
    await expect(pending).resolves.toBe(node);
  });
});
