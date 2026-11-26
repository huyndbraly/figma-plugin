import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyTextStyleToNode, resolveTextStyle, setupTextStyles } from "../../../src/plugin/handlers/styles.js";
import { setText } from "../../../src/plugin/handlers/text.js";
import { preloadDiagramFonts } from "../../../src/plugin/diagram-apply.js";
import { makeContext } from "../../../src/plugin/context.js";

/**
 * Per-text-node costs of fonts and text styles. A screen of eighty labels
 * fetched the whole text-style list eighty times, loaded the style's font
 * eighty times, scanned the installed-font list per label, and replacing a
 * mixed-font text asked the editor for each character's font in turn.
 */

const MIXED = Symbol("mixed");
const ctx = (params: Record<string, unknown>) => makeContext(params, () => {});

let styles: any[];
beforeEach(() => {
  styles = [{ id: "S:1", name: "Body", fontName: { family: "Inter", style: "Regular" }, fontSize: 16 }];
  (globalThis as any).figma = {
    mixed: MIXED,
    getLocalTextStylesAsync: vi.fn(async () => styles),
    createTextStyle: vi.fn(() => {
      const s: any = { id: `S:${styles.length + 1}`, name: "", fontName: { family: "Inter", style: "Regular" } };
      styles.push(s);
      return s;
    }),
    listAvailableFontsAsync: vi.fn(async () =>
      ["Regular", "Bold"].map((style) => ({ fontName: { family: "Inter", style } })),
    ),
    loadFontAsync: vi.fn(async () => {}),
    getNodeByIdAsync: vi.fn(async () => null),
  };
});

describe("text styles", () => {
  it("are listed once per request, not once per text node", async () => {
    for (let i = 0; i < 20; i++) expect((await resolveTextStyle("Body")).id).toBe("S:1");
    expect((globalThis as any).figma.getLocalTextStylesAsync).toHaveBeenCalledTimes(1);
  });

  it("a style set up by setup_text_styles is found straight after", async () => {
    await resolveTextStyle("Body");
    await setupTextStyles(ctx({ styles: [{ name: "Title", family: "Inter", style: "Bold", fontSize: 32 }] }));
    expect((await resolveTextStyle("Title")).name).toBe("Title");
  });

  it("applying one style to many nodes loads its font once", async () => {
    const style = await resolveTextStyle("Body");
    for (let i = 0; i < 10; i++) {
      await applyTextStyleToNode({ setTextStyleIdAsync: vi.fn(async () => {}) } as any, style);
    }
    expect((globalThis as any).figma.loadFontAsync).toHaveBeenCalledTimes(1);
  });
});

describe("diagram fonts", () => {
  it("are loaded once per face, however many diagrams are drawn", async () => {
    const warn = vi.fn();
    await preloadDiagramFonts({ warn }, "Inter");
    await preloadDiagramFonts({ warn }, "Inter");
    expect((globalThis as any).figma.loadFontAsync).toHaveBeenCalledTimes(4);
  });
});

describe("set_text on a mixed-font text", () => {
  it("reads the font runs in one call, not one call per character", async () => {
    const chars = "Bold start, then regular text that goes on for a while";
    const node: any = {
      id: "1:1",
      type: "TEXT",
      characters: chars,
      fontName: MIXED,
      textAutoResize: "HEIGHT",
      getRangeFontName: vi.fn(() => {
        throw new Error("asked per character");
      }),
      getStyledTextSegments: vi.fn(() => [
        { start: 0, end: 10, fontName: { family: "Inter", style: "Bold" } },
        { start: 10, end: chars.length, fontName: { family: "Inter", style: "Regular" } },
      ]),
      setRangeFontName: vi.fn(),
    };
    (globalThis as any).figma.getNodeByIdAsync = vi.fn(async () => node);
    await setText(ctx({ nodeId: "1:1", characters: "Replaced" }));
    expect(node.getStyledTextSegments).toHaveBeenCalledWith(["fontName"]);
    expect(node.characters).toBe("Replaced");
    const loaded = (globalThis as any).figma.loadFontAsync.mock.calls.map((c: any[]) => c[0].style);
    expect(new Set(loaded)).toEqual(new Set(["Bold", "Regular"]));
  });
});

describe("exact-case font lookup", () => {
  it("builds its index once and still returns the installed spelling", async () => {
    vi.resetModules();
    const fonts = await import("../../../src/plugin/fonts.js");
    (globalThis as any).figma.listAvailableFontsAsync = vi.fn(async () =>
      Array.from({ length: 2000 }, (_, i) => ({ fontName: { family: `Family ${i}`, style: "Regular" } })).concat([
        { fontName: { family: "Brand Sans", style: "Bold" } },
      ]),
    );
    for (let i = 0; i < 5; i++) {
      const res = await fonts.loadFontWithFallback({ family: "brand sans", style: "Bold" });
      expect(res.resolvedFont).toEqual({ family: "Brand Sans", style: "Bold" });
    }
    expect((globalThis as any).figma.listAvailableFontsAsync).toHaveBeenCalledTimes(1);
  });
});
