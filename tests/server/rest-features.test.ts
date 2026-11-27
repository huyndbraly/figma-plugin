import { describe, expect, it } from "vitest";
import { handleRead, type ToolContext } from "../../src/server/tools.js";
import { threadComments, compactVersions, postComment, restDesignKit } from "../../src/server/rest-features.js";
import { RestClient } from "../../src/server/rest-read.js";
import { executeWrite } from "../../src/server/executor.js";
import { SessionRegistry } from "../../src/server/session.js";
import { TOOLS } from "../../src/server/index.js";
import type { BridgeResponse } from "../../src/shared/protocol.js";

/**
 * Comments, versions and design.md through the REST API — the features that
 * either have no Plugin API (comments, versions) or must work with the file
 * closed. Each test asserts what reached the WIRE (path, method, body), not
 * only the value handed back, because a request built wrong still returns
 * whatever the fake answers.
 */

const FILE = "AbC123xyz";
const LINK = `https://www.figma.com/design/${FILE}/Shop?node-id=12-345`;

interface Seen {
  url: string;
  method: string;
  body?: unknown;
}

function figmaApi(routes: Record<string, unknown | ((s: Seen) => Response)>) {
  const seen: Seen[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const s: Seen = { url, method: (init.method ?? "GET").toUpperCase(), ...(typeof init.body === "string" ? { body: JSON.parse(init.body) } : {}) };
    seen.push(s);
    const path = new URL(url).pathname.replace(/^\/v1/, "");
    const key = Object.keys(routes).find((k) => (k.includes(" ") ? k === `${s.method} ${path}` : k === path));
    if (!key) return new Response(JSON.stringify({ err: "nope" }), { status: 404 });
    const r = routes[key];
    return typeof r === "function" ? (r as (s: Seen) => Response)(s) : new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { seen, fetch };
}

const COMMENTS = {
  comments: [
    { id: "1", message: "Spacing is off", user: { handle: "ana" }, created_at: "2026-11-01T10:00:00Z", client_meta: { node_id: "12:345", node_offset: { x: 1, y: 2 } } },
    { id: "2", message: "Agreed", parent_id: "1", user: { handle: "bo" }, created_at: "2026-11-01T11:00:00Z" },
    { id: "3", message: "Old", user: { handle: "cy" }, created_at: "2026-10-01T10:00:00Z", resolved_at: "2026-10-02T00:00:00Z", client_meta: { x: 5, y: 6 } },
  ],
};

function ctx(api: ReturnType<typeof figmaApi>, channels: unknown[] = []): ToolContext {
  return {
    runValidated: async (op) => {
      if (op === "list_channels") return channels;
      throw new Error(`unexpected plugin op ${op}`);
    },
    runWrite: async () => ({}),
    sessions: new SessionRegistry(),
    diagnostics: async () => ({}) as never,
    rest: { token: "figd_test_token_1234", fetch: api.fetch, download: async () => new Uint8Array() },
  };
}

describe("comments", () => {
  it("threads replies under their root, newest thread first, author handles only", () => {
    const t = threadComments(COMMENTS);
    expect(t.total).toBe(2);
    expect(t.threads[0]).toEqual({
      id: "1",
      message: "Spacing is off",
      author: "ana",
      createdAt: "2026-11-01T10:00:00Z",
      nodeId: "12:345",
      replies: [{ id: "2", message: "Agreed", author: "bo", createdAt: "2026-11-01T11:00:00Z" }],
    });
  });

  it("filters to one node and to unresolved threads", () => {
    expect(threadComments(COMMENTS, { nodeId: "12:345" }).threads.map((t) => t.id)).toEqual(["1"]);
    expect(threadComments(COMMENTS, { unresolved: true }).threads.map((t) => t.id)).toEqual(["1"]);
    expect(threadComments(COMMENTS, { limit: 1 })).toMatchObject({ total: 2, returned: 1 });
  });

  it("figma_read get_comments takes the file from a link; the link's node-id is reported, NOT applied as a filter", async () => {
    const api = figmaApi({ [`/files/${FILE}/comments`]: COMMENTS });
    const out = (await handleRead(ctx(api), "get_comments", { url: LINK })) as { fileKey: string; threads: Array<{ id: string }>; linkNodeId?: string; hint?: string };
    expect(out.fileKey).toBe(FILE);
    // A copied link nearly always carries a node-id; filtering on it returned 0 threads for "this file".
    expect(out.threads.map((t) => t.id)).toEqual(["1", "3"]);
    expect(out.linkNodeId).toBe("12:345");
    expect(out.hint).toMatch(/nodeId: "12:345"/);
    expect(api.seen[0]).toMatchObject({ method: "GET", url: `https://api.figma.com/v1/files/${FILE}/comments` });
  });

  it("an explicit nodeId filters, and says so", async () => {
    const api = figmaApi({ [`/files/${FILE}/comments`]: COMMENTS });
    const out = (await handleRead(ctx(api), "get_comments", { url: LINK, nodeId: "12:345" })) as { threads: Array<{ id: string }>; nodeFilter?: string };
    expect(out.threads.map((t) => t.id)).toEqual(["1"]);
    expect(out.nodeFilter).toBe("12:345");
  });

  it("is never served from the read cache — comments change while people talk", async () => {
    const api = figmaApi({ [`/files/${FILE}/comments`]: COMMENTS });
    const c = ctx(api);
    await handleRead(c, "get_comments", { fileKey: FILE });
    await handleRead(c, "get_comments", { fileKey: FILE });
    expect(api.seen.filter((s) => s.url.endsWith("/comments"))).toHaveLength(2);
  });

  it("uses the open window's own file key when no file is named", async () => {
    const api = figmaApi({ [`/files/${FILE}/comments`]: COMMENTS });
    const out = (await handleRead(ctx(api, [{ channel: "c1", plugin: { fileKey: FILE, fileName: "Shop" } }]), "get_comments", {})) as { fileKey: string };
    expect(out.fileKey).toBe(FILE);
  });

  it("asks for the file when there is nothing to go on", async () => {
    const api = figmaApi({});
    await expect(handleRead(ctx(api), "get_comments", {})).rejects.toMatchObject({ code: "INVALID_PARAMS", hint: expect.stringMatching(/fileKey/) });
  });

  it("with no token says where the user puts one", async () => {
    const c = ctx(figmaApi({}));
    c.rest = { token: "" };
    await expect(handleRead(c, "get_comments", { fileKey: FILE })).rejects.toMatchObject({ code: "UNAUTHORIZED", hint: expect.stringMatching(/plugin panel/) });
  });
});

describe("postComment", () => {
  it("pins a new thread to a node at an offset", async () => {
    const api = figmaApi({ [`POST /files/${FILE}/comments`]: { id: "9", message: "Hi", user: { handle: "me" }, client_meta: { node_id: "1:2" } } });
    const out = await postComment(api.fetch, FILE, { message: " Hi ", nodeId: "1:2", x: 4, y: 8 });
    expect(api.seen[0]).toMatchObject({ method: "POST", body: { message: "Hi", client_meta: { node_id: "1:2", node_offset: { x: 4, y: 8 } } } });
    expect(out).toMatchObject({ id: "9", author: "me", fileKey: FILE });
  });

  it("a reply carries comment_id and no position", async () => {
    const api = figmaApi({ [`POST /files/${FILE}/comments`]: { id: "10", message: "ok" } });
    await postComment(api.fetch, FILE, { message: "ok", replyTo: "1", nodeId: "1:2" });
    expect(api.seen[0]!.body).toEqual({ message: "ok", comment_id: "1" });
  });

  it("a 403 explains the scope the token is missing", async () => {
    // Figma's real missing-scope answer (shape measured against the live API).
    const body = JSON.stringify({ error: true, status: 403, message: 'Invalid scope: ["current_user:read", "file_comments:read"]. This endpoint requires the file_comments:write scope.' });
    const api = figmaApi({ [`POST /files/${FILE}/comments`]: () => new Response(body, { status: 403 }) });
    await expect(postComment(api.fetch, FILE, { message: "x" })).rejects.toMatchObject({ code: "UNAUTHORIZED", hint: expect.stringMatching(/file_comments:write/) });
  });

  it("refuses an empty message without a request", async () => {
    const api = figmaApi({});
    await expect(postComment(api.fetch, FILE, { message: "  " })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    expect(api.seen).toHaveLength(0);
  });

  it("is callable from figma_write as figma.postComment / getComments / getVersions", async () => {
    const api = figmaApi({
      [`POST /files/${FILE}/comments`]: { id: "11", message: "from agent" },
      [`/files/${FILE}/comments`]: COMMENTS,
      [`/files/${FILE}/versions`]: { versions: [{ id: "v1", label: "Release", created_at: "2026-11-02T00:00:00Z", user: { handle: "ana" } }] },
    });
    const runOp = async (op: string): Promise<BridgeResponse> => {
      if (op === "get_document_info") return { id: "x", ok: true, result: { fileKey: FILE } };
      return { id: "x", ok: false, error: { code: "INTERNAL" as never, message: `unexpected ${op}` } };
    };
    const res = await executeWrite(
      `const c = await figma.postComment({ message: "from agent", nodeId: "12:345" });
       const t = await figma.getComments({ unresolved: true });
       const v = await figma.getVersions({ url: ${JSON.stringify(LINK)} });
       return { c: c.id, threads: t.threads.length, v: v.versions[0].label };`,
      new SessionRegistry().get(),
      { runOp, restFetch: api.fetch },
    );
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(res.result).toEqual({ c: "11", threads: 1, v: "Release" });
    expect(api.seen[0]).toMatchObject({ method: "POST", body: { message: "from agent", client_meta: { node_id: "12:345" } } });
  });
});

describe("versions", () => {
  it("compacts to id / label / description / date / author", () => {
    const out = compactVersions({ versions: [{ id: "1", label: "", description: "", created_at: "d", user: { handle: "a", img_url: "x" } }], pagination: { next_page: "u" } });
    expect(out).toEqual({ versions: [{ id: "1", createdAt: "d", author: "a" }], returned: 1, hasMore: true });
  });

  it("figma_read get_versions, namedOnly keeps labelled versions", async () => {
    const api = figmaApi({
      [`/files/${FILE}/versions`]: { versions: [{ id: "a", label: "", created_at: "3" }, { id: "b", label: "v2.0", created_at: "2" }, { id: "c", label: "v1.0", created_at: "1" }] },
    });
    const out = (await handleRead(ctx(api), "get_versions", { fileKey: FILE, namedOnly: true, limit: 1 })) as { versions: Array<{ id: string }> };
    expect(out.versions.map((v) => v.id)).toEqual(["b"]);
  });
});

describe("reading a file that is not open", () => {
  const FILE_JSON = {
    name: "Shop UI",
    document: {
      children: [
        { id: "0:1", name: "Screens", type: "CANVAS", children: [{ id: "1:1", name: "Home", type: "FRAME", absoluteBoundingBox: { x: 0, y: 0, width: 390, height: 844 }, layoutMode: "VERTICAL" }] },
      ],
    },
    styles: {},
    components: {},
  };
  const api = () =>
    figmaApi({
      [`/files/${FILE}`]: FILE_JSON,
      [`/files/${FILE}/styles`]: { meta: { styles: [{ node_id: "5:1", name: "Brand/Primary", style_type: "FILL", description: "CTA" }, { node_id: "5:2", name: "Heading/H1", style_type: "TEXT" }] } },
      [`/files/${FILE}/nodes`]: {
        nodes: {
          "5:1": { document: { id: "5:1", fills: [{ type: "SOLID", color: { r: 0.15, g: 0.39, b: 0.92, a: 1 } }] } },
          "5:2": { document: { id: "5:2", style: { fontFamily: "Inter", fontWeight: 700, fontSize: 32, lineHeightPx: 40 } } },
        },
      },
      [`/files/${FILE}/components`]: { meta: { components: [{ node_id: "7:1", name: "Size=sm", containing_frame: { containingComponentSet: { name: "Button" } } }, { node_id: "8:1", name: "Avatar", key: "k8", containing_frame: { pageName: "Components" } }] } },
      [`/files/${FILE}/component_sets`]: { meta: { component_sets: [{ node_id: "7:0", name: "Button", key: "k7", description: "Primary actions" }] } },
    });

  it("builds the kit: styles WITH values, sets not variants, screens", async () => {
    const kit = await restDesignKit(new RestClient("t", api().fetch), FILE, {});
    expect(kit.file).toMatchObject({ name: "Shop UI", key: FILE });
    expect(kit.styles?.paint).toEqual([{ name: "Brand/Primary", description: "CTA", paints: [{ type: "SOLID", color: "#2663eb" }] }]);
    expect(kit.styles?.text?.[0]).toMatchObject({ name: "Heading/H1", fontSize: 32, lineHeight: 40 });
    expect(kit.components?.map((c) => c.name)).toEqual(["Button", "Avatar"]);
    expect(kit.screens?.[0]).toMatchObject({ name: "Home", pageName: "Screens", width: 390 });
  });

  it("figma_read generate_design_md with a fileKey and no window answers from REST", async () => {
    const out = (await handleRead(ctx(api()), "generate_design_md", { fileKey: FILE })) as { markdown: string; source: string };
    expect(out.source).toBe("rest");
    expect(out.markdown).toContain("Brand/Primary".split("/")[1]);
    expect(out.markdown).toContain("Button");
  });

  it('source:"rest" reads through the API even when the file IS open', async () => {
    const a = figmaApi({ [`/files/${FILE}/nodes`]: { nodes: { "12:345": { document: { id: "12:345", name: "Home", type: "FRAME" } } } } });
    const c = ctx(a, [{ channel: "c1", plugin: { fileKey: FILE, fileName: "Shop" } }]);
    const out = (await handleRead(c, "get_node", { url: LINK, source: "rest" })) as { node: { name: string }; source: string };
    expect(out).toMatchObject({ node: { name: "Home" }, source: "rest" });
  });
});

describe("the tool declares the new reads", () => {
  it("figma_read's enum lists get_comments and get_versions", () => {
    const t = TOOLS.find((x) => x.name === "figma_read")!;
    const ops = (t.inputSchema as unknown as { properties: { op: { enum: string[] } } }).properties.op.enum;
    expect(ops).toEqual(expect.arrayContaining(["get_comments", "get_versions"]));
  });
});

describe("design.md from the live file's JSON shape (Starter plan, unpublished library)", () => {
  // The exact shape https://api.figma.com/v1/files/<key>?depth=2 returned for
  // the test file on 2026-11-27: /styles and /components were EMPTY (nothing
  // published), so everything comes off the file JSON.
  const LIVE_FILE = {
    name: "Untitled",
    document: { children: [{ id: "0:1", name: "Page 1", type: "CANVAS", children: [] }] },
    styles: { "2:9": { key: "efee", name: "body", styleType: "TEXT", remote: false, description: "" } },
    componentSets: { "2:18": { key: "81c4", name: "SmokeTest/Button", description: "" } },
    components: {
      "2:12": { key: "237b", name: "Tone=primary, Size=lg", componentSetId: "2:18" },
      "2:16": { key: "91b1", name: "Tone=secondary, Size=lg", componentSetId: "2:18" },
      "2:14": { key: "aa9b", name: "Tone=secondary, Size=sm", componentSetId: "2:18" },
      "2:44": { key: "613a", name: "SmokeTest/Card" },
    },
  };
  const api = () =>
    figmaApi({
      [`/files/${FILE}`]: LIVE_FILE,
      [`/files/${FILE}/styles`]: { error: false, status: 200, meta: { styles: [] } },
      [`/files/${FILE}/components`]: { meta: { components: [] } },
      [`/files/${FILE}/component_sets`]: { meta: { component_sets: [] } },
      [`/files/${FILE}/nodes`]: { nodes: { "2:9": { document: { id: "2:9", style: { fontFamily: "Inter", fontWeight: 400, fontSize: 14, lineHeightPx: 16.94 } } } } },
    });

  it("font style is a NAME (Regular), not the weight number", async () => {
    const kit = await restDesignKit(new RestClient("t", api().fetch), FILE, {});
    expect(kit.styles?.text?.[0]).toMatchObject({ name: "body", fontName: { family: "Inter", style: "Regular" } });
  });

  it("a component set keeps its variants and Tone / Size options", async () => {
    const out = (await handleRead(ctx(api()), "generate_design_md", { fileKey: FILE })) as { markdown: string };
    const kit = await restDesignKit(new RestClient("t", api().fetch), FILE, {});
    const set = kit.components!.find((c) => c.name === "SmokeTest/Button")!;
    expect(set.variants!.map((v) => v.id)).toEqual(["2:12", "2:16", "2:14"]);
    expect(set.componentPropertyDefinitions).toEqual({
      Tone: { type: "VARIANT", defaultValue: "primary", variantOptions: ["primary", "secondary"] },
      Size: { type: "VARIANT", defaultValue: "lg", variantOptions: ["lg", "sm"] },
    });
    expect(out.markdown).toContain("Tone=secondary, Size=sm — id `2:14`");
    expect(out.markdown).toMatch(/`Tone`: VARIANT default=.*primary.*options=/);
  });
});


describe("review fixes: REST features", () => {
  it("figma.postComment with a url that is not a Figma link refuses instead of posting to the open file", async () => {
    const calls: string[] = [];
    const res = await executeWrite(`return await figma.postComment({ url: "www.figma.com/desgn/oops", message: "hi" });`, new SessionRegistry().get(), {
      runOp: async (op) => {
        calls.push(op);
        return { id: "x", ok: true, result: { fileKey: "OPEN_FILE" } };
      },
      restFetch: async () => new Response("{}", { status: 200 }),
    });
    expect(res.error).toMatchObject({ code: "INVALID_PARAMS", message: expect.stringMatching(/not a Figma link/) });
    expect(calls).not.toContain("get_document_info");
  });

  it("restDesignKit notes every sub-read it could not do, and merges LOCAL components even when some are published", async () => {
    const scope = JSON.stringify({ error: true, status: 403, message: 'Invalid scope: ["file_content:read"]. This endpoint requires the library_content:read scope.' });
    const api = figmaApi({
      [`/files/${FILE}`]: { name: "F", document: { children: [] }, components: { "9:9": { name: "LocalOnly", key: "k9" } }, componentSets: {} },
      [`/files/${FILE}/styles`]: () => new Response(scope, { status: 403 }),
      [`/files/${FILE}/components`]: { meta: { components: [{ node_id: "1:1", name: "Published", key: "k1", containing_frame: {} }] } },
      [`/files/${FILE}/component_sets`]: { meta: { component_sets: [] } },
    });
    const kit = await restDesignKit(new RestClient("t", api.fetch), FILE, {});
    expect(kit.components!.map((c) => c.name).sort()).toEqual(["LocalOnly", "Published"]);
    expect(kit.notes!.join("\n")).toMatch(/Published styles could not be read.*INCOMPLETE.*library_content:read/);
  });

  it("a rate limit during design.md fails the call (with when to retry) instead of returning a partial file", async () => {
    const api = figmaApi({
      [`/files/${FILE}`]: { name: "F", document: { children: [] } },
      [`/files/${FILE}/styles`]: () => new Response('{"status":429,"err":"Rate limit exceeded"}', { status: 429, headers: { "retry-after": "399946", "x-figma-plan-tier": "starter" } }),
    });
    await expect(restDesignKit(new RestClient("t", api.fetch), FILE, {})).rejects.toMatchObject({ code: "RATE_LIMITED", message: expect.stringMatching(/4\.6 days/) });
  });

  it("postComment's rate-limit error says when to retry", async () => {
    const api = figmaApi({ [`POST /files/${FILE}/comments`]: () => new Response("{}", { status: 429, headers: { "retry-after": "7200" } }) });
    await expect(postComment(api.fetch, FILE, { message: "x" })).rejects.toMatchObject({ code: "RATE_LIMITED", message: expect.stringMatching(/2 h/) });
  });
});
