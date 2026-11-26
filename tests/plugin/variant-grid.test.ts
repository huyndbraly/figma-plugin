import { describe, expect, it } from "vitest";
import {
  layoutVariantGrid,
  parseVariantName,
  variantMatches,
  variantName,
} from "../../src/plugin/variant-grid.js";

describe("variant names", () => {
  it("round-trips Figma's Prop=value, Prop=value format", () => {
    const name = variantName({ Size: "sm", State: "default" });
    expect(name).toBe("Size=sm, State=default");
    expect(parseVariantName(name)).toEqual({ Size: "sm", State: "default" });
  });

  it("stringifies numbers and booleans", () => {
    expect(variantName({ Level: 2, Disabled: true })).toBe("Level=2, Disabled=true");
  });

  it("refuses values that would break the format", () => {
    expect(() => variantName({ Size: "a=b" })).toThrow(/may not contain/);
    expect(() => variantName({ Size: "a, b" })).toThrow(/may not contain/);
    expect(() => variantName({})).toThrow(/at least one property/);
    expect(() => variantName({ Size: " " })).toThrow(/non-empty value/);
  });

  it("matches a request case-insensitively and fails on a missing key", () => {
    const v = { Size: "Large", State: "Hover" };
    expect(variantMatches(v, { size: "large" })).toBe(true);
    expect(variantMatches(v, { Size: "Large", State: "hover" })).toBe(true);
    expect(variantMatches(v, { Tone: "primary" })).toBe(false);
    expect(variantMatches(v, { Size: "small" })).toBe(false);
  });
});

describe("layoutVariantGrid", () => {
  const item = (id: string, props: Record<string, string>, w = 100, h = 40) => ({ id, w, h, props });

  it("puts rows by the first property and columns by the rest, in value order", () => {
    const items = [
      item("a", { Size: "lg", State: "hover" }),
      item("b", { Size: "sm", State: "default" }),
      item("c", { Size: "sm", State: "hover" }),
      item("d", { Size: "lg", State: "default" }),
    ];
    const g = layoutVariantGrid(items, {
      gap: 10,
      padding: 20,
      valueOrder: { Size: ["sm", "lg"], State: ["default", "hover"] },
    });
    const at = Object.fromEntries(g.positions.map((p) => [p.id, [p.x, p.y]]));
    expect(at.b).toEqual([20, 20]); // sm / default
    expect(at.c).toEqual([130, 20]); // sm / hover
    expect(at.d).toEqual([20, 70]); // lg / default
    expect(at.a).toEqual([130, 70]); // lg / hover
    expect(g.width).toBe(20 + 100 + 10 + 100 + 20);
    expect(g.height).toBe(20 + 40 + 10 + 40 + 20);
    expect(g.rowsBy).toBe("Size");
  });

  it("sizes each column to its widest cell and each row to its tallest", () => {
    const g = layoutVariantGrid(
      [item("a", { Size: "sm", Tone: "x" }, 50, 30), item("b", { Size: "lg", Tone: "x" }, 200, 60), item("c", { Size: "sm", Tone: "y" }, 80, 30)],
      { gap: 0, padding: 0 },
    );
    const at = Object.fromEntries(g.positions.map((p) => [p.id, [p.x, p.y]]));
    expect(at.c![0]).toBe(200); // column x pushed past the widest cell in column "x"
    expect(at.b![1]).toBe(30);
    expect(g.width).toBe(280);
    expect(g.height).toBe(90);
  });

  it("honours rowsBy / columnsBy", () => {
    const g = layoutVariantGrid(
      [item("a", { Size: "sm", State: "a" }), item("b", { Size: "lg", State: "a" })],
      { rowsBy: "State", columnsBy: "Size", gap: 0, padding: 0 },
    );
    expect(g.rowsBy).toBe("State");
    const ys = new Set(g.positions.map((p) => p.y));
    expect(ys.size).toBe(1); // one row: both share State=a
  });

  it("never stacks two variants in one cell", () => {
    const g = layoutVariantGrid([item("a", { Size: "sm" }), item("b", { Size: "sm" })], { gap: 0, padding: 0 });
    const spots = new Set(g.positions.map((p) => `${p.x},${p.y}`));
    expect(spots.size).toBe(2);
  });
});
