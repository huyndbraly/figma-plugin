import { beforeEach, describe, expect, it, vi } from "vitest";
import { listComponents } from "../../../src/plugin/handlers/design-system.js";

/**
 * get_components at design detail on a variant-heavy library.
 *
 * Every variant was serialized in full twice — once on its own and once
 * walked through as part of its set — each serialization walked the subtree
 * twice (text layers, then slots), and includeInstances asked every
 * component for its instances one await after another.
 */

const MIXED = Symbol("mixed");

function text(id: string, name: string): any {
  return { id, name, type: "TEXT", characters: name, textStyleId: "", fillStyleId: "", fontName: { family: "Inter", style: "Regular" }, fontSize: 14, lineHeight: { unit: "AUTO" } };
}

function component(id: string, name: string, kids: any[]): any {
  const c: any = {
    id,
    name,
    type: "COMPONENT",
    key: `k-${id}`,
    description: "",
    componentPropertyDefinitions: {},
    variantProperties: { State: name.split("=")[1] ?? "x" },
    layoutMode: "NONE",
    cornerRadius: 0,
    children: kids,
    getInstancesAsync: vi.fn(async () => [{}, {}]),
  };
  for (const k of kids) k.parent = c;
  return c;
}

let page: any;
let set: any;
let variants: any[];
let standalone: any;

beforeEach(() => {
  variants = ["State=Default", "State=Hover", "State=Pressed"].map((n, i) =>
    component(`2:${i}`, n, [text(`3:${i}`, "Label"), { id: `4:${i}`, name: "Icon slot", type: "SLOT", children: [] }]),
  );
  set = {
    id: "1:1",
    name: "Button",
    type: "COMPONENT_SET",
    key: "k-set",
    description: "",
    componentPropertyDefinitions: { State: { type: "VARIANT" } },
    variantGroupProperties: { State: { values: ["Default", "Hover", "Pressed"] } },
    defaultVariant: variants[0],
    layoutMode: "NONE",
    cornerRadius: 0,
    children: variants,
  };
  for (const v of variants) v.parent = set;
  standalone = component("5:1", "Avatar", [text("5:2", "Initials")]);
  page = { id: "0:1", name: "Components", type: "PAGE", children: [set, standalone] };
  set.parent = page;
  standalone.parent = page;
  (globalThis as any).figma = {
    mixed: MIXED,
    loadAllPagesAsync: vi.fn(async () => {}),
    root: { type: "DOCUMENT", children: [page], findAllWithCriteria: () => [set, ...variants, standalone] },
  };
});

describe("listComponents", () => {
  it("describes a variant of a listed set once, inside the set", async () => {
    const out = await listComponents({ detail: "design", depth: 2 });
    expect(out.total).toBe(5);
    const byId = new Map(out.components.map((c) => [c.id, c as any]));
    const setOut = byId.get("1:1");
    expect(setOut.variants.map((v: any) => v.id)).toEqual(["2:0", "2:1", "2:2"]);
    expect(setOut.textLayers.length).toBe(3);
    expect(setOut.slots.length).toBe(3);
    // The variant still has an entry — its id, and the set it belongs to —
    // but nothing the set entry already carries.
    const v = byId.get("2:1");
    expect(v).toMatchObject({ id: "2:1", type: "COMPONENT", componentSetId: "1:1", variantProperties: { State: "Hover" } });
    expect(v.textLayers).toBeUndefined();
    expect(v.usage).toBeUndefined();
    // A component outside any set is described in full, text and slots alike.
    expect(byId.get("5:1").textLayers.map((t: any) => t.name)).toEqual(["Initials"]);
  });

  it("a variant whose set fell outside maxComponents keeps its full entry", async () => {
    (globalThis as any).figma.root.findAllWithCriteria = () => [...variants, set, standalone];
    const out = await listComponents({ detail: "design", maxComponents: 2 });
    expect((out.components[0] as any).textLayers.length).toBe(1);
  });

  it("instance counts come from a known map without asking any component", async () => {
    const counts = new Map([["2:0", 7], ["5:1", 3]]);
    const out = await listComponents({ detail: "design", includeInstances: true, instanceCounts: counts });
    const byId = new Map(out.components.map((c) => [c.id, c as any]));
    expect(byId.get("2:0").instanceCount).toBe(7);
    expect(byId.get("2:1").instanceCount).toBe(0);
    expect(byId.get("5:1").instanceCount).toBe(3);
    for (const v of variants) expect(v.getInstancesAsync).not.toHaveBeenCalled();
  });

  it("without one, every component is asked at once rather than in turn", async () => {
    let inFlight = 0;
    let peak = 0;
    for (const c of [...variants, standalone]) {
      c.getInstancesAsync = vi.fn(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return [{}];
      });
    }
    const out = await listComponents({ includeInstances: true });
    expect(out.components.filter((c: any) => c.instanceCount === 1)).toHaveLength(4);
    expect(peak).toBe(4);
  });
});
