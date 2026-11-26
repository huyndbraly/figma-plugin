import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createVariable,
  deleteVariable,
  exportTokens,
  findVariableByName,
  importTokens,
  renameVariable,
} from "../../../src/plugin/handlers/tokens.js";
import { getVariables } from "../../../src/plugin/handlers/read.js";
import { makeContext } from "../../../src/plugin/context.js";

/**
 * Variable lookups by name, without a round trip per variable.
 *
 * findVariableByName awaited getVariableByIdAsync once per variable, one after
 * another, and ran for every `$token` of every node a create made: 400 tokens
 * and 80 bound fills was 32 000 sequential awaits. Now one
 * getLocalVariablesAsync feeds a name map kept for a moment — and every op
 * that changes the names clears it, so nothing stale is ever bound.
 */

type Fake = Record<string, any>;
const ctx = (params: Record<string, unknown>) => makeContext(params, () => {});

let collections: Fake[];
let byId: Map<string, Fake>;
let n: number;
let api: Fake;

function collection(name: string): Fake {
  const c: Fake = {
    id: `VariableCollectionId:${collections.length + 1}`,
    name,
    modes: [{ modeId: "m0", name: "Mode 1" }],
    defaultModeId: "m0",
    variableIds: [],
    addMode: vi.fn(),
  };
  collections.push(c);
  return c;
}

function variable(name: string, c: Fake, type = "COLOR"): Fake {
  const v: Fake = {
    id: `VariableID:${++n}`,
    name,
    resolvedType: type,
    variableCollectionId: c.id,
    valuesByMode: { m0: { r: 1, g: 0, b: 0, a: 1 } },
    setValueForMode: vi.fn((m: string, val: unknown) => (v.valuesByMode[m] = val)),
    remove: vi.fn(() => {
      byId.delete(v.id);
      c.variableIds = c.variableIds.filter((id: string) => id !== v.id);
    }),
  };
  byId.set(v.id, v);
  c.variableIds.push(v.id);
  return v;
}

beforeEach(() => {
  collections = [];
  byId = new Map();
  n = 0;
  api = {
    getLocalVariableCollectionsAsync: vi.fn(async () => collections),
    getLocalVariablesAsync: vi.fn(async () => [...byId.values()]),
    getVariableByIdAsync: vi.fn(async (id: string) => byId.get(id) ?? null),
    createVariableCollection: vi.fn((name: string) => collection(name)),
    createVariable: vi.fn((name: string, c: Fake, type: string) => variable(name, c, type)),
  };
  (globalThis as any).figma = {
    root: { children: [] },
    loadAllPagesAsync: async () => {},
    variables: api,
    mixed: Symbol("mixed"),
  };
});

describe("findVariableByName", () => {
  it("reads every variable in ONE call, and not again within a request", async () => {
    const c = collection("Design Tokens");
    for (let i = 0; i < 50; i++) variable(`color/${i}`, c);
    for (let i = 0; i < 20; i++) expect((await findVariableByName(`color/${i}`))?.name).toBe(`color/${i}`);
    expect(api.getLocalVariablesAsync).toHaveBeenCalledTimes(1);
    expect(api.getVariableByIdAsync).not.toHaveBeenCalled();
    expect(await findVariableByName("color/missing")).toBe(null);
  });

  it("keeps the first of two same-named variables, in collection order", async () => {
    const a = collection("A");
    const b = collection("B");
    const first = variable("brand", a);
    variable("brand", b);
    expect(await findVariableByName("brand")).toBe(first);
  });

  it("sees a variable created, renamed or deleted by an op at once", async () => {
    const c = collection("Design Tokens");
    variable("old", c);
    expect(await findVariableByName("new")).toBe(null);

    await createVariable(ctx({ name: "new", value: "#000000" }));
    expect((await findVariableByName("new"))?.name).toBe("new");

    await renameVariable(ctx({ variable: "new", newName: "renamed" }));
    expect(await findVariableByName("new")).toBe(null);
    expect((await findVariableByName("renamed"))?.name).toBe("renamed");

    await deleteVariable(ctx({ variable: "renamed" }));
    expect(await findVariableByName("renamed")).toBe(null);
  });

  it("sees what import_tokens created", async () => {
    collection("Design Tokens");
    expect(await findVariableByName("color/primary")).toBe(null);
    await importTokens(ctx({ tokens: { color: { primary: { $type: "color", $value: "#3366ee" } } } }));
    expect((await findVariableByName("color/primary"))?.name).toBe("color/primary");
  });

  it("a variable renamed in the editor since the list was read is not returned under its old name", async () => {
    const c = collection("Design Tokens");
    const v = variable("primary", c);
    expect(await findVariableByName("primary")).toBe(v);
    v.name = "brand/primary";
    expect(await findVariableByName("primary")).toBe(null);
  });

  it("never answers from another figma's variables", async () => {
    const c = collection("Design Tokens");
    variable("primary", c);
    expect(await findVariableByName("primary")).not.toBe(null);
    collections = [];
    byId = new Map();
    (globalThis as any).figma = { ...(globalThis as any).figma, variables: { ...api } };
    expect(await findVariableByName("primary")).toBe(null);
  });
});

describe("whole-list readers use one fetch", () => {
  it("get_variables and export_tokens never await per id", async () => {
    const c = collection("Design Tokens");
    const target = variable("color/base", c);
    const alias = variable("color/alias", c);
    alias.valuesByMode.m0 = { type: "VARIABLE_ALIAS", id: target.id };

    const vars = (await getVariables()) as any;
    expect(vars.collections[0].variables.map((v: any) => v.name)).toEqual(["color/base", "color/alias"]);
    const out = (await exportTokens(ctx({}))) as any;
    expect(out.count).toBe(2);
    expect(JSON.stringify(out.tokens)).toContain("{color.base}");
    expect(api.getVariableByIdAsync).not.toHaveBeenCalled();
  });
});
