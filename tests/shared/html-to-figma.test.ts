import { describe, expect, it } from "vitest";
import { cssColor, domToFigma, fontFamily, fontStyle, pruneToBudget, type CapturedNode } from "../../src/shared/html-to-figma.js";

/**
 * Captured DOM → create() spec. The point is an EDITABLE design: a flex row
 * must come back as horizontal auto-layout with the browser's gap and
 * padding, not as absolutely placed boxes that merely look the same.
 */

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const text = (t: string, r: CapturedNode["rect"], style: CapturedNode["style"] = {}): CapturedNode => ({ tag: "#text", text: t, rect: r, style: { fontSize: "14px", fontWeight: "400", fontFamily: "Inter, sans-serif", color: "rgb(17, 24, 39)", ...style } });

describe("css helpers", () => {
  it("colours: rgb/rgba/hex, transparent is no fill", () => {
    expect(cssColor("rgb(255, 0, 16)")).toEqual({ hex: "#ff0010", alpha: 1 });
    expect(cssColor("rgba(0, 0, 0, 0.5)")).toEqual({ hex: "#000000", alpha: 0.5 });
    expect(cssColor("rgb(0 0 0 / 25%)")).toEqual({ hex: "#000000", alpha: 0.25 });
    expect(cssColor("#abc")).toEqual({ hex: "#aabbcc", alpha: 1 });
    expect(cssColor("rgba(0, 0, 0, 0)")).toBeNull();
    expect(cssColor("transparent")).toBeNull();
  });

  it("fonts: first real family, weight → Figma style", () => {
    expect(fontFamily('"Be Vietnam Pro", system-ui, sans-serif')).toBe("Be Vietnam Pro");
    expect(fontFamily("system-ui, -apple-system, sans-serif")).toBe("Inter");
    expect(fontStyle("700")).toBe("Bold");
    expect(fontStyle("600")).toBe("Semi Bold");
    expect(fontStyle("400", "italic")).toBe("Italic");
  });
});

describe("domToFigma", () => {
  const PAGE: CapturedNode = {
    tag: "body",
    rect: box(0, 0, 400, 300),
    style: { display: "block", backgroundColor: "rgb(255, 255, 255)" },
    children: [
      {
        tag: "nav",
        className: "toolbar primary",
        rect: box(0, 0, 400, 56),
        style: { display: "flex", flexDirection: "row", columnGap: "12px", paddingTop: "8px", paddingRight: "16px", paddingBottom: "8px", paddingLeft: "16px", justifyContent: "space-between", alignItems: "center", backgroundColor: "rgb(37, 99, 235)", borderTopLeftRadius: "8px" },
        children: [
          text("Home", box(16, 18, 40, 20), { color: "rgb(255, 255, 255)", fontWeight: "600" }),
          { tag: "img", src: "/static/avatar.png?v=2", alt: "", rect: box(352, 12, 32, 32), style: { borderTopLeftRadius: "16px" } },
        ],
      },
      { tag: "p", rect: box(16, 72, 368, 20), style: { display: "block" }, children: [text("Hello", box(16, 72, 40, 20))] },
      { tag: "p", rect: box(16, 104, 368, 20), style: { display: "block" }, children: [text("World", box(16, 104, 40, 20))] },
      { tag: "div", rect: box(0, 0, 0, 0), style: {} },
    ],
  };

  it("a flex row is horizontal auto-layout with the computed gap, padding and alignment", () => {
    const { spec } = domToFigma(PAGE, { name: "Settings" });
    expect(spec).toMatchObject({ type: "FRAME", name: "Settings", w: 400, h: 300, fill: "#ffffff", layoutMode: "VERTICAL" });
    const nav = (spec.children as any[])[0];
    expect(nav).toMatchObject({
      type: "FRAME",
      name: "nav.toolbar",
      layoutMode: "HORIZONTAL",
      itemSpacing: 12,
      padding: { top: 8, right: 16, bottom: 8, left: 16 },
      primaryAxisAlignItems: "SPACE_BETWEEN",
      counterAxisAlignItems: "CENTER",
      fill: "#2563eb",
      cornerRadius: 8,
    });
    // Children of auto-layout carry no x/y — auto-layout places them.
    expect(nav.children[0]).not.toHaveProperty("x");
    expect(nav.children[0]).toMatchObject({ type: "TEXT", characters: "Home", fill: "#ffffff", fontName: { family: "Inter", style: "Semi Bold" }, fontSize: 14 });
    expect(nav.children[1]).toMatchObject({ type: "RECTANGLE", name: "img: avatar.png", cornerRadius: 16 });
  });

  it("block children that stack become vertical auto-layout with the real spacing; zero-size boxes are dropped", () => {
    const { spec } = domToFigma(PAGE);
    const kids = spec.children as any[];
    expect(kids).toHaveLength(3);
    expect(spec.itemSpacing).toBe(12); // gaps 16 and 12: the lower median, the tighter rhythm
  });

  it("side-by-side blocks keep absolute, parent-relative positions", () => {
    const { spec } = domToFigma({
      tag: "div",
      rect: box(100, 100, 300, 100),
      style: { display: "block" },
      children: [
        { tag: "div", rect: box(110, 120, 50, 50), style: { backgroundColor: "rgb(0, 0, 0)" } },
        { tag: "div", rect: box(200, 110, 50, 50), style: { backgroundColor: "rgb(0, 0, 0)" } },
      ],
    });
    expect(spec.layoutMode).toBeUndefined();
    expect((spec.children as any[]).map((c) => [c.x, c.y])).toEqual([[10, 20], [100, 10]]);
  });

  it("prunes the smallest leaves first to stay within maxNodes", () => {
    const big: CapturedNode = { tag: "div", rect: box(0, 0, 1000, 1000), style: {}, children: Array.from({ length: 50 }, (_, i) => ({ tag: "span", rect: box(0, i * 10, 10 + i, 10), style: {} })) };
    const { root, dropped } = pruneToBudget(big, 11);
    expect(dropped).toBe(40);
    expect(root.children!.map((c) => c.rect.w)).toEqual(Array.from({ length: 10 }, (_, i) => 50 + i));
    expect(big.children).toHaveLength(50); // input untouched
  });
});
