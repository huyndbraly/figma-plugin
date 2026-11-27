/**
 * Fourth review pass (over the pass-3 fixes, commit 6985e88).
 * The lock-file tests live in phase4-tools.test.ts next to the earlier ones.
 */
import { describe, expect, it } from "vitest";
import { parseCodeConnect } from "../../src/shared/code-connect.js";
import { RestHub } from "../../src/server/rest-hub.js";
import { sanitizeSvg } from "../../src/server/byok.js";
import { domToFigma } from "../../src/shared/html-to-figma.js";

describe("Code Connect, fourth pass", () => {
  it("an apostrophe in JSX text does not swallow the rest of its line", () => {
    const { connections } = parseCodeConnect(`
      figma.connect(Btn, "https://www.figma.com/design/K/x?node-id=1-1", {
        props: { label: figma.string("Label") },
        example: () => <Btn>Don't</Btn> })
      figma.connect(Other, "https://www.figma.com/design/K/x?node-id=2-2", { props: { size: figma.enum("Size", { "S": "s" }) } })`);
    expect(connections.map((c) => c.component)).toEqual(["Btn", "Other"]);
    expect(Object.keys(connections[0]!.props)).toEqual(["label"]);
    expect(Object.keys(connections[1]!.props)).toEqual(["size"]);
  });

  it("an apostrophe in a regex inside props does not merge two props", () => {
    const { connections } = parseCodeConnect(`
      figma.connect(Btn, "https://www.figma.com/design/K/x?node-id=1-1", {
        props: { a: figma.string("A").replace(/'/g, ""), b: figma.boolean("B") },
      })`);
    expect(Object.keys(connections[0]!.props)).toEqual(["a", "b"]);
  });

  it("`props:` is not found inside a longer key", () => {
    const { connections } = parseCodeConnect(`
      figma.connect(Btn, "https://www.figma.com/design/K/x?node-id=1-1", {
        variant: { ownprops: 1 },
        props: { real: figma.string("Real") },
      })`);
    expect(Object.keys(connections[0]!.props)).toEqual(["real"]);
  });
});

describe("REST hub, fourth pass", () => {
  const TOKEN = "figd_abcdefgh1234";
  const ok = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

  it("the status carries tokenGen from the start (before any check)", () => {
    const hub = new RestHub({ env: () => TOKEN, fetch: ok });
    expect(hub.getStatus().tokenGen).toBe(hub.generation());
  });

  it("two processes (an old and a new leader) do not start at the same generation", () => {
    const a = new RestHub({ env: () => TOKEN, fetch: ok });
    const b = new RestHub({ env: () => TOKEN, fetch: ok });
    expect(a.generation()).not.toBe(b.generation());
  });

  it("status listeners receive tokenGen too", () => {
    const hub = new RestHub({ env: () => undefined, fetch: ok });
    const seen: Array<number | undefined> = [];
    hub.onStatus((s) => seen.push(s.tokenGen));
    hub.setPluginToken(TOKEN);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe(hub.generation());
  });

  it("a follower does not cache while the leader's token is unknown", async () => {
    const follower = new RestHub({ env: () => undefined, fetch: ok });
    follower.setRemote(() => async () => ({ noToken: true }), async () => undefined);
    expect(await follower.cacheKey()).toBeNull();
  });
});

describe("SVG sanitizer, fourth pass", () => {
  it("a numeric reference to a character XML forbids is escaped, a valid one is kept", () => {
    const out = sanitizeSvg("<svg><text>a&#0;b &#x110000; &#xD800; &#65; &#x1F600; &amp; & x</text></svg>");
    expect(out).toContain("&amp;#0;");
    expect(out).toContain("&amp;#x110000;");
    expect(out).toContain("&amp;#xD800;");
    expect(out).toContain("&#65;");
    expect(out).toContain("&#x1F600;");
    expect(out).toContain("&amp; &amp; x");
  });
});

describe("htmlToFigma, fourth pass", () => {
  const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
  it("a single-line row-reverse of children with DIFFERENT heights sorts left to right", () => {
    const { spec } = domToFigma({
      tag: "div", rect: box(0, 0, 300, 100), style: { display: "flex", flexDirection: "row-reverse", alignItems: "center" },
      children: [
        { tag: "i", id: "a", rect: box(200, 40, 100, 20), style: {} }, // short, lower top
        { tag: "i", id: "b", rect: box(100, 0, 100, 100), style: {} }, // tall
        { tag: "i", id: "c", rect: box(0, 30, 100, 40), style: {} },
      ],
    });
    expect((spec.children as Array<{ name: string }>).map((c) => c.name)).toEqual(["i#c", "i#b", "i#a"]);
  });

  it("a single-line column-reverse of children with different widths sorts top to bottom", () => {
    const { spec } = domToFigma({
      tag: "div", rect: box(0, 0, 100, 300), style: { display: "flex", flexDirection: "column-reverse", alignItems: "center" },
      children: [
        { tag: "i", id: "a", rect: box(40, 200, 20, 100), style: {} },
        { tag: "i", id: "b", rect: box(0, 100, 100, 100), style: {} },
      ],
    });
    expect((spec.children as Array<{ name: string }>).map((c) => c.name)).toEqual(["i#b", "i#a"]);
  });
});
