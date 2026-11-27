import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileNameKey, parseFigmaLink } from "../../src/shared/figma-url.js";
import { compactTree } from "../../src/server/rest-read.js";
import { handleRead, setLinkWindowGraceMs, type ToolContext } from "../../src/server/tools.js";
import { executeWrite } from "../../src/server/executor.js";
import { SessionRegistry } from "../../src/server/session.js";
import type { AnyOperation, BridgeResponse } from "../../src/shared/protocol.js";

const LINK = "https://www.figma.com/design/AbC123xyz/Glass-Liquid---ArtMate-IOS-Copy?node-id=12-345&t=abc-0";

describe("parseFigmaLink", () => {
  it("reads the file key, the node id and the name slug", () => {
    expect(parseFigmaLink(LINK)).toEqual({ fileKey: "AbC123xyz", nodeId: "12:345", slug: "Glass-Liquid---ArtMate-IOS-Copy" });
    expect(parseFigmaLink("https://www.figma.com/file/K1/x?node-id=1%3A2")?.nodeId).toBe("1:2");
    expect(parseFigmaLink("https://www.figma.com/design/K1/branch/B2/x")?.fileKey).toBe("B2");
    expect(parseFigmaLink("https://www.figma.com/design/K1/x?node-id=I1-2;3-4")?.nodeId).toBe("I1:2;3:4");
    expect(parseFigmaLink("https://evil.com/design/K1/x")).toBeNull();
    expect(parseFigmaLink("not a link")).toBeNull();
  });

  it("matches a link's slug to a window's file name", () => {
    expect(fileNameKey("Glass-Liquid---ArtMate-IOS-Copy")).toBe(fileNameKey("Glass Liquid - ArtMate IOS (Copy)"));
    expect(fileNameKey("Thiết-kế")).toBe(fileNameKey("Thiết kế"));
  });
});

const REST_NODE = {
  id: "12:345",
  name: "Home",
  type: "FRAME",
  absoluteBoundingBox: { x: 1000, y: 500, width: 402, height: 874 },
  absoluteRenderBounds: { x: 1000, y: 500, width: 402, height: 874 },
  blendMode: "PASS_THROUGH",
  constraints: { vertical: "TOP", horizontal: "LEFT" },
  fills: [{ type: "SOLID", visible: true, opacity: 1, blendMode: "NORMAL", color: { r: 1, g: 1, b: 1, a: 1 } }],
  strokes: [],
  layoutMode: "VERTICAL",
  itemSpacing: 12,
  paddingLeft: 16,
  paddingRight: 16,
  paddingTop: 0,
  paddingBottom: 0,
  children: [
    {
      id: "12:346",
      name: "Title",
      type: "TEXT",
      absoluteBoundingBox: { x: 1016, y: 520, width: 200, height: 26 },
      characters: "Gallery",
      style: { fontFamily: "Inter", fontWeight: 700, fontSize: 20, lineHeightPx: 26, letterSpacing: 0, textAlignHorizontal: "LEFT" },
      fills: [{ type: "SOLID", color: { r: 0, g: 0.06, b: 0.13, a: 1 } }],
      styles: { text: "S:1" },
    },
    {
      id: "12:347",
      name: "Button",
      type: "INSTANCE",
      componentId: "9:1",
      absoluteBoundingBox: { x: 1016, y: 560, width: 120, height: 44 },
      fills: [],
    },
  ],
};

describe("compactTree (REST → the plugin's shape)", () => {
  it("drops REST noise, makes x/y parent-relative and colours hex", () => {
    const t = compactTree(REST_NODE, "compact", 2, 100, { "9:1": { name: "Button/Primary" } });
    expect(t.tree).toMatchObject({ id: "12:345", type: "FRAME", x: 1000, y: 500, w: 402, h: 874, fill: "#ffffff", layoutMode: "VERTICAL", itemSpacing: 12, childCount: 2 });
    expect(t.tree).not.toHaveProperty("absoluteRenderBounds");
    expect(t.tree).not.toHaveProperty("blendMode");
    const [title, btn] = t.tree.children as Array<Record<string, unknown>>;
    expect(title).toMatchObject({ x: 16, y: 20, characters: "Gallery", fontSize: 20, fill: "#000f21" });
    expect(btn).toMatchObject({ component: "Button/Primary", componentId: "9:1" });
    // Far smaller than the raw node.
    expect(JSON.stringify(t.tree).length).toBeLessThan(JSON.stringify(REST_NODE).length * 0.7);
  });

  it("adds typography and style names at design detail, and caps the node count", () => {
    const d = compactTree(REST_NODE, "design", 2, 100, {}, { "S:1": { name: "heading/20" } });
    expect((d.tree.children as Array<Record<string, unknown>>)[0]).toMatchObject({ typography: { fontFamily: "Inter", fontWeight: 700, fontSize: 20, lineHeight: 26 }, styles: { text: "heading/20" } });
    const capped = compactTree(REST_NODE, "sparse", 2, 2);
    expect(capped.truncated).toBe(true);
    expect(capped.tree.childrenTruncated).toBe(true);
  });
});

function ctxWith(channels: Array<{ channel: string; fileName: string }>, rest?: ToolContext["rest"]) {
  const calls: Array<{ op: string; params: Record<string, unknown>; route: unknown }> = [];
  const ctx = {
    runValidated: async (op: string, params: Record<string, unknown>, _s?: string, route?: unknown) => {
      calls.push({ op, params, route });
      if (op === "list_channels") return channels.map((c) => ({ channel: c.channel, plugin: { fileName: c.fileName } }));
      return { via: "plugin", op, params };
    },
    runWrite: async () => null,
    sessions: new SessionRegistry(),
    diagnostics: async () => ({}) as never,
    ...(rest ? { rest } : {}),
  } as unknown as ToolContext;
  return { ctx, calls };
}

describe("figma_read with a link", () => {
  it("goes through the plugin when the linked file is open, with the node from the link", async () => {
    const { ctx, calls } = ctxWith([
      { channel: "a", fileName: "Other file" },
      { channel: "b", fileName: "Glass Liquid - ArtMate IOS (Copy)" },
    ]);
    const res = (await handleRead(ctx, "get_design_context", { url: LINK, detail: "compact" })) as Record<string, unknown>;
    expect(res.via).toBe("plugin");
    const call = calls.find((c) => c.op === "get_design_context")!;
    expect(call.params).toEqual({ nodeId: "12:345", detail: "compact" });
    expect(call.route).toMatchObject({ channel: "b" });
  });

  it("falls back to REST when the file is not open, in the compact shape", async () => {
    const urls: string[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      urls.push(url);
      expect((init.headers as Record<string, string>)["X-Figma-Token"]).toBe("tok");
      return Response.json({ nodes: { "12:345": { document: REST_NODE, components: { "9:1": { name: "Button/Primary" } }, styles: {} } } });
    };
    const { ctx, calls } = ctxWith([{ channel: "a", fileName: "Other file" }], { token: "tok", fetch: fetchImpl });
    const res = (await handleRead(ctx, "get_design_context", { url: LINK })) as Record<string, unknown>;
    expect(res.source).toBe("rest");
    expect((res.tree as Record<string, unknown>).fill).toBe("#ffffff");
    expect(urls[0]).toContain("/files/AbC123xyz/nodes?ids=12%3A345");
    expect(calls.some((c) => c.op === "get_design_context")).toBe(false);
  });

  it("renders a screenshot through REST as an image result", async () => {
    const fetchImpl = async (url: string) =>
      url.includes("/images/")
        ? Response.json({ err: null, images: { "12:345": "https://cdn.example.com/x.png" } })
        : Response.json({ nodes: { "12:345": { document: REST_NODE } } });
    const { ctx } = ctxWith([], { token: "tok", fetch: fetchImpl, download: async () => new Uint8Array([137, 80, 78, 71]) });
    const res = (await handleRead(ctx, "screenshot", { url: LINK })) as Record<string, unknown>;
    expect(res).toMatchObject({ format: "PNG", nodeId: "12:345", source: "rest" });
    expect(typeof res.base64).toBe("string");
  });

  it("waits for the linked file's window to come back when there is no token", async () => {
    setLinkWindowGraceMs(3000);
    const channels: Array<{ channel: string; fileName: string }> = [];
    const { ctx, calls } = ctxWith(channels, { token: "" });
    setTimeout(() => channels.push({ channel: "back", fileName: "Glass Liquid - ArtMate IOS (Copy)" }), 700);
    const res = (await handleRead(ctx, "get_node", { url: LINK })) as Record<string, unknown>;
    expect(res.via).toBe("plugin");
    expect(calls.find((c) => c.op === "get_node")!.route).toMatchObject({ channel: "back" });
  });

  it("says how to get there when neither the window nor a token is available", async () => {
    setLinkWindowGraceMs(600);
    const { ctx } = ctxWith([{ channel: "a", fileName: "Other file" }], { token: "" });
    await expect(handleRead(ctx, "get_node", { url: LINK })).rejects.toMatchObject({ code: "NOT_CONNECTED", hint: expect.stringMatching(/FIGMA_TOKEN/) });
    await expect(handleRead(ctx, "get_node", { url: "https://example.com/x" })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });

  it("names the ops REST cannot answer", async () => {
    const { ctx } = ctxWith([], { token: "tok", fetch: async () => Response.json({}) });
    await expect(handleRead(ctx, "layout_audit", { url: LINK })).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
  });
});

describe("figma.exportAssets with a link", () => {
  function runner(fileName: string) {
    const calls: string[] = [];
    const runOp = async (op: AnyOperation, params: Record<string, unknown>): Promise<BridgeResponse> => {
      calls.push(op);
      const ok = (result: unknown): BridgeResponse => ({ id: "x", ok: true, result });
      if (op === "list_channels") return ok([{ channel: "c" }]);
      if (op === "get_document_info") return ok({ fileName });
      if (op === "get_nodes") return ok({ nodes: [{ id: params.nodeIds && (params.nodeIds as string[])[0], name: "Hero" }] });
      if (op === "export_node") return ok({ base64: Buffer.from("png").toString("base64") });
      return ok(null);
    };
    return { runOp, calls };
  }

  it("exports through the plugin when this call's window is the linked file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "figma-plugin-link-"));
    try {
      const r = runner("Glass Liquid - ArtMate IOS (Copy)");
      const res = await executeWrite(`return await figma.exportAssets(${JSON.stringify(LINK)}, { dir: ${JSON.stringify(dir)} });`, new SessionRegistry().get(), { runOp: r.runOp });
      expect(res.ok, JSON.stringify(res.error)).toBe(true);
      expect(await readdir(dir)).toEqual(["hero.png"]);
      expect(r.calls).toContain("export_node");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not export a same-id node from a DIFFERENT open file", async () => {
    const r = runner("Some other file");
    const res = await executeWrite(`return await figma.exportAssets(${JSON.stringify(LINK)}, { dir: "/tmp/never-written" });`, new SessionRegistry().get(), { runOp: r.runOp, figmaToken: "" });
    expect(res.error?.code).toBe("NOT_CONNECTED");
    expect(r.calls).not.toContain("export_node");
  });
});

describe("motion of a closed file (REST interactions, transition duration in ms)", () => {
  const interactions = [
    {
      trigger: { type: "ON_HOVER" },
      actions: [{ type: "NODE", destinationId: "4:2", navigation: "CHANGE_TO", transition: { type: "SMART_ANIMATE", duration: 300, easing: { type: "EASE_OUT" } } }],
    },
  ];

  it("the REST compactor adds motion at full/design detail only", async () => {
    const { compactTree } = await import("../../src/server/rest-read.js");
    const node = { id: "1:1", name: "Card", type: "FRAME", absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 }, interactions };
    expect(compactTree(node, "compact", 0, 10).tree.motion).toBeUndefined();
    const full = compactTree(node, "full", 0, 10).tree.motion as Array<{ actions: Array<{ transition: { duration: number } }> }>;
    expect(full[0]!.actions[0]!.transition.duration).toBe(0.3);
    expect(compactTree({ ...node, interactions: [] }, "design", 0, 10).tree.motion).toBeUndefined();
  });
});
