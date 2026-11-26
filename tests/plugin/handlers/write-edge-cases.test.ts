import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteNode, modify } from "../../../src/plugin/handlers/write.js";
import { setSelectionColors } from "../../../src/plugin/handlers/paint-edit.js";
import { deleteStyle } from "../../../src/plugin/handlers/cleanup.js";
import { makeContext } from "../../../src/plugin/context.js";
import { HandlerError } from "../../../src/plugin/errors.js";
import { ErrorCode } from "../../../src/shared/protocol.js";

/**
 * Four writes that did something other than what was asked:
 *  - deleting a component SET in use went through without force (a set has
 *    no getInstancesAsync, so its instances counted as zero);
 *  - modify({fontStyle:"Bold"}) on Roboto Regular produced Inter Bold;
 *  - set_selection_colors skipped every text coloured in several runs;
 *  - delete_style with replaceWith failed on an empty text layer.
 */

const MIXED = Symbol("mixed");
const ctx = (params: Record<string, unknown>) => makeContext(params, () => {});
let nodes: Record<string, any>;

beforeEach(() => {
  nodes = {};
  (globalThis as any).figma = {
    mixed: MIXED,
    getNodeByIdAsync: vi.fn(async (id: string) => nodes[id] ?? null),
    loadFontAsync: vi.fn(async () => {}),
    listAvailableFontsAsync: vi.fn(async () =>
      [
        ["Inter", "Regular"],
        ["Inter", "Bold"],
        ["Roboto", "Regular"],
        ["Roboto", "Bold"],
        ["Roboto", "Italic"],
      ].map(([family, style]) => ({ fontName: { family, style } })),
    ),
    currentPage: { id: "0:1", type: "PAGE", selection: [], children: [] },
  };
});

describe("delete on a COMPONENT_SET", () => {
  function setWith(instancesPerVariant: number[]): any {
    const set: any = { id: "1:1", name: "Button", type: "COMPONENT_SET", remote: false, children: [], parent: { type: "PAGE" } };
    set.children = instancesPerVariant.map((n, i) => ({
      id: `2:${i}`,
      type: "COMPONENT",
      parent: set,
      getInstancesAsync: vi.fn(async () => Array.from({ length: n }, () => ({}))),
    }));
    set.remove = vi.fn(() => {
      set.removed = true;
    });
    nodes["1:1"] = set;
    return set;
  }

  it("counts the instances of every variant and refuses without force", async () => {
    const set = setWith([0, 3, 2]);
    const e = (await deleteNode(ctx({ nodeId: "1:1" })).catch((x) => x)) as HandlerError;
    expect(e).toBeInstanceOf(HandlerError);
    expect(e.code).toBe(ErrorCode.COMPONENT_IN_USE);
    expect(e.message).toContain("5 instance");
    expect(set.remove).not.toHaveBeenCalled();
  });

  it("an unused set is deleted, and force deletes a used one", async () => {
    setWith([0, 0]);
    expect(((await deleteNode(ctx({ nodeId: "1:1" }))) as any).deleted).toBe(true);
    setWith([1]);
    expect(((await deleteNode(ctx({ nodeId: "1:1", force: true }))) as any).instancesLeft).toBe(1);
  });
});

describe("modify with only half a font", () => {
  function textNode(fontName: unknown): any {
    return {
      id: "3:1",
      type: "TEXT",
      name: "Label",
      characters: "Hello world",
      fontName,
      setRangeFontName: vi.fn(),
      getRangeAllFontNames: () => [],
      getStyledTextSegments: vi.fn(() => [
        { start: 0, end: 5, fontName: { family: "Inter", style: "Regular" } },
        { start: 5, end: 11, fontName: { family: "Roboto", style: "Italic" } },
      ]),
    };
  }

  it("fontStyle keeps the family the text already has", async () => {
    nodes["3:1"] = textNode({ family: "Roboto", style: "Regular" });
    await modify(ctx({ nodeId: "3:1", props: { fontStyle: "Bold" } }));
    expect(nodes["3:1"].fontName).toEqual({ family: "Roboto", style: "Bold" });
  });

  it("fontFamily keeps the style the text already has", async () => {
    nodes["3:1"] = textNode({ family: "Roboto", style: "Bold" });
    await modify(ctx({ nodeId: "3:1", props: { fontFamily: "Inter" } }));
    expect(nodes["3:1"].fontName).toEqual({ family: "Inter", style: "Bold" });
  });

  it("on mixed text, each run keeps its own other half", async () => {
    const t = textNode(MIXED);
    nodes["3:1"] = t;
    await modify(ctx({ nodeId: "3:1", props: { fontStyle: "Bold" } }));
    expect(t.setRangeFontName).toHaveBeenCalledWith(0, 5, { family: "Inter", style: "Bold" });
    expect(t.setRangeFontName).toHaveBeenCalledWith(5, 11, { family: "Roboto", style: "Bold" });
    expect(t.fontName).toBe(MIXED);
  });
});

describe("set_selection_colors on a multi-colour text", () => {
  it("recolours the matching runs", async () => {
    const red = { type: "SOLID", color: { r: 1, g: 0, b: 0 } };
    const blue = { type: "SOLID", color: { r: 0, g: 0, b: 1 } };
    const t: any = {
      id: "4:1",
      type: "TEXT",
      fills: MIXED,
      strokes: [],
      getStyledTextSegments: vi.fn(() => [
        { start: 0, end: 3, fills: [red] },
        { start: 3, end: 8, fills: [blue] },
      ]),
      setRangeFills: vi.fn(),
    };
    nodes["4:1"] = t;
    const out = (await setSelectionColors(ctx({ nodeId: "4:1", from: "#ff0000", to: "#00ff00" }))) as any;
    expect(out.changed).toBe(1);
    expect(t.setRangeFills).toHaveBeenCalledTimes(1);
    expect(t.setRangeFills).toHaveBeenCalledWith(0, 3, [{ type: "SOLID", color: { r: 0, g: 1, b: 0 } }]);
  });
});

describe("delete_style rebinding an empty text layer", () => {
  it("moves it to the new style instead of failing on its empty range", async () => {
    const old: any = { id: "S:old", name: "Old", type: "TEXT", remote: false, fontName: { family: "Inter", style: "Regular" }, remove: vi.fn() };
    const next: any = { id: "S:new", name: "New", type: "TEXT", remote: false, fontName: { family: "Inter", style: "Bold" } };
    const empty: any = {
      id: "5:1",
      type: "TEXT",
      characters: "",
      fontName: { family: "Inter", style: "Regular" },
      textStyleId: old.id,
      fillStyleId: "",
      getRangeAllFontNames: vi.fn((s: number, e: number) => {
        if (e <= s) throw new Error("Range outside of available characters");
        return [];
      }),
      setTextStyleIdAsync: vi.fn(async () => {}),
    };
    const page: any = { id: "0:1", type: "PAGE", name: "P", children: [empty], loadAsync: vi.fn(async () => {}) };
    Object.assign((globalThis as any).figma, {
      root: { children: [page] },
      currentPage: page,
      loadAllPagesAsync: vi.fn(async () => {}),
      commitUndo: vi.fn(),
      getLocalPaintStylesAsync: async () => [],
      getLocalTextStylesAsync: async () => [old, next],
      getLocalEffectStylesAsync: async () => [],
      getLocalGridStylesAsync: async () => [],
      getStyleByIdAsync: async () => null,
    });
    const out = (await deleteStyle(ctx({ style: "Old", replaceWith: "New" }))) as any;
    expect(out.rebound).toBe(1);
    expect(empty.setTextStyleIdAsync).toHaveBeenCalledWith("S:new");
    expect(old.remove).toHaveBeenCalled();
  });
});
