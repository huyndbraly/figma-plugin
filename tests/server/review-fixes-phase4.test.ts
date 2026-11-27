import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codeConnectSource, mapToCodeConnect, parseCodeConnect, codeConnectToMap, parseConnectUrl } from "../../src/shared/code-connect.js";
import { sanitizeSvg, generateSvg } from "../../src/server/byok.js";
import { capturePage, checkCaptureUrl } from "../../src/server/html-capture.js";
import { domToFigma, fontStyle, type CapturedNode } from "../../src/shared/html-to-figma.js";
import { executeWrite } from "../../src/server/executor.js";
import { SessionRegistry } from "../../src/server/session.js";
import type { BridgeResponse } from "../../src/shared/protocol.js";

/**
 * Regression tests for the code-review findings on Code Connect, BYOK and
 * htmlToFigma (2026-11-27). Each one failed before its fix.
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "figma-review-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const ok = (result: unknown): BridgeResponse => ({ id: "x", ok: true, result });

describe("Code Connect writer", () => {
  it("a component with no props gets `() =>`, never the uncompilable `(()) =>`", () => {
    const src = codeConnectSource("Avatar", { figma: "Avatar" }, { component: "Avatar", nodeId: "1:1" }, { fileKey: "K" });
    expect(src).toContain("  example: () => <Avatar />,");
    expect(src).not.toContain("(())");
  });

  it("refuses names that would inject code or escape the folder", () => {
    for (const bad of ["../../x", "ui/Button", "my-button", 'X } from "evil"; import { Y']) {
      expect(() => codeConnectSource(bad, { figma: "B" }, { component: bad, nodeId: "1:1" }, { fileKey: "K" })).toThrow(/not a valid component identifier/);
    }
    const { files, invalid } = mapToCodeConnect({ components: { "../evil": { figma: "B" }, Ok: { figma: "B" } } }, { B: "1:1" }, { fileKey: "K" });
    expect(files.map((f) => f.fileName)).toEqual(["Ok.figma.tsx"]);
    expect(invalid).toEqual(["../evil"]);
  });

  it("a Figma name with a newline cannot break out of the comment", () => {
    const src = codeConnectSource("B", { figma: "Name\nprocess.exit(1) */" }, { component: "B", nodeId: "1:1" }, { fileKey: "K" });
    expect(src.split("\n").find((l) => l.includes("process.exit"))).toMatch(/^\/\/ Figma component: /);
  });

  it("exportCodeConnect writes nothing outside dir, and says which keys it skipped", async () => {
    const runOp = async (op: string): Promise<BridgeResponse> =>
      op === "get_document_info" ? ok({ fileKey: "K" }) : op === "get_components" ? ok({ components: [{ id: "1:1", name: "B" }] }) : ok({});
    const map = { components: { "../../escape": { figma: "B" }, Good: { figma: "B" } } };
    const res = await executeWrite(`return await figma.exportCodeConnect({ dir: ${JSON.stringify(dir)}, map: ${JSON.stringify(map)} });`, new SessionRegistry().get(), { runOp });
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(await readdir(dir)).toEqual(["Good.figma.tsx"]);
    expect(res.result).toMatchObject({ invalid: ["../../escape"] });
    expect(res.warnings.join("\n")).toMatch(/not code identifiers/);
  });
});

describe("Code Connect reader", () => {
  it("reads back what the writer writes, values with quotes, commas and colons included", () => {
    const map = { version: 1 as const, components: { Pill: { figma: "Pill", props: { tone: { figma: "Tone: main", type: "VARIANT" as const, values: { "it's": "It's, ok", "a:b": "A:B" } } } } } };
    const { files } = mapToCodeConnect(map, { Pill: "3:4" }, { fileKey: "K" });
    const { connections, skipped } = parseCodeConnect(files[0]!.source);
    expect(skipped).toEqual([]);
    expect(codeConnectToMap(connections, { "3:4": "Pill" }).map).toEqual(map);
  });

  it("accepts %3A node ids and proto/board URLs", () => {
    expect(parseConnectUrl("https://www.figma.com/design/ABC/x?node-id=1%3A2")).toEqual({ fileKey: "ABC", nodeId: "1:2" });
    expect(parseConnectUrl("https://www.figma.com/proto/ABC/x?node-id=10-20&t=1")).toEqual({ fileKey: "ABC", nodeId: "10:20" });
    expect(parseConnectUrl("https://www.figma.com/board/ABC/x?node-id=3-4")).toEqual({ fileKey: "ABC", nodeId: "3:4" });
  });

  it("notes the URL-first (HTML) form and unknown prop helpers instead of dropping them silently", () => {
    const { connections, skipped } = parseCodeConnect(`
      figma.connect("https://www.figma.com/design/ABC/x?node-id=1-1", { example: () => html\`<b/>\` })
      figma.connect(Card, "https://www.figma.com/design/ABC/x?node-id=2-2", { props: { cls: figma.className(["a"]), title: figma.string("Title") } })`);
    expect(connections.map((c) => c.component)).toEqual(["Card"]);
    expect(Object.keys(connections[0]!.props)).toEqual(["title"]);
    expect(skipped.join("\n")).toMatch(/names no code component/);
    expect(skipped.join("\n")).toMatch(/Card\.cls/);
  });

  it("several connections for one component (one per variant) are merged, not overwritten", () => {
    const { connections } = parseCodeConnect(`
      figma.connect(Btn, "https://www.figma.com/design/K/x?node-id=1-1", { props: { size: figma.enum("Size", { "Small": "sm" }) } })
      figma.connect(Btn, "https://www.figma.com/design/K/x?node-id=1-1", { props: { disabled: figma.boolean("Disabled") } })`);
    expect(Object.keys(codeConnectToMap(connections, { "1:1": "Btn" }).map.components.Btn!.props!).sort()).toEqual(["disabled", "size"]);
  });

  it("readCodeConnect({use:true}) with nothing usable keeps the session's map", async () => {
    const session = new SessionRegistry().get();
    (session.state as Record<string, unknown>).componentMap = { components: { Keep: { figma: "Keep" } } };
    const res = await executeWrite(`return await figma.readCodeConnect({ dir: ${JSON.stringify(dir)}, use: true });`, session, { runOp: async () => ok({ nodes: [] }) });
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect((session.state as { componentMap: { components: object } }).componentMap.components).toHaveProperty("Keep");
    expect(res.warnings.join("\n")).toMatch(/left as it was/);
  });
});

describe("sanitizeSvg (allowlist)", () => {
  it.each([
    ["<svg/onload=alert(1)><rect/></svg>", /onload/],
    ['<svg><a href=javascript:alert(1)><rect/></a></svg>', /javascript/],
    ['<svg><script href="x.js"/><rect/></svg>', /script/],
    ['<svg><set attributeName="href" to="javascript:x"/><rect/></svg>', /set|javascript/],
    ['<svg><animate attributeName="fill" values="red"/><rect/></svg>', /animate/],
    ['<svg><style>@import "http://evil/x.css";</style><rect/></svg>', /style|import|evil/],
    ['<svg><image href="https://evil/p.png"/><rect/></svg>', /image|evil/],
    ['<svg><rect fill="url(https://evil/p)" style="x"/></svg>', /evil|style/],
  ])("drops %s", (input, banned) => {
    const out = sanitizeSvg(input);
    expect(out).not.toMatch(banned);
    expect(out).toMatch(/^<svg[^>]*>.*<\/svg>$/s);
  });

  it("keeps a normal illustration intact (shapes, gradients, local refs)", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/><use href="#g"/></svg>';
    expect(sanitizeSvg(svg)).toBe(svg);
  });

  it("a reply cut off at max_tokens says so", async () => {
    const e = await generateSvg("x", {}, { anthropicApiKey: "k" }, async () => new Response(JSON.stringify({ stop_reason: "max_tokens", content: [{ type: "text", text: "<svg><rect/>" }] }), { status: 200 })).catch((x) => x);
    expect(e.message).toMatch(/cut off/);
  });

  it("NaN sizes fall back to defaults instead of reaching the prompt", async () => {
    let prompt = "";
    await generateSvg("x", { width: NaN, height: Infinity }, { anthropicApiKey: "k" }, async (_u, init) => {
      prompt = JSON.parse(String(init.body)).messages[0].content;
      return new Response(JSON.stringify({ content: [{ type: "text", text: "<svg></svg>" }] }), { status: 200 });
    });
    expect(prompt).toContain('viewBox="0 0 512 512"');
  });
});

describe("htmlToFigma opens any http(s) host (user decision D4, 2026-11-27)", () => {
  it("public, LAN and loopback URLs are all accepted; only non-http(s) schemes are refused", () => {
    for (const u of ["http://localhost:3000/", "https://example.com/", "http://192.168.1.20:8080/", "http://10.0.0.5/admin"]) {
      expect(checkCaptureUrl(u)).toBe(new URL(u).toString());
    }
    for (const u of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x"]) expect(() => checkCaptureUrl(u)).toThrow(/http\(s\)/);
  });

  function fakePlaywright(log: string[], opts: { launchFails?: boolean } = {}) {
    return async () => ({
      chromium: {
        launch: async () => {
          if (opts.launchFails) throw new Error("browserType.launch: Executable doesn't exist at /x/chrome\nmore");
          return {
            newPage: async () => ({
              route: async () => void log.push("route installed"),
              goto: async (u: string, o: { waitUntil: string }) => void log.push(`goto ${u} ${o.waitUntil}`),
              url: () => "https://cdn.example.com/elsewhere",
              waitForLoadState: async () => {
                throw new Error("Timeout 5000ms exceeded");
              },
              waitForTimeout: async () => {},
              evaluate: async () => ({ tag: "body", rect: { x: 0, y: 0, w: 10, h: 10 }, style: {}, children: [] }),
            }),
            close: async () => void log.push("close"),
          };
        },
      },
    });
  }

  it("nothing is intercepted: CDN fonts/CSS and redirects load as in a normal browser", async () => {
    const log: string[] = [];
    await capturePage("https://example.com/", {}, fakePlaywright(log) as never);
    expect(log).not.toContain("route installed");
    expect(log.find((l) => l.startsWith("goto"))).toMatch(/ load$/); // not networkidle (SSE pages never settle)
    expect(log.at(-1)).toBe("close");
  });

  it("Chromium missing: the hint is the install command", async () => {
    await expect(capturePage("http://localhost:3000/", {}, fakePlaywright([], { launchFails: true }) as never)).rejects.toMatchObject({ hint: expect.stringMatching(/npx playwright install chromium/) });
  });
});

describe("htmlToFigma conversion gaps", () => {
  const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
  it("row-reverse without a CSS gap: visual order AND a positive measured gap", () => {
    const { spec } = domToFigma({
      tag: "div", rect: box(0, 0, 300, 50), style: { display: "flex", flexDirection: "row-reverse" },
      children: [{ tag: "a", id: "first", rect: box(200, 0, 100, 50), style: {} }, { tag: "a", id: "second", rect: box(0, 0, 100, 50), style: {} }],
    });
    expect((spec.children as Array<{ name: string }>).map((c) => c.name)).toEqual(["a#second", "a#first"]);
    expect(spec.itemSpacing).toBe(100);
  });

  it("row-reverse keeps the visual order", () => {
    const { spec } = domToFigma({
      tag: "div", rect: box(0, 0, 300, 50), style: { display: "flex", flexDirection: "row-reverse", columnGap: "8px" },
      children: [{ tag: "a", id: "first", rect: box(200, 0, 100, 50), style: {} }, { tag: "a", id: "second", rect: box(0, 0, 100, 50), style: {} }],
    });
    expect((spec.children as Array<{ name: string }>).map((c) => c.name)).toEqual(["a#second", "a#first"]);
  });

  it("a container with an absolutely positioned child keeps absolute layout (and says so)", () => {
    const out = domToFigma({
      tag: "div", rect: box(0, 0, 200, 50), style: { display: "flex" },
      children: [{ tag: "span", rect: box(0, 0, 100, 50), style: {} }, { tag: "i", rect: box(180, 0, 20, 20), style: { position: "absolute" } }],
    });
    expect(out.spec.layoutMode).toBeUndefined();
    expect((out.spec.children as Array<{ x: number }>)[1]!.x).toBe(180);
    expect(out.warnings.join("\n")).toMatch(/absolutely positioned/);
  });

  it("an empty root warns instead of drawing a silent blank frame", () => {
    const out = domToFigma({ tag: "body", rect: box(0, 0, 1280, 0), style: {}, children: [] });
    expect(out.warnings[0]).toMatch(/has no size/);
  });

  it("colours the browser could not turn into rgb are reported", () => {
    const out = domToFigma({ tag: "div", rect: box(0, 0, 10, 10), style: { backgroundColor: "oklch(0.7 0.1 200)" }, children: [] });
    expect(out.warnings.join("\n")).toMatch(/oklch/);
  });

  it("weights 100 and 200 are Thin and Extra Light", () => {
    expect(fontStyle("100")).toBe("Thin");
    expect(fontStyle("200")).toBe("Extra Light");
  });
});


describe("htmlToFigma third pass", () => {
  it("the default layer name drops credentials, query and fragment", async () => {
    const { urlForName } = await import("../../src/server/executor.js");
    expect(urlForName("https://admin:s3cret@staging.example.com/app?token=abc#x")).toBe("https://staging.example.com/app");
  });

  it("a WRAPPED row-reverse sorts line by line (top, then left)", () => {
    const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
    const { spec } = domToFigma({
      tag: "div", rect: box(0, 0, 200, 100), style: { display: "flex", flexDirection: "row-reverse", flexWrap: "wrap" },
      children: [
        { tag: "i", id: "a", rect: box(100, 0, 100, 50), style: {} },
        { tag: "i", id: "b", rect: box(0, 0, 100, 50), style: {} },
        { tag: "i", id: "c", rect: box(100, 50, 100, 50), style: {} },
      ],
    });
    expect((spec.children as Array<{ name: string }>).map((c) => c.name)).toEqual(["i#b", "i#a", "i#c"]);
  });
});
