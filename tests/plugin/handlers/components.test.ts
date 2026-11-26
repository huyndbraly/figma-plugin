import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeContext } from "../../../src/plugin/context.js";
import { resetKeepClearGroups } from "../../../src/plugin/keep-clear.js";
import {
  resetInstanceOverrides,
  swapComponent,
  addComponentProperty,
  componentize,
  createVariants,
  findComponent,
  getInstanceOverrides,
  instantiate,
  setInstanceOverrides,
  setInstanceProperties,
} from "../../../src/plugin/handlers/components.js";
import { parseVariantName } from "../../../src/plugin/variant-grid.js";

/**
 * A small in-memory Figma: enough node behaviour (tree, components, sets,
 * instances with variant switching and component properties) to drive the
 * component handlers end to end without the plugin runtime.
 */

const ctx = (params: Record<string, unknown>) => makeContext(params, () => {});

let seq = 0;
let nodes: Map<string, any>;
let page: any;

function detach(n: any) {
  if (n.parent) {
    const i = n.parent.children.indexOf(n);
    if (i >= 0) n.parent.children.splice(i, 1);
    n.parent = null;
  }
}

function base(type: string, name: string, extra: Record<string, unknown> = {}): any {
  const n: any = {
    id: `${++seq}:1`,
    type,
    name,
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    visible: true,
    removed: false,
    opacity: 1,
    rotation: 0,
    layoutMode: "NONE",
    clipsContent: false,
    fills: [],
    strokes: [],
    effects: [],
    children: [],
    parent: null,
    componentPropertyReferences: null,
    appendChild(c: any) {
      detach(c);
      this.children.push(c);
      c.parent = this;
    },
    insertChild(i: number, c: any) {
      detach(c);
      this.children.splice(i, 0, c);
      c.parent = this;
    },
    findAll(fn: (k: any) => boolean = () => true) {
      const out: any[] = [];
      const walk = (x: any) => {
        for (const k of x.children ?? []) {
          if (fn(k)) out.push(k);
          walk(k);
        }
      };
      walk(this);
      return out;
    },
    findAllWithCriteria({ types }: { types: string[] }) {
      return this.findAll((k: any) => types.includes(k.type));
    },
    remove() {
      detach(this);
      this.removed = true;
      nodes.delete(this.id);
    },
    resize(w: number, h: number) {
      this.width = w;
      this.height = h;
    },
    resizeWithoutConstraints(w: number, h: number) {
      this.width = w;
      this.height = h;
    },
    setBoundVariable: vi.fn(),
    ...extra,
  };
  nodes.set(n.id, n);
  return n;
}

function text(name: string, characters: string): any {
  return base("TEXT", name, {
    characters,
    fontName: { family: "Inter", style: "Regular" },
    getRangeAllFontNames: () => [{ family: "Inter", style: "Regular" }],
  });
}

/** Deep copy of a subtree as instance sublayers ("I<inst>;<orig>"). */
function cloneInto(src: any, instId: string): any {
  const c = base(src.type, src.name, src.type === "TEXT"
    ? { characters: src.characters, fontName: src.fontName, getRangeAllFontNames: src.getRangeAllFontNames }
    : {});
  nodes.delete(c.id);
  c.id = `I${instId};${src.id}`;
  nodes.set(c.id, c);
  for (const k of src.children) c.appendChild(cloneInto(k, instId));
  return c;
}

/** Definitions a component or set owns: VARIANT ones derived from children names. */
function ownerOf(comp: any): any {
  return comp.parent?.type === "COMPONENT_SET" ? comp.parent : comp;
}

function makeComponentish(n: any): any {
  n.customProps = n.customProps ?? {};
  n.description = n.description ?? "";
  n.key = `key-${n.id}`;
  Object.defineProperty(n, "componentPropertyDefinitions", {
    configurable: true,
    get() {
      const defs: Record<string, any> = {};
      if (this.type === "COMPONENT_SET") {
        for (const v of this.children) {
          for (const [k, val] of Object.entries(parseVariantName(v.name))) {
            defs[k] = defs[k] ?? { type: "VARIANT", defaultValue: val, variantOptions: [] };
            if (!defs[k].variantOptions.includes(val)) defs[k].variantOptions.push(val);
          }
        }
      }
      return { ...defs, ...this.customProps };
    },
  });
  n.addComponentProperty = function (name: string, type: string, defaultValue: unknown) {
    const key = `${name}#${++seq}:0`;
    this.customProps[key] = { type, defaultValue };
    return key;
  };
  n.createInstance = function () {
    const inst = base("INSTANCE", this.type === "COMPONENT" && this.parent?.type === "COMPONENT_SET" ? this.parent.name : this.name, {
      width: this.width,
      height: this.height,
      main: this,
      values: {} as Record<string, unknown>,
      overrides: [{ id: "x", overriddenFields: ["fills"] }],
      exposedInstances: [],
      removeOverrides() {
        this.overrides = [];
      },
      getMainComponentAsync: async function () {
        return this.main;
      },
    });
    for (const k of this.children) inst.appendChild(cloneInto(k, inst.id));
    Object.defineProperty(inst, "componentProperties", {
      get() {
        const owner = ownerOf(this.main);
        const out: Record<string, any> = {};
        for (const [k, d] of Object.entries<any>(owner.componentPropertyDefinitions)) {
          out[k] = {
            type: d.type,
            value: d.type === "VARIANT" ? parseVariantName(this.main.name)[k] : (this.values[k] ?? d.defaultValue),
          };
        }
        return out;
      },
    });
    inst.setProperties = function (patch: Record<string, unknown>) {
      const owner = ownerOf(this.main);
      const defs = owner.componentPropertyDefinitions;
      const variantPatch = Object.entries(patch).filter(([k]) => defs[k]?.type === "VARIANT");
      if (variantPatch.length) {
        const want = { ...parseVariantName(this.main.name), ...Object.fromEntries(variantPatch) };
        const next = owner.children.find((v: any) =>
          Object.entries(want).every(([k, val]) => parseVariantName(v.name)[k] === val),
        );
        if (!next) throw new Error("no such variant");
        this.main = next;
        // Switching variant drops values set alongside it (Figma's behaviour).
        this.values = {};
        return;
      }
      for (const [k, v] of Object.entries(patch)) {
        if (!(k in defs)) throw new Error(`Could not find a component property with name: '${k}'`);
        this.values[k] = v;
      }
    };
    figma.currentPage.appendChild(inst);
    return inst;
  };
  return n;
}

function component(name: string, children: any[] = [], extra: Record<string, unknown> = {}): any {
  const c = makeComponentish(base("COMPONENT", name, extra));
  for (const k of children) c.appendChild(k);
  return c;
}

function set(name: string, variants: any[]): any {
  const s = makeComponentish(base("COMPONENT_SET", name));
  for (const v of variants) s.appendChild(v);
  Object.defineProperty(s, "defaultVariant", { configurable: true, get: () => s.children[0] });
  Object.defineProperty(s, "variantGroupProperties", {
    configurable: true,
    get() {
      const out: Record<string, { values: string[] }> = {};
      for (const v of s.children)
        for (const [k, val] of Object.entries(parseVariantName(v.name))) {
          out[k] = out[k] ?? { values: [] };
          if (!out[k]!.values.includes(val)) out[k]!.values.push(val);
        }
      return out;
    },
  });
  return s;
}

beforeEach(() => {
  resetKeepClearGroups();
  seq = 100;
  nodes = new Map();
  page = base("PAGE", "Page 1");
  nodes.delete(page.id);
  page.id = "0:1";
  nodes.set("0:1", page);
  const root = { type: "DOCUMENT", name: "File", children: [page], findAllWithCriteria: (c: any) => page.findAllWithCriteria(c) };
  (globalThis as any).figma = {
    root,
    currentPage: page,
    mixed: Symbol("mixed"),
    loadAllPagesAsync: async () => {},
    loadFontAsync: vi.fn(async () => {}),
    getNodeByIdAsync: vi.fn(async (id: string) => nodes.get(id) ?? null),
    createComponent: vi.fn(() => makeComponentish(base("COMPONENT", "Component"))),
    createComponentFromNode: vi.fn((n: any) => {
      n.type = "COMPONENT";
      return makeComponentish(n);
    }),
    combineAsVariants: vi.fn((comps: any[], parent: any) => {
      const s = set("Component 1", []);
      parent.appendChild(s);
      for (const c of comps) s.appendChild(c);
      return s;
    }),
  };
});

function buttonSet(): any {
  const variants = ["Size=sm, State=default", "Size=lg, State=default", "Size=sm, State=hover"].map((n) =>
    component(n, [text("Label", "Button")]),
  );
  const s = set("Button", variants);
  page.appendChild(s);
  return s;
}

describe("instantiate", () => {
  it("finds a set by name, picks the variant, then applies the other properties", async () => {
    const s = buttonSet();
    const labelKey = s.addComponentProperty("Label", "TEXT", "Button");
    const c = ctx({ component: "button", variant: { Size: "lg" }, properties: { Label: "Save" } });
    const res = (await instantiate(c)) as any;
    const inst = nodes.get(res.id);
    expect(inst.type).toBe("INSTANCE");
    expect(inst.main.name).toBe("Size=lg, State=default");
    // Set AFTER the variant switch — a single setProperties would have lost it.
    expect(inst.values[labelKey]).toBe("Save");
    expect(res.variant).toEqual({ Size: "lg", State: "default" });
  });

  it("names the closest components when the name does not exist", async () => {
    buttonSet();
    const e = (await instantiate(ctx({ component: "Buton" })).catch((x: unknown) => x)) as { hint: string };
    expect(e).toMatchObject({ code: "NODE_NOT_FOUND", hint: expect.stringContaining("Button") });
    // The set, not each of its variants.
    expect(e.hint).not.toContain("Size=");
  });

  it("lists the variants when the requested one does not exist", async () => {
    buttonSet();
    await expect(instantiate(ctx({ component: "Button", variant: { Size: "xl" } }))).rejects.toMatchObject({
      code: "INVALID_PARAMS",
      hint: expect.stringContaining("Size=lg, State=default"),
    });
  });

  it("parents the instance and keeps a page-level one clear of existing work", async () => {
    const card = component("Card");
    page.appendChild(card);
    const frame = base("FRAME", "Screen", { width: 390, height: 844 });
    page.appendChild(frame);
    const inside = (await instantiate(ctx({ component: "Card", parentId: frame.id }))) as any;
    expect(nodes.get(inside.id).parent).toBe(frame);
    const loose = (await instantiate(ctx({ component: card.id, x: 0, y: 0 }))) as any;
    expect(nodes.get(loose.id).y).toBeGreaterThanOrEqual(844);
  });
});

describe("setInstanceProperties", () => {
  it("resolves plain names to suffixed keys and reports unknown ones with the real names", async () => {
    const s = buttonSet();
    const key = s.addComponentProperty("Show icon", "BOOLEAN", true);
    const { id } = (await instantiate(ctx({ component: "Button" }))) as any;
    const res = (await setInstanceProperties(ctx({ nodeId: id, properties: { "show icon": false } }))) as any;
    expect(res.applied[key]).toBe(false);
    await expect(setInstanceProperties(ctx({ nodeId: id, properties: { Nope: 1 } }))).rejects.toMatchObject({
      code: "INVALID_PARAMS",
      hint: expect.stringContaining("Show icon"),
    });
  });
});

describe("resetInstanceOverrides", () => {
  it("clears overrides AND puts property values back to their defaults, keeping the variant", async () => {
    const s = buttonSet();
    const key = s.addComponentProperty("Label", "TEXT", "Button");
    const { id } = (await instantiate(ctx({ component: "Button", variant: { Size: "lg" }, properties: { Label: "Save" } }))) as any;
    const res = (await resetInstanceOverrides(ctx({ nodeId: id }))) as any;
    expect(res.cleared).toBe(1);
    expect(res.restoredProperties).toEqual({ [key]: "Button" });
    expect(nodes.get(id).main.name).toBe("Size=lg, State=default");
  });

  it("keepProperties leaves the values alone", async () => {
    const s = buttonSet();
    s.addComponentProperty("Label", "TEXT", "Button");
    const { id } = (await instantiate(ctx({ component: "Button", properties: { Label: "Save" } }))) as any;
    const res = (await resetInstanceOverrides(ctx({ nodeId: id, keepProperties: true }))) as any;
    expect(res.restoredProperties).toBeUndefined();
  });
});

describe("swapComponent", () => {
  it("names the variant with its set", async () => {
    buttonSet();
    page.appendChild(component("Card"));
    const { id } = (await instantiate(ctx({ component: "Card" }))) as any;
    nodes.get(id).swapComponent = function (c: any) {
      this.main = c;
    };
    const res = (await swapComponent(ctx({ nodeId: id, component: "Button", variant: { State: "hover" } }))) as any;
    expect(res.componentName).toBe("Button/Size=sm, State=hover");
  });
});

describe("setInstanceOverrides", () => {
  it("edits a layer inside the instance by name", async () => {
    buttonSet();
    const { id } = (await instantiate(ctx({ component: "Button" }))) as any;
    const res = (await setInstanceOverrides(ctx({ nodeId: id, overrides: [{ target: "Label", props: { characters: "Go" } }] }))) as any;
    expect(res.applied).toBe(1);
    const label = nodes.get(id).children[0];
    expect(label.characters).toBe("Go");
  });
});

describe("getInstanceOverrides", () => {
  it("reports the main component and flattened property values", async () => {
    buttonSet();
    const { id } = (await instantiate(ctx({ component: "Button", variant: { State: "hover" } }))) as any;
    const res = (await getInstanceOverrides(ctx({ nodeId: id }))) as any;
    expect(res.mainComponent.name).toBe("Button/Size=sm, State=hover");
    expect(res.componentProperties).toMatchObject({ Size: "sm", State: "hover" });
  });
});

describe("createVariants", () => {
  it("names each variant from its props, combines them and lays them out in a grid", async () => {
    const c = ctx({
      name: "Chip",
      variants: [
        { props: { Size: "sm", Tone: "neutral" }, spec: { width: 60, height: 24 } },
        { props: { Size: "sm", Tone: "brand" }, spec: { width: 60, height: 24 } },
        { props: { Size: "lg", Tone: "neutral" }, spec: { width: 90, height: 32 } },
      ],
      gap: 10,
      padding: 10,
    });
    const res = (await createVariants(c)) as any;
    const s = nodes.get(res.id);
    expect(s.type).toBe("COMPONENT_SET");
    expect(s.name).toBe("Chip");
    expect(res.variants.map((v: any) => v.name)).toEqual([
      "Size=sm, Tone=neutral",
      "Size=sm, Tone=brand",
      "Size=lg, Tone=neutral",
    ]);
    const pos = (n: string) => {
      const v = s.children.find((k: any) => k.name === n);
      return [v.x, v.y];
    };
    expect(pos("Size=sm, Tone=neutral")).toEqual([10, 10]);
    expect(pos("Size=sm, Tone=brand")).toEqual([10 + 90 + 10, 10]);
    expect(pos("Size=lg, Tone=neutral")).toEqual([10, 10 + 24 + 10]);
    expect(s.width).toBe(10 + 90 + 10 + 60 + 10);
  });

  it("refuses two variants with the same props and removes what it built", async () => {
    await expect(
      createVariants(ctx({ name: "X", variants: [{ props: { A: "1" } }, { props: { A: "1" } }] })),
    ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    expect(page.findAll((n: any) => n.type === "COMPONENT")).toHaveLength(0);
  });
});

describe("addComponentProperty", () => {
  it("binds a TEXT property to the same-named layer in every variant of a set", async () => {
    const s = buttonSet();
    const res = (await addComponentProperty(ctx({ nodeId: s.id, name: "Label", type: "TEXT", defaultValue: "Button", bind: "Label" }))) as any;
    expect(res.key).toMatch(/^Label#/);
    expect(res.bound).toHaveLength(3);
    for (const v of s.children) expect(v.children[0].componentPropertyReferences).toEqual({ characters: res.key });
  });

  it("redirects a variant to its set", async () => {
    const s = buttonSet();
    const c = ctx({ nodeId: s.children[1].id, name: "On", type: "BOOLEAN" });
    const res = (await addComponentProperty(c)) as any;
    expect(res.id).toBe(s.id);
    expect(c.warnings.some((w) => /live on its set/.test(w))).toBe(true);
  });
});

describe("componentize", () => {
  it("turns a frame into a component and swaps its copies for instances, keeping their text", async () => {
    const a = base("FRAME", "Card", { width: 200, height: 100 });
    a.appendChild(text("Title", "One"));
    const b = base("FRAME", "Card", { x: 300, y: 50, width: 200, height: 100 });
    b.appendChild(text("Title", "Two"));
    const other = base("FRAME", "Card", { x: 600 });
    other.appendChild(base("RECTANGLE", "Not a title"));
    page.appendChild(a);
    page.appendChild(b);
    page.appendChild(other);

    const res = (await componentize(ctx({ nodeId: a.id, replaceCopies: true }))) as any;
    expect(nodes.get(res.id).type).toBe("COMPONENT");
    expect(res.replaced).toHaveLength(1);
    expect(res.replaced[0].oldId).toBe(b.id);
    const inst = nodes.get(res.replaced[0].newId);
    expect(inst.type).toBe("INSTANCE");
    expect([inst.x, inst.y]).toEqual([300, 50]);
    expect(page.children.indexOf(inst)).toBe(1);
    expect(inst.children[0].characters).toBe("Two");
    expect(b.removed).toBe(true);
    expect(other.removed).toBe(false);
  });
});

describe("findComponent", () => {
  it("ranks by name and describes sets with their variant options", async () => {
    buttonSet();
    page.appendChild(component("Button Group"));
    page.appendChild(component("Card"));
    const res = (await findComponent(ctx({ query: "button" }))) as any;
    expect(res.matches.map((m: any) => m.name)).toEqual(["Button", "Button Group"]);
    expect(res.matches[0].variantOptions).toEqual({ Size: ["sm", "lg"], State: ["default", "hover"] });
  });
});
