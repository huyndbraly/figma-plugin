import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeContext } from "../../../src/plugin/context.js";
import { a11yAudit, applyDesignSystem, auditDesignSystem, responsiveAudit } from "../../../src/plugin/handlers/quality.js";

const ctx = (params: Record<string, unknown>) => makeContext(params, () => {});

let seq = 0;
let nodes: Map<string, any>;
let page: any;

const rgb = (hex: string) => ({ r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255 });
const solid = (hex: string, extra: Record<string, unknown> = {}) => [{ type: "SOLID", color: rgb(hex), visible: true, opacity: 1, ...extra }];

function node(type: string, name: string, extra: Record<string, unknown> = {}): any {
  const n: any = {
    id: `${++seq}:1`,
    type,
    name,
    visible: true,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    parent: null,
    ...(type === "TEXT" ? {} : { children: [] }),
    fills: [],
    strokes: [],
    boundVariables: {},
    setBoundVariable: vi.fn(function (this: any, field: string, v: any) {
      this.boundVariables[field] = { id: v.id };
    }),
    absoluteBoundingBox: null,
    resize(w: number, h: number) {
      this.width = w;
      this.height = h;
    },
    ...extra,
  };
  if (n.children) {
    n.appendChild = (c: any) => {
      n.children.push(c);
      c.parent = n;
    };
    n.findAll = (fn: (k: any) => boolean) => {
      const out: any[] = [];
      const walk = (x: any) => {
        for (const k of x.children ?? []) {
          if (fn(k)) out.push(k);
          walk(k);
        }
      };
      walk(n);
      return out;
    };
    n.findOne = (fn: (k: any) => boolean) => n.findAll(fn)[0] ?? null;
  }
  nodes.set(n.id, n);
  return n;
}

function textNode(chars: string, fill: string, extra: Record<string, unknown> = {}): any {
  return node("TEXT", chars, {
    characters: chars,
    fontSize: 14,
    fontName: { family: "Inter", style: "Regular" },
    fills: solid(fill),
    textStyleId: "",
    setTextStyleIdAsync: vi.fn(async function (this: any, id: string) {
      this.textStyleId = id;
    }),
    ...extra,
  });
}

beforeEach(() => {
  seq = 0;
  nodes = new Map();
  page = node("PAGE", "Page");
  (globalThis as any).figma = {
    currentPage: page,
    root: { children: [page] },
    mixed: Symbol("mixed"),
    getNodeByIdAsync: vi.fn(async (id: string) => nodes.get(id) ?? null),
    variables: {
      getLocalVariablesAsync: vi.fn(async () => VARS),
      getVariableCollectionByIdAsync: vi.fn(async () => ({ defaultModeId: "m1" })),
      getVariableByIdAsync: vi.fn(async (id: string) => VARS.find((v: any) => v.id === id) ?? null),
      setBoundVariableForPaint: vi.fn((paint: any, _f: string, v: any) => ({ ...paint, boundVariables: { color: { id: v.id } } })),
    },
    getLocalTextStylesAsync: vi.fn(async () => [{ id: "S:body", name: "body", fontName: { family: "Inter", style: "Regular" }, fontSize: 14 }]),
  };
});

const VARS: any[] = [
  { id: "V:primary", name: "color/primary", resolvedType: "COLOR", variableCollectionId: "c", valuesByMode: { m1: { ...rgb("#2563eb"), a: 1 } }, scopes: [] },
  { id: "V:surface", name: "color/surface", resolvedType: "COLOR", variableCollectionId: "c", valuesByMode: { m1: { type: "VARIABLE_ALIAS", id: "V:white" } }, scopes: [] },
  { id: "V:white", name: "base/white", resolvedType: "COLOR", variableCollectionId: "c", valuesByMode: { m1: { r: 1, g: 1, b: 1, a: 1 } }, scopes: [] },
  { id: "V:r8", name: "radius/md", resolvedType: "FLOAT", variableCollectionId: "c", valuesByMode: { m1: 8 }, scopes: [] },
  { id: "V:s16", name: "space/4", resolvedType: "FLOAT", variableCollectionId: "c", valuesByMode: { m1: 16 }, scopes: [] },
];

describe("a11y_audit", () => {
  it("finds low contrast, a small tap target, small text and an unnamed control", async () => {
    const screen = node("FRAME", "Screen", { fills: solid("#ffffff") });
    page.appendChild(screen);
    screen.appendChild(textNode("Faint", "#cccccc"));
    screen.appendChild(textNode("Tiny", "#111111", { fontSize: 9 }));
    const btn = node("FRAME", "Button", { width: 32, height: 32 });
    screen.appendChild(btn);
    const icon = node("VECTOR", "Vector");
    btn.appendChild(icon);
    const tapped = node("FRAME", "Frame 7", { width: 48, height: 48, reactions: [{ trigger: { type: "ON_CLICK" } }] });
    screen.appendChild(tapped);
    const ok = node("INSTANCE", "Primary button", { width: 200, height: 48 });
    ok.appendChild(textNode("Save", "#ffffff"));
    ok.fills = solid("#2563eb");
    screen.appendChild(ok);

    const res = (await a11yAudit(ctx({ nodeId: screen.id }))) as any;
    const kinds = res.findings.map((f: any) => `${f.kind}:${f.name}`);
    expect(kinds).toContain("contrast:Faint");
    expect(kinds).toContain("font-size:Tiny");
    expect(kinds).toContain("touch-target:Button");
    expect(kinds).toContain("unnamed-control:Button"); // icon-only, generic name
    expect(kinds).toContain("unnamed-control:Frame 7"); // has a reaction, default name
    expect(kinds.some((k: string) => k.endsWith(":Primary button"))).toBe(false);
    expect(kinds.some((k: string) => k.endsWith(":Save"))).toBe(false); // white on blue passes
    expect(res.summary.errors).toBeGreaterThanOrEqual(2);
  });
});

describe("design-system audit and apply", () => {
  function screenWithLiterals() {
    const screen = node("FRAME", "Screen", { fills: solid("#ffffff"), layoutMode: "VERTICAL", paddingLeft: 16, paddingRight: 16, paddingTop: 0, paddingBottom: 0, itemSpacing: 12, primaryAxisAlignItems: "MIN", cornerRadius: 8 });
    page.appendChild(screen);
    const card = node("RECTANGLE", "Card", { fills: [...solid("#2563eb"), ...solid("#123456")], cornerRadius: 8 });
    screen.appendChild(card);
    const bound = node("RECTANGLE", "Bound", { fills: solid("#2563eb", { boundVariables: { color: { id: "V:primary" } } }) });
    screen.appendChild(bound);
    const label = textNode("Hello", "#2563eb");
    screen.appendChild(label);
    const inst = node("INSTANCE", "Chip", { fills: solid("#999999") });
    inst.appendChild(node("RECTANGLE", "inner", { fills: solid("#777777") }));
    screen.appendChild(inst);
    return { screen, card, label, inst };
  }

  it("sorts every value into bound / bindable / off-system", async () => {
    const { screen } = screenWithLiterals();
    const res = (await auditDesignSystem(ctx({ nodeId: screen.id }))) as any;
    expect(res.byKind.color).toMatchObject({ bound: 1, bindable: 3, off: 2 }); // white (alias) + blue ×2 bindable; #123456, #999999 off
    expect(res.byKind.text).toMatchObject({ bindable: 1 });
    expect(res.byKind.radius).toMatchObject({ bindable: 2 });
    expect(res.byKind.spacing).toMatchObject({ bindable: 2, off: 1 }); // padding 16 ×2; itemSpacing 12 has no token
    expect(res.topOffPalette.map((c: any) => c.value)).toContain("#123456");
    // Instance internals are the main component's business.
    expect(res.findings.some((f: any) => f.name === "inner")).toBe(false);
  });

  it("dry-runs, then binds exactly the matches — per paint, leaving other paints alone", async () => {
    const { screen, card, label } = screenWithLiterals();
    const dry = (await applyDesignSystem(ctx({ nodeId: screen.id, dryRun: true }))) as any;
    expect(dry.planned).toBe(8);
    expect(card.fills[0].boundVariables).toBeUndefined();

    const res = (await applyDesignSystem(ctx({ nodeId: screen.id }))) as any;
    expect(res.applied).toMatchObject({ color: 3, text: 1, radius: 2, spacing: 2 });
    expect(card.fills[0].boundVariables.color.id).toBe("V:primary");
    expect(card.fills[1].boundVariables).toBeUndefined();
    expect(label.textStyleId).toBe("S:body");
    expect(screen.boundVariables.paddingLeft.id).toBe("V:s16");
    expect(card.boundVariables.topLeftRadius.id).toBe("V:r8");
  });
});

describe("responsive_audit", () => {
  it("audits a resized copy per viewport and removes the copies", async () => {
    const screen = node("FRAME", "Home", { width: 402, height: 874, layoutMode: "VERTICAL", primaryAxisSizingMode: "FIXED", counterAxisSizingMode: "FIXED" });
    page.appendChild(screen);
    const wide = node("FRAME", "Banner", { width: 380, height: 120, layoutSizingHorizontal: "FIXED" });
    screen.appendChild(wide);
    const clones: any[] = [];
    screen.clone = function () {
      const copy = node("FRAME", this.name, { width: this.width, height: this.height, layoutMode: this.layoutMode });
      page.appendChild(copy);
      const kid = node("FRAME", "Banner", { width: 380, height: 120, layoutSizingHorizontal: "FIXED" });
      copy.appendChild(kid);
      copy.resize = function (w: number, h: number) {
        this.width = w;
        this.height = h;
      };
      copy.remove = function () {
        this.removed = true;
        page.children.splice(page.children.indexOf(this), 1);
      };
      clones.push(copy);
      return copy;
    };
    const res = (await responsiveAudit(ctx({ nodeId: screen.id, sizes: [375, { width: 834, height: 1194, name: "iPad" }] }))) as any;
    expect(res.results.map((r: any) => [r.viewport, r.width])).toEqual([["375w", 375], ["iPad", 834]]);
    expect(res.results[0].hints?.[0]).toMatch(/fixed at 380px — wider than the 375px viewport/);
    // The hint names the ORIGINAL banner, not the throwaway copy.
    expect(res.results[0].hints?.[0]).toContain(`(${wide.id})`);
    expect(clones.every((c) => c.removed)).toBe(true);
    // No id of a throwaway copy survives in any message.
    const cloneIds = new Set(clones.flatMap((c) => [c.id, ...c.findAll(() => true).map((k: any) => k.id)]));
    for (const r of res.results) for (const m of [...r.issues, ...(r.hints ?? [])]) for (const id of cloneIds) expect(m).not.toContain(`${id}`);
    expect(page.children).toEqual([screen]);
  });
});
