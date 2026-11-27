import { describe, expect, it } from "vitest";
import { codeConnectSource, mapToCodeConnect, parseCodeConnect, codeConnectToMap, figmaNodeUrl } from "../../src/shared/code-connect.js";
import type { ComponentMap } from "../../src/shared/component-map.js";

/**
 * The trap in Code Connect is the DIRECTION of figma.enum: its object maps
 * Figma value → code value, while the component map stores code → Figma. A
 * round trip that only compared keys would pass with the values reversed,
 * so the round trip below compares whole maps.
 */

const MAP: ComponentMap = {
  version: 1,
  components: {
    Button: {
      figma: "Button",
      props: {
        size: { figma: "Size", type: "VARIANT", values: { sm: "Small", lg: "Large" } },
        disabled: { figma: "Disabled", type: "BOOLEAN" },
        icon: { figma: "Icon", type: "INSTANCE_SWAP" },
      },
      children: "Label",
    },
    Avatar: { figma: "Avatar" },
  },
};

describe("writing .figma.tsx", () => {
  it("emits figma.connect with the node URL and Figma→code enum values", () => {
    const src = codeConnectSource("Button", MAP.components.Button!, { component: "Button", nodeId: "12:3" }, { fileKey: "KEY", importFrom: "@/ui" });
    expect(src).toContain('import figma from "@figma/code-connect";');
    expect(src).toContain('import { Button } from "@/ui";');
    expect(src).toContain(`figma.connect(Button, "${figmaNodeUrl("KEY", "12:3")}", {`);
    expect(src).toContain('size: figma.enum("Size", { "Small": "sm", "Large": "lg" }),');
    expect(src).toContain('disabled: figma.boolean("Disabled"),');
    expect(src).toContain('icon: figma.instance("Icon"),');
    expect(src).toContain('children: figma.string("Label"),');
    expect(src).toContain("example: (props) => <Button size={props.size} disabled={props.disabled} icon={props.icon}>{props.children}</Button>,");
  });

  it("lists components with no node in the file instead of inventing a URL", () => {
    const { files, missing } = mapToCodeConnect(MAP, { Button: "12:3" }, { fileKey: "KEY" });
    expect(files.map((f) => f.fileName)).toEqual(["Button.figma.tsx"]);
    expect(missing).toEqual(["Avatar"]);
  });
});

describe("reading .figma.tsx", () => {
  it("round-trips the component map exactly", () => {
    const { files } = mapToCodeConnect(MAP, { Button: "12:3", Avatar: "40:1" }, { fileKey: "KEY" });
    const { connections, skipped } = parseCodeConnect(files.map((f) => f.source).join("\n"));
    expect(skipped).toEqual([]);
    expect(connections.map((c) => [c.component, c.fileKey, c.nodeId])).toEqual([
      ["Button", "KEY", "12:3"],
      ["Avatar", "KEY", "40:1"],
    ]);
    const { map, unresolved } = codeConnectToMap(connections, { "12:3": "Button", "40:1": "Avatar" });
    expect(unresolved).toEqual([]);
    expect(map).toEqual(MAP);
  });

  it("reads a hand-written CLI-style file", () => {
    const src = `
      import figma from '@figma/code-connect'
      import { Chip } from './Chip'
      figma.connect(Chip, 'https://www.figma.com/design/ABC/Lib?node-id=7-9&m=dev', {
        props: {
          tone: figma.enum('Tone', { 'Neutral': 'neutral', 'Danger': 'danger' }),
          label: figma.string('Text'),
        },
        example: ({ tone, label }) => <Chip tone={tone}>{label}</Chip>,
      })`;
    const { connections } = parseCodeConnect(src);
    expect(connections[0]).toMatchObject({ component: "Chip", fileKey: "ABC", nodeId: "7:9" });
    expect(connections[0]!.props.tone).toMatchObject({ figma: "Tone", values: { neutral: "Neutral", danger: "Danger" } });
    expect(connections[0]!.props.label).toMatchObject({ figma: "Text", type: "TEXT" });
  });

  it("says so when a URL carries no node-id", () => {
    const { skipped } = parseCodeConnect(`figma.connect(X, "https://www.figma.com/design/ABC/Lib", {})`);
    expect(skipped[0]).toMatch(/no node-id/);
  });
});
