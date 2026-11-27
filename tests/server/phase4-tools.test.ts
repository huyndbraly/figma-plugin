import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesignIndex, itemsFromResult, scoreName } from "../../src/server/design-index.js";
import { handleRead, type ToolContext } from "../../src/server/tools.js";
import { capturePage, checkCaptureUrl } from "../../src/server/html-capture.js";
import { generateImage, generateSvg, loadByokConfig, sanitizeSvg } from "../../src/server/byok.js";
import { executeWrite } from "../../src/server/executor.js";
import { SessionRegistry } from "../../src/server/session.js";
import type { BridgeResponse } from "../../src/shared/protocol.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "figma-p4-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ok = (result: unknown): BridgeResponse => ({ id: "x", ok: true, result });

// ---------------------------------------------------------------------------
describe("local design index", () => {
  it("scores exact > last segment > prefix > contains > all words, ignoring accents", () => {
    expect(scoreName("DatePicker", "datepicker")).toBe(100);
    expect(scoreName("Forms/Date Picker", "date picker")).toBe(90);
    expect(scoreName("Date Picker Range", "date picker")).toBe(70);
    expect(scoreName("Nút bấm chính", "nut bam")).toBe(70);
    expect(scoreName("Card", "date")).toBe(0);
  });

  it("reads items out of every read shape it records", () => {
    expect(itemsFromResult("get_components", { components: [{ id: "1:1", name: "Button", type: "COMPONENT_SET", key: "k" }] })).toEqual([{ kind: "component_set", name: "Button", id: "1:1", key: "k", type: "COMPONENT_SET" }]);
    expect(itemsFromResult("get_styles", { paint: [{ id: "S:1", name: "Brand/Blue" }], text: [{ name: "H1" }] }).map((i) => [i.name, i.type])).toEqual([["Brand/Blue", "FILL"], ["H1", "TEXT"]]);
    expect(itemsFromResult("get_variables", { collections: [{ name: "Color", variables: [{ id: "V:1", name: "bg", resolvedType: "COLOR" }] }] })).toEqual([{ kind: "variable", name: "Color/bg", id: "V:1", type: "COLOR" }]);
  });

  it("a re-read of one kind replaces that kind only, and the folder is self-gitignored", async () => {
    const idx = new DesignIndex(dir);
    await idx.record({ fileKey: "A", fileName: "Lib", source: "plugin" }, [{ kind: "component", name: "Old" }, { kind: "style", name: "Blue" }]);
    await idx.record({ fileKey: "A", fileName: "Lib", source: "plugin" }, [{ kind: "component", name: "New" }]);
    const [f] = await idx.files();
    expect(f!.items.map((i) => i.name).sort()).toEqual(["Blue", "New"]);
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe("*\n");
  });

  it("searches across files", async () => {
    const idx = new DesignIndex(dir);
    await idx.record({ fileKey: "A", fileName: "Core UI", source: "plugin" }, [{ kind: "component", name: "Button" }, { kind: "component", name: "DatePicker", id: "9:1" }]);
    await idx.record({ fileKey: "B", fileName: "Marketing", source: "rest" }, [{ kind: "component", name: "Hero/DatePicker banner" }]);
    const r = await idx.search("datepicker");
    expect(r.hits.map((h) => [h.fileName, h.name])).toEqual([["Core UI", "DatePicker"], ["Marketing", "Hero/DatePicker banner"]]);
    expect(r.hits[0]).toMatchObject({ fileKey: "A", id: "9:1" });
    expect((await idx.search("button", { file: "Marketing" })).hits).toEqual([]);
  });

  function ctxWith(index: DesignIndex, plugin: (op: string, p: any) => unknown): ToolContext {
    return {
      runValidated: async (op, params) => {
        if (op === "list_channels") return [{ channel: "c", plugin: { fileName: "Core UI", fileKey: "A" } }];
        return plugin(op, params);
      },
      runWrite: async () => ({}),
      sessions: new SessionRegistry(),
      diagnostics: async () => ({}) as never,
      designIndex: index,
    };
  }

  it("figma_read get_components records into the index on the way through", async () => {
    const idx = new DesignIndex(dir);
    const ctx = ctxWith(idx, () => ({ components: [{ id: "1:1", name: "Tooltip", type: "COMPONENT" }] }));
    await handleRead(ctx, "get_components", {});
    await vi.waitFor(async () => expect((await idx.search("tooltip")).hits).toHaveLength(1));
    const out = (await handleRead(ctx, "search_design_index", { query: "tooltip" })) as any;
    expect(out.hits[0]).toMatchObject({ name: "Tooltip", fileName: "Core UI", fileKey: "A" });
  });

  it("index_design_file through REST indexes a file nobody has open", async () => {
    const idx = new DesignIndex(dir);
    const ctx = ctxWith(idx, () => {
      throw new Error("no plugin");
    });
    ctx.rest = {
      token: "figd_test_token_000",
      fetch: async (url) => {
        const path = new URL(url).pathname;
        const body =
          path === "/v1/files/Z" ? { name: "Remote Lib", document: { children: [] } }
          : path === "/v1/files/Z/component_sets" ? { meta: { component_sets: [{ node_id: "3:0", name: "Stepper" }] } }
          : path === "/v1/files/Z/styles" ? { meta: { styles: [{ node_id: "5:1", name: "Surface", style_type: "FILL" }] } }
          : path === "/v1/files/Z/nodes" ? { nodes: {} }
          : { meta: {} };
        return new Response(JSON.stringify(body), { status: 200 });
      },
    };
    const out = (await handleRead(ctx, "index_design_file", { fileKey: "Z" })) as any;
    expect(out).toMatchObject({ fileKey: "Z", fileName: "Remote Lib", indexed: 2, source: "rest" });
    expect((await idx.search("stepper")).hits[0]).toMatchObject({ fileKey: "Z", kind: "component_set" });
  });

  it("is off when FIGMA_CACHE=off", () => {
    const prev = process.env.FIGMA_CACHE;
    process.env.FIGMA_CACHE = "off";
    try {
      expect(DesignIndex.fromEnv()).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.FIGMA_CACHE;
      else process.env.FIGMA_CACHE = prev;
    }
  });
});

// ---------------------------------------------------------------------------
describe("htmlToFigma", () => {
  it("opens only http(s) pages", () => {
    expect(checkCaptureUrl("http://localhost:3000/a")).toBe("http://localhost:3000/a");
    expect(() => checkCaptureUrl("file:///etc/passwd")).toThrow(/http\(s\)/);
    expect(() => checkCaptureUrl("javascript:alert(1)")).toThrow();
  });

  it("without Playwright, says the two commands that install it", async () => {
    await expect(capturePage("http://localhost:3000", {}, async () => { throw new Error("Cannot find module"); })).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      hint: expect.stringMatching(/npm i -D playwright && npx playwright install chromium/),
    });
  });

  const TREE = {
    tag: "body",
    rect: { x: 0, y: 0, w: 320, h: 100 },
    style: { display: "flex", flexDirection: "column", rowGap: "8px", backgroundColor: "rgb(250, 250, 250)" },
    children: [{ tag: "#text", text: "Hi", rect: { x: 0, y: 0, w: 20, h: 16 }, style: { fontSize: "16px", color: "rgb(0, 0, 0)" } }],
  };
  const fakeLoader = (seen: any[]) => async () => ({
    chromium: {
      launch: async () => ({
        newPage: async (o: unknown) => {
          seen.push(["newPage", o]);
          return {
            goto: async (u: string, o2: unknown) => seen.push(["goto", u, o2]),
            waitForTimeout: async () => {},
            evaluate: async (_fn: unknown, arg: unknown) => {
              seen.push(["evaluate", arg]);
              return TREE;
            },
          };
        },
        close: async () => seen.push(["close"]),
      }),
    },
  });

  it("figma.htmlToFigma captures, converts and creates ONE auto-layout tree", async () => {
    const seen: any[] = [];
    const created: any[] = [];
    const res = await executeWrite(
      `return await figma.htmlToFigma("http://localhost:3000/settings", { width: 390, selector: "main", parentId: "1:1", name: "Settings" });`,
      new SessionRegistry().get(),
      {
        runOp: async (op, params) => {
          if (op === "create") {
            created.push(params);
            return ok({ id: "50:1" });
          }
          return ok({});
        },
        playwrightLoader: fakeLoader(seen) as never,
      },
    );
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(seen[0]).toEqual(["newPage", { viewport: { width: 390, height: 800 } }]);
    expect(seen.find((s) => s[0] === "evaluate")[1]).toMatchObject({ selector: "main" });
    expect(seen.at(-1)).toEqual(["close"]);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ type: "FRAME", name: "Settings", parentId: "1:1", layoutMode: "VERTICAL", itemSpacing: 8, fill: "#fafafa" });
    expect(created[0].children[0]).toMatchObject({ type: "TEXT", characters: "Hi" });
    expect(res.result).toMatchObject({ id: "50:1", nodes: 2, dropped: 0 });
  });
});

// ---------------------------------------------------------------------------
describe("BYOK generation", () => {
  const KEY = "sk-test-SECRET-key-123456";

  it("env beats the config file, and the FIGMA_MCP_ prefix beats the generic name", async () => {
    const cfgPath = join(dir, "byok.json");
    await writeFile(cfgPath, JSON.stringify({ openaiApiKey: "from-file", anthropicApiKey: "a-file", svgModel: "m-file" }));
    const cfg = loadByokConfig({ FIGMA_MCP_BYOK_CONFIG: cfgPath, OPENAI_API_KEY: "generic", FIGMA_MCP_OPENAI_API_KEY: "prefixed" } as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({ openaiApiKey: "prefixed", anthropicApiKey: "a-file", svgModel: "m-file", imageModel: "gpt-image-1" });
  });

  it("no key: the error names the variable, never a value", async () => {
    const e = await generateImage("a cat", {}, {}).catch((x) => x);
    expect(e).toMatchObject({ code: "UNAUTHORIZED", hint: expect.stringMatching(/OPENAI_API_KEY/) });
  });

  it("an image request carries the key only as the Authorization header", async () => {
    const seen: any[] = [];
    const out = await generateImage("a cat", { size: "1536x1024" }, { openaiApiKey: KEY, imageModel: "gpt-image-1" }, async (url, init) => {
      seen.push({ url, headers: init.headers, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ data: [{ b64_json: "AAAA" }] }), { status: 200 });
    });
    expect(out).toEqual({ base64: "AAAA", model: "gpt-image-1", size: "1536x1024" });
    expect(seen[0].url).toBe("https://api.openai.com/v1/images/generations");
    expect(seen[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(seen[0].body)).not.toContain(KEY);
  });

  it("a refused key's error does not echo the key", async () => {
    const e = await generateImage("x", {}, { openaiApiKey: KEY }, async () => new Response("bad key " + KEY, { status: 401 })).catch((x) => x);
    expect(e.code).toBe("UNAUTHORIZED");
    expect(`${e.message} ${e.hint}`).not.toContain(KEY);
  });

  it("SVG output is made inert: no scripts, handlers, foreignObject or external refs", () => {
    const svg = sanitizeSvg(`Here you go:\n<svg viewBox="0 0 10 10" onload="x()"><script>alert(1)</script><foreignObject><div/></foreignObject><image href="https://evil/x.png"/><use href="#a"/><rect fill="url(https://evil/p)" onclick='y()'/></svg> done`);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).not.toMatch(/script|onload|onclick|foreignObject|evil/);
    expect(svg).toContain('href="#a"');
  });

  it("generateSvg asks Anthropic with x-api-key and returns the sanitized markup", async () => {
    let req: any;
    const out = await generateSvg("a logo", { width: 64, height: 64 }, { anthropicApiKey: KEY, svgModel: "claude-sonnet-5-5" }, async (url, init) => {
      req = { url, headers: init.headers, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ content: [{ type: "text", text: '<svg width="64" height="64"><circle r="4" onmouseover="z()"/></svg>' }] }), { status: 200 });
    });
    expect(req.url).toBe("https://api.anthropic.com/v1/messages");
    expect(req.headers["x-api-key"]).toBe(KEY);
    expect(req.body.model).toBe("claude-sonnet-5-5");
    expect(req.body.messages[0].content).toContain('viewBox="0 0 64 64"');
    expect(out.svg).toBe('<svg width="64" height="64"><circle r="4"/></svg>');
  });

  it("figma.generateImage places the bytes with load_image; generateSvg creates an ICON", async () => {
    const calls: Array<[string, any]> = [];
    const res = await executeWrite(
      `const a = await figma.generateImage("hero", { parentId: "1:1", w: 300, size: "1024x1024" });
       const b = await figma.generateSvg("badge", { parentId: "1:1", x: 10 });
       return { a, b };`,
      new SessionRegistry().get(),
      {
        runOp: async (op, params) => {
          calls.push([op, params]);
          return ok({ id: op === "load_image" ? "7:1" : "7:2" });
        },
        byok: { openaiApiKey: KEY, anthropicApiKey: KEY },
        aiFetch: async (url) =>
          new Response(JSON.stringify(url.includes("openai") ? { data: [{ b64_json: "QUJD" }] } : { content: [{ type: "text", text: "<svg><rect/></svg>" }] }), { status: 200 }),
      },
    );
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(calls[0]).toEqual(["load_image", { base64: "QUJD", name: "hero", parentId: "1:1", w: 300 }]);
    expect(calls[1]![1]).toMatchObject({ type: "ICON", svg: "<svg><rect/></svg>", parentId: "1:1", x: 10 });
    expect(JSON.stringify(res)).not.toContain(KEY);
  });
});

// ---------------------------------------------------------------------------
describe("Code Connect files from figma_write", () => {
  const MAP = { components: { Button: { figma: "Button", props: { size: { figma: "Size", type: "VARIANT", values: { sm: "Small" } } } }, Ghost: { figma: "Ghost" } } };
  const runOp = async (op: string, params: any): Promise<BridgeResponse> => {
    if (op === "get_document_info") return ok({ fileKey: "KEY" });
    if (op === "get_components") return ok({ components: [{ id: "1:5", name: "Button", type: "COMPONENT" }, { id: "1:4", name: "Button", type: "COMPONENT_SET" }] });
    if (op === "get_nodes") return ok({ nodes: params.nodeIds.map((id: string) => ({ id, name: id === "1:4" ? "Button" : "?" })) });
    return ok({});
  };

  it("exportCodeConnect writes one file per mapped component, pointing at the SET, and keeps existing files", async () => {
    await writeFile(join(dir, "Keep.figma.tsx"), "x");
    const res = await executeWrite(`return await figma.exportCodeConnect({ dir: ${JSON.stringify(dir)}, map: ${JSON.stringify(MAP)}, importFrom: "@/ui" });`, new SessionRegistry().get(), { runOp });
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(res.result).toMatchObject({ written: [join(dir, "Button.figma.tsx")], missing: ["Ghost"], fileKey: "KEY" });
    const src = await readFile(join(dir, "Button.figma.tsx"), "utf8");
    expect(src).toContain("node-id=1-4");
    const again = await executeWrite(`return await figma.exportCodeConnect({ dir: ${JSON.stringify(dir)}, map: ${JSON.stringify(MAP)} });`, new SessionRegistry().get(), { runOp });
    expect(again.result).toMatchObject({ written: [], skipped: [join(dir, "Button.figma.tsx")] });
  });

  it("refuses a relative dir", async () => {
    const res = await executeWrite(`return await figma.exportCodeConnect({ dir: "src/figma", map: ${JSON.stringify(MAP)} });`, new SessionRegistry().get(), { runOp });
    expect(res.error).toMatchObject({ code: "INVALID_PARAMS", message: expect.stringMatching(/absolute/) });
  });

  it("readCodeConnect finds .figma.tsx files (not node_modules) and rebuilds the map, use:true loads it", async () => {
    await executeWrite(`return await figma.exportCodeConnect({ dir: ${JSON.stringify(join(dir, "src"))}, map: ${JSON.stringify(MAP)} });`, new SessionRegistry().get(), { runOp });
    await mkdir(join(dir, "node_modules", "x"), { recursive: true });
    await writeFile(join(dir, "node_modules", "x", "Y.figma.tsx"), 'figma.connect(Y, "https://www.figma.com/design/KEY/?node-id=9-9", {})');
    const session = new SessionRegistry().get();
    const res = await executeWrite(`return await figma.readCodeConnect({ dir: ${JSON.stringify(dir)}, use: true });`, session, { runOp });
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(res.result).toMatchObject({ files: 1, connections: 1, unresolved: [] });
    expect((res.result as any).map.components.Button).toEqual({ figma: "Button", props: { size: { figma: "Size", type: "VARIANT", values: { sm: "Small" } } } });
    expect((session.state as any).componentMap.components.Button.figma).toBe("Button");
    expect(await readdir(join(dir, "src"))).toEqual(["Button.figma.tsx"]);
  });
});
