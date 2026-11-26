import { describe, expect, it } from "vitest";
import {
  hex,
  isDefaultLayerName,
  isGenericControlName,
  looksLikeControl,
  matchColor,
  matchNumber,
  matchTextStyle,
  numberTokensFor,
  resolveViewports,
} from "../../src/plugin/quality-util.js";

describe("what counts as a control", () => {
  it("recognises control words in any path segment, not inside other words", () => {
    expect(looksLikeControl("Button/Primary/Large")).toBe(true);
    expect(looksLikeControl("P/Nav/TabBar")).toBe(false); // camel-cased "TabBar" is one word
    expect(looksLikeControl("Tab bar item")).toBe(true);
    expect(looksLikeControl("icon-button")).toBe(true);
    expect(looksLikeControl("Hero illustration")).toBe(false);
    expect(looksLikeControl("Buttonhole texture")).toBe(false);
  });

  it("tells default and generic names from real ones", () => {
    expect(isDefaultLayerName("Frame 12")).toBe(true);
    expect(isDefaultLayerName("Rectangle")).toBe(true);
    expect(isDefaultLayerName("Close")).toBe(false);
    expect(isGenericControlName("Icon button")).toBe(true);
    expect(isGenericControlName("Button/Primary/Icon button 2")).toBe(true);
    expect(isGenericControlName("Share")).toBe(false);
  });
});

describe("matching literal values to tokens", () => {
  const tokens = [
    { id: "v1", name: "color/primary", color: { r: 37 / 255, g: 99 / 255, b: 235 / 255 }, alpha: 1 },
    { id: "v2", name: "color/primary/legacy", color: { r: 37 / 255, g: 99 / 255, b: 235 / 255 }, alpha: 1 },
    { id: "v3", name: "color/overlay", color: { r: 0, g: 0, b: 0 }, alpha: 0.5 },
  ];

  it("finds exact matches (shortest name wins) and near ones, never across alpha", () => {
    expect(matchColor({ r: 37 / 255, g: 99 / 255, b: 235 / 255 }, 1, tokens).exact?.token.name).toBe("color/primary");
    expect(matchColor({ r: 38 / 255, g: 100 / 255, b: 236 / 255 }, 1, tokens).near?.token.name).toBe("color/primary");
    expect(matchColor({ r: 0, g: 0, b: 0 }, 1, tokens)).toEqual({});
    expect(matchColor({ r: 0, g: 0, b: 0 }, 0.5, tokens).exact?.token.id).toBe("v3");
    expect(hex({ r: 37 / 255, g: 99 / 255, b: 235 / 255 })).toBe("#2563eb");
  });

  it("matches a text style only on family, style and size together", () => {
    const styles = [
      { id: "s1", name: "body", family: "Inter", style: "Regular", size: 14 },
      { id: "s2", name: "body/strong", family: "Inter", style: "Semi Bold", size: 14 },
    ];
    expect(matchTextStyle("inter", "regular", 14, styles)?.id).toBe("s1");
    expect(matchTextStyle("Inter", "Regular", 15, styles)).toBeUndefined();
  });

  it("keeps radius and spacing tokens apart by scope or name", () => {
    const nums = [
      { id: "r8", name: "radius/md", value: 8, scopes: [] },
      { id: "s8", name: "space/2", value: 8, scopes: [] },
      { id: "g8", name: "unnamed", value: 8, scopes: ["GAP"] },
      { id: "o8", name: "opacity/8", value: 8, scopes: ["OPACITY"] },
    ];
    expect(numberTokensFor("radius", nums).map((t) => t.id)).toEqual(["r8"]);
    expect(numberTokensFor("spacing", nums).map((t) => t.id).sort()).toEqual(["g8", "s8"]);
    expect(matchNumber(8, numberTokensFor("radius", nums))?.id).toBe("r8");
    expect(matchNumber(6, numberTokensFor("radius", nums))).toBeUndefined();
  });
});

describe("viewports", () => {
  it("prefers explicit sizes, then presets, then a default spread by width", () => {
    expect(resolveViewports(400, [375, { width: 834, height: 1194, name: "iPad" }]).viewports.map((v) => v.width)).toEqual([375, 834]);
    const p = resolveViewports(400, undefined, ["ipad", "nope"]);
    expect(p.viewports.map((v) => v.name)).toEqual(["iPad portrait"]);
    expect(p.unknown).toEqual(["nope"]);
    expect(resolveViewports(402).viewports.some((v) => v.width > 800)).toBe(true);
    expect(resolveViewports(1440).viewports.some((v) => v.width < 500)).toBe(true);
  });
});
