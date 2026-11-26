import { describe, expect, it } from "vitest";
import {
  camelCase,
  checkMap,
  codeValue,
  mapFromFigma,
  mapToTypeScript,
  pascalCase,
  translateProps,
  type FigmaComponentInfo,
} from "../../src/shared/component-map.js";

const button: FigmaComponentInfo = {
  id: "1:1",
  name: "UI/Button",
  type: "COMPONENT_SET",
  variantOptions: { Tone: ["Primary", "Secondary"], Size: ["Small", "Extra Large"] },
  properties: {
    "Label#1:2": { type: "TEXT", defaultValue: "Button" },
    "Show icon#1:3": { type: "BOOLEAN", defaultValue: true },
  },
};

describe("names", () => {
  it("translates between Figma and code spellings", () => {
    expect(pascalCase("P/Nav/TopBar")).toBe("TopBar");
    expect(pascalCase("icon button")).toBe("IconButton");
    expect(camelCase("Show icon")).toBe("showIcon");
    expect(codeValue("Extra Large")).toBe("extra-large");
  });
});

describe("mapFromFigma", () => {
  it("maps variants to props with value maps, and the label property to children", () => {
    const map = mapFromFigma([button]);
    const m = map.components.Button!;
    expect(m.figma).toBe("UI/Button");
    expect(m.children).toBe("Label");
    expect(m.props!.tone).toEqual({ figma: "Tone", type: "VARIANT", values: { primary: "Primary", secondary: "Secondary" } });
    expect(m.props!.size!.values).toEqual({ small: "Small", "extra-large": "Extra Large" });
    expect(m.props!.showIcon).toEqual({ figma: "Show icon", type: "BOOLEAN" });
    const ts = mapToTypeScript(map);
    expect(ts).toContain("export interface ButtonProps {");
    expect(ts).toContain('tone?: "primary" | "secondary";');
    expect(ts).toContain("showIcon?: boolean;");
    expect(ts).toContain("children?: string;");
  });

  it("never gives two components the same code name", () => {
    const map = mapFromFigma([button, { ...button, id: "2:1", name: "Legacy/Button" }]);
    expect(Object.keys(map.components)).toHaveLength(2);
  });
});

describe("translateProps", () => {
  const map = mapFromFigma([button]);
  it("turns code props into the variant and properties instantiate() takes", () => {
    const t = translateProps(map, "Button", { tone: "primary", size: "extra-large", showIcon: false, children: "Save", onClick: "x" });
    expect(t).toEqual({
      component: "UI/Button",
      variant: { Tone: "Primary", Size: "Extra Large" },
      properties: { "Show icon": false, Label: "Save" },
      unmapped: ["onClick"],
    });
  });

  it("puts a fixed variant value in the variant", () => {
    const m = structuredClone(map);
    m.components.Button!.fixed = { Tone: "Secondary" };
    expect(translateProps(m, "Button", {}).variant).toEqual({ Tone: "Secondary" });
  });

  it("refuses a component the map does not have, naming the ones it does", () => {
    expect(() => translateProps(map, "Card", {})).toThrow(/has: Button/);
  });
});

describe("checkMap", () => {
  it("is clean for a map made from the file", () => {
    const map = mapFromFigma([button]);
    expect(checkMap(map, (n) => (n === "UI/Button" ? button : undefined)).filter((f) => f.severity === "error")).toEqual([]);
  });

  it("reports what drifted", () => {
    const map = mapFromFigma([button]);
    map.components.Button!.props!.tone!.values = { primary: "Primary", danger: "Danger" };
    map.components.Button!.props!.loading = { figma: "Loading", type: "BOOLEAN" };
    map.components.Ghost = { figma: "Ghost" };
    const f = checkMap(map, (n) => (n === "UI/Button" ? button : undefined));
    const text = f.map((x) => x.message).join("\n");
    expect(text).toMatch(/"Danger", not a value of "Tone"/);
    expect(text).toMatch(/no code value for "Secondary"/);
    expect(text).toMatch(/property "Loading"/);
    expect(text).toMatch(/Figma has no component "Ghost"/);
  });
});
