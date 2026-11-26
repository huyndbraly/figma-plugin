import { describe, expect, it } from "vitest";
import { executeWrite } from "../../src/server/executor.js";
import { SessionRegistry } from "../../src/server/session.js";
import { validateOperation } from "../../src/server/validate.js";
import type { AnyOperation, BridgeResponse } from "../../src/shared/protocol.js";

function runner() {
  const calls: Array<{ op: AnyOperation; params: Record<string, unknown> }> = [];
  const runOp = async (op: AnyOperation, params: Record<string, unknown>): Promise<BridgeResponse> => {
    calls.push({ op, params });
    return { id: "x", ok: true, result: { id: "1:1" } };
  };
  return { runOp, calls };
}

async function run(code: string) {
  const r = runner();
  const res = await executeWrite(code, new SessionRegistry().get(), { runOp: r.runOp });
  return { res, calls: r.calls };
}

describe("component methods in the figma_write sandbox", () => {
  it("maps positional calls onto the op params", async () => {
    const { res, calls } = await run(`
      await figma.findComponent("Button");
      await figma.findOrCreateComponent("Card", { width: 320 });
      await figma.instantiate("Button", { variant: { Size: "lg" }, properties: { Label: "Save" } });
      await figma.instantiate("Button", "9:9");
      await figma.createInstance("Chip");
      await figma.setInstanceProperties("5:5", { Label: "Hi" });
      await figma.setProperties("5:5", { Size: "sm" });
      await figma.setInstanceOverrides("5:5", [{ target: "Label", props: { characters: "x" } }]);
      await figma.setInstanceOverrides("5:5", { from: "6:6" });
      await figma.editComponentProperty("2:2", "Label", { name: "Text" });
      await figma.deleteComponentProperty("2:2", "Label");
      await figma.setComponentDescription("2:2", "Primary action");
      await figma.swapComponent("5:5", "Icon/Check");
      await figma.componentize("3:3", { replaceCopies: true });
      await figma.detachInstance("5:5");
      return true;
    `);
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    const byOp = calls.map((c) => [c.op, c.params]);
    expect(byOp[0]).toEqual(["find_component", { query: "Button" }]);
    expect(byOp[1]).toEqual(["find_or_create_component", { name: "Card", spec: { width: 320 } }]);
    expect(byOp[2]![0]).toBe("instantiate");
    expect(byOp[2]![1]).toMatchObject({ component: "Button", variant: { Size: "lg" }, properties: { Label: "Save" } });
    expect(byOp[3]![1]).toMatchObject({ component: "Button", parentId: "9:9" });
    expect(byOp[4]![0]).toBe("instantiate");
    expect(byOp[5]).toEqual(["set_instance_properties", { nodeId: "5:5", properties: { Label: "Hi" } }]);
    expect(byOp[6]![0]).toBe("set_instance_properties");
    expect(byOp[7]![1]).toEqual({ nodeId: "5:5", overrides: [{ target: "Label", props: { characters: "x" } }] });
    expect(byOp[8]![1]).toEqual({ nodeId: "5:5", from: "6:6" });
    expect(byOp[9]).toEqual(["edit_component_property", { nodeId: "2:2", property: "Label", name: "Text" }]);
    expect(byOp[10]).toEqual(["delete_component_property", { nodeId: "2:2", property: "Label" }]);
    expect(byOp[11]).toEqual(["set_component_description", { nodeId: "2:2", description: "Primary action" }]);
    expect(byOp[12]).toEqual(["swap_component", { nodeId: "5:5", component: "Icon/Check" }]);
    expect(byOp[13]).toEqual(["componentize", { nodeId: "3:3", replaceCopies: true }]);
    expect(byOp[14]).toEqual(["detach_instance", { nodeId: "5:5" }]);
  });

  it("puts a placement group on instantiate, so a row of instances moves together", async () => {
    const { calls } = await run(`await figma.instantiate("A"); await figma.instantiate("B");`);
    const groups = calls.map((c) => c.params.placeGroup);
    expect(typeof groups[0]).toBe("string");
    expect(groups[0]).toBe(groups[1]);
  });
});

describe("component op validation", () => {
  it("accepts the documented shapes", () => {
    expect(() => validateOperation("instantiate", { component: "Button" })).not.toThrow();
    expect(() => validateOperation("instantiate", { key: "abc123" })).not.toThrow();
    expect(() =>
      validateOperation("create_variants", { name: "Button", variants: [{ props: { Size: "sm" }, spec: {} }] }),
    ).not.toThrow();
    expect(validateOperation("add_component_property", { nodeId: "1:2", name: "On", type: "boolean" }).params.type).toBe(
      "BOOLEAN",
    );
  });

  it("refuses what cannot work", () => {
    expect(() => validateOperation("instantiate", {})).toThrow(/requires component/);
    expect(() => validateOperation("create_variants", { name: "X", variants: [] })).toThrow(/requires variants/);
    expect(() => validateOperation("add_component_property", { nodeId: "1:2", name: "X", type: "COLOR" })).toThrow();
    expect(() => validateOperation("add_component_property", { nodeId: "1:2", name: "Icon", type: "INSTANCE_SWAP" })).toThrow(
      /INSTANCE_SWAP/,
    );
    expect(() => validateOperation("set_instance_overrides", { nodeId: "1:2" })).toThrow(/overrides, from, or properties/);
    expect(() => validateOperation("detach_instance", {})).toThrow();
  });
});
