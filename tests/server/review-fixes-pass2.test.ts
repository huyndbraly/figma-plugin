import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { RestHub, anySignal, type TokenStatus } from "../../src/server/rest-hub.js";
import { Bridge } from "../../src/server/bridge.js";
import { handleStatus, type Diagnostics, type ToolContext } from "../../src/server/tools.js";
import { SessionRegistry } from "../../src/server/session.js";
import { restDesignKit } from "../../src/server/rest-features.js";
import { RestClient } from "../../src/server/rest-read.js";
import { codeConnectToMap, isComponentIdent, mapToCodeConnect, parseCodeConnect } from "../../src/shared/code-connect.js";
import { sanitizeSvg } from "../../src/server/byok.js";
import { executeWrite } from "../../src/server/executor.js";

/**
 * Second code-review pass (2026-11-27): each test reproduces a finding of
 * the re-review and fails on the code before its fix.
 */

const A = "figd_aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "figd_bbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const json = (b: unknown, s = 200, h: Record<string, string> = {}) => new Response(JSON.stringify(b), { status: s, headers: h });
const settle = async (h: RestHub) => {
  for (let i = 0; i < 40 && h.getStatus().state === "checking"; i++) await new Promise((r) => setTimeout(r, 5));
  return h.getStatus();
};

describe("token lifecycle, second pass", () => {
  it("a NEW token is checked even while the old one is rate-limited", async () => {
    const h = new RestHub({ env: () => undefined, fetch: async (u) => (u.endsWith("/me") ? json({ handle: "h" }) : u.includes("/teams/") ? json({}, 404) : json({}, 429, { "retry-after": "999" })) });
    h.setPluginToken(A);
    await settle(h);
    await h.fetch("https://api.figma.com/v1/files/K", {});
    expect(h.getStatus().state).toBe("rate_limited");
    h.setPluginToken(B);
    expect(await settle(h)).toMatchObject({ state: "valid", masked: "figd_…bbbb" });
    expect(h.getStatus().retryAt).toBeUndefined();
  });

  it("every set_rest_token gets an answer: same token, an older save, junk", async () => {
    const h = new RestHub({ env: () => undefined, fetch: async (u) => (u.endsWith("/me") ? json({ handle: "h" }) : json({}, 404)) });
    h.setPluginToken(A, { savedAt: 10 });
    await settle(h);
    const seen: TokenStatus[] = [];
    h.onStatus((s) => seen.push(s));
    h.setPluginToken(A, { savedAt: 11 }); // same token re-saved
    h.setPluginToken(B, { savedAt: 5 }); // an older save from a stale window
    h.setPluginToken("not a token");
    expect(seen.map((s) => s.state)).toEqual(["valid", "valid", "valid"]);
  });

  it("the end of a rate limit is BROADCAST (a timer), not only noticed by the next reader", async () => {
    let now = 1_000_000;
    const h = new RestHub({ env: () => undefined, now: () => now, fetch: async (u) => (u.endsWith("/me") ? json({ handle: "h" }) : u.includes("/teams/") ? json({}, 404) : json({}, 429, { "retry-after": "0.05" })) });
    h.setPluginToken(A);
    await settle(h);
    const seen: string[] = [];
    h.onStatus((s) => seen.push(s.state));
    await h.fetch("https://api.figma.com/v1/files/K", {});
    now += 60;
    await new Promise((r) => setTimeout(r, 120));
    expect(seen).toEqual(["rate_limited", "unverified"]);
  });

  it("a 429 without Retry-After still ages out (default wait)", async () => {
    const h = new RestHub({ env: () => undefined, now: () => 0, fetch: async (u) => (u.endsWith("/me") ? json({ handle: "h" }) : u.includes("/teams/") ? json({}, 404) : json({}, 429)) });
    h.setPluginToken(A);
    await settle(h);
    await h.fetch("https://api.figma.com/v1/files/K", {});
    expect(h.getStatus().retryAt).toBe(60_000);
  });

  it("a probe that got no answer is not remembered — the next check asks again", async () => {
    let fail = true;
    let probes = 0;
    const h = new RestHub({
      env: () => undefined,
      fetch: async (u) => {
        if (u.endsWith("/me")) return json({ handle: "h" });
        probes++;
        if (fail) throw new Error("timeout");
        return json({ message: 'Invalid scope: ["file_content:read"]. This endpoint requires the projects:read scope.' }, 403);
      },
    });
    h.setPluginToken(A);
    await settle(h);
    fail = false;
    await h.check();
    expect(probes).toBe(2);
    expect(h.getStatus().scopes).toEqual(["file_content:read"]);
  });

  it("a follower never re-sends a POST with its own token after a failed forward", async () => {
    let localPosts = 0;
    const follower = new RestHub({
      env: () => B,
      fetch: async (_u, init) => {
        if ((init.method ?? "GET") === "POST") localPosts++;
        return json({});
      },
    });
    follower.setRemote(() => async () => {
      throw new Error("leader went away mid-request");
    });
    await expect(follower.fetch("https://api.figma.com/v1/files/K/comments", { method: "POST", body: "{}" })).rejects.toThrow(/went away/);
    expect(localPosts).toBe(0);
    // A read is harmless to repeat: it falls back.
    expect((await follower.fetch("https://api.figma.com/v1/files/K", {})).status).toBe(200);
  });

  it("anySignal combines signals without AbortSignal.any (Node 18)", () => {
    const real = (AbortSignal as unknown as { any?: unknown }).any;
    (AbortSignal as unknown as { any?: unknown }).any = undefined;
    try {
      const a = new AbortController();
      const b = new AbortController();
      const s = anySignal([a.signal, b.signal])!;
      expect(s.aborted).toBe(false);
      b.abort();
      expect(s.aborted).toBe(true);
    } finally {
      (AbortSignal as unknown as { any?: unknown }).any = real;
    }
  });
});

describe("figma_status from the REAL bridge + hub never carries the token", () => {
  const bridges: Bridge[] = [];
  afterEach(async () => {
    while (bridges.length) await bridges.pop()?.close();
  });

  it("channels and restToken as index.ts assembles them", async () => {
    const hub = new RestHub({ env: () => undefined, fetch: async (u) => (u.endsWith("/me") ? json({ handle: "h" }) : json({}, 404)) });
    const b = new Bridge({ onRestToken: (t, _c, meta) => hub.setPluginToken(t, meta ?? {}) });
    bridges.push(b);
    b.setRestStatusProvider(() => hub.getStatus());
    const port = await b.listen(0, "t");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((r) => ws.once("open", () => r()));
    ws.send(JSON.stringify({ type: "hello", protocolVersion: 8, pluginVersion: "1", fileKey: "K", fileName: "F", pageName: "P", editorType: "figma", restToken: A }));
    await new Promise((r) => setTimeout(r, 40));
    ws.send(JSON.stringify({ type: "set_rest_token", token: A, savedAt: 1 }));
    await new Promise((r) => setTimeout(r, 60));
    await settle(hub);
    const d: Diagnostics = {
      mode: "leader", port, bridgeAuth: "ok", statusSource: "local", pluginConnected: b.pluginConnected,
      channels: b.channelSummaries() as never, lastHeartbeatMs: b.lastHeartbeatMs, queueLength: 0, pendingCount: 0, restToken: hub.getStatus(),
    };
    const ctx: ToolContext = { runValidated: async () => ({}), runWrite: async () => ({}), sessions: new SessionRegistry(), diagnostics: async () => d };
    const out = JSON.stringify(await handleStatus(ctx));
    expect(out).toContain("figd_…aaaa");
    expect(out).not.toContain(A);
    ws.close();
  });
});

describe("REST kit, second pass", () => {
  const FILE = "K";
  it("library components (remote:true) are not this file's; a failed sub-read marks the kit incomplete", async () => {
    const api = async (url: string) => {
      const p = new URL(url).pathname;
      if (p === "/v1/files/K") return json({ name: "F", document: { children: [] }, components: { "1:1": { name: "Mine" }, "9:9": { name: "FromLibrary", remote: true } }, componentSets: {} });
      if (p.endsWith("/styles")) return json({ message: 'Invalid scope: []. This endpoint requires the library_content:read scope.' }, 403);
      return json({ meta: {} });
    };
    const kit = await restDesignKit(new RestClient("t", api), FILE, {});
    expect(kit.components!.map((c) => c.name)).toEqual(["Mine"]);
    expect(kit.extraction!.incomplete).toBe(true);
  });
});

describe("Code Connect, second pass", () => {
  it("an apostrophe in a comment does not derail the props scan", () => {
    const { connections } = parseCodeConnect(`
      figma.connect(Btn, 'https://www.figma.com/design/K/x?node-id=1-1', {
        props: {
          // Figma's size variant
          size: figma.enum('Size', { 'Small': 'sm' }),
          label: figma.string('Label'),
        },
      })`);
    expect(Object.keys(connections[0]!.props)).toEqual(["size", "label"]);
  });

  it("a commented-out connection is not a connection", () => {
    const { connections } = parseCodeConnect(`
      // figma.connect(Old, "https://www.figma.com/design/K/x?node-id=9-9", {})
      /* figma.connect(Older, "https://www.figma.com/design/K/x?node-id=8-8", {}) */
      const s = "figma.connect(InString, 'x')";
      figma.connect(New, "https://www.figma.com/design/K/x?node-id=1-1", {})`);
    expect(connections.map((c) => c.component)).toEqual(["New"]);
  });

  it("per-variant connections merge their enum VALUES; a second Figma target is a conflict", () => {
    const { connections } = parseCodeConnect(`
      figma.connect(Btn, "https://www.figma.com/design/K/x?node-id=1-1", { props: { size: figma.enum("Size", { "Small": "sm" }) } })
      figma.connect(Btn, "https://www.figma.com/design/K/x?node-id=1-1", { props: { size: figma.enum("Size", { "Large": "lg" }) } })
      figma.connect(Btn, "https://www.figma.com/design/K/x?node-id=2-2", { props: {} })`);
    const out = codeConnectToMap(connections, { "1:1": "Button", "2:2": "OtherButton" });
    expect(out.map.components.Btn!.props!.size!.values).toEqual({ sm: "Small", lg: "Large" });
    expect(out.conflicts[0]).toMatch(/Btn: connected to "Button" and to "OtherButton"/);
  });

  it("names: uppercase component tags only, no reserved words or device names, no case-folded duplicates", () => {
    for (const bad of ["button", "class", "Default".toLowerCase(), "CON", "Nul"]) expect(isComponentIdent(bad), bad).toBe(false);
    expect(isComponentIdent("Button")).toBe(true);
    const { files, invalid } = mapToCodeConnect({ components: { Button: { figma: "B" }, BUTTON: { figma: "B" } } }, { B: "1:1" }, { fileKey: "K" });
    expect(files.map((f) => f.fileName)).toEqual(["Button.figma.tsx"]);
    expect(invalid).toEqual(["BUTTON"]);
  });
});

describe("sanitizeSvg, second pass", () => {
  it("entity-encoded url( / javascript: are decoded before they are judged", () => {
    const out = sanitizeSvg('<svg><rect fill="&#x75;rl(https://evil/x)" mask="&#117;rl(http://e/m)"/><use href="&#106;avascript:x"/></svg>');
    expect(out).not.toMatch(/evil|e\/m|javascript|&#/);
  });

  it("stops at the </svg> that closes the FIRST svg — prose and a second svg are dropped", () => {
    const out = sanitizeSvg('Here: <svg><rect/></svg> and another <svg><circle r="1"/></svg>');
    expect(out).toBe("<svg><rect/></svg>");
  });

  it("an unclosed dropped element or a cut-off reply still yields one well-formed svg", () => {
    expect(sanitizeSvg('<svg><g><rect/><foreignObject><div>…')).toBe("<svg><g><rect/></g></svg>");
  });
});

describe("htmlToFigma warnings are not repeated", () => {
  it("the same warning from two captures in one call appears once", async () => {
    const loader = async () => ({
      chromium: {
        launch: async () => ({
          newPage: async () => ({
            goto: async () => {},
            waitForTimeout: async () => {},
            evaluate: async () => ({ tag: "body", rect: { x: 0, y: 0, w: 100, h: 0 }, style: {}, children: [] }),
          }),
          close: async () => {},
        }),
      },
    });
    const res = await executeWrite(
      `await figma.htmlToFigma("http://localhost:1/"); await figma.htmlToFigma("http://localhost:1/"); return 1;`,
      new SessionRegistry().get(),
      { runOp: async () => ({ id: "x", ok: true, result: { id: "1:1" } }), playwrightLoader: loader as never },
    );
    expect(res.warnings.filter((w) => /has no size/.test(w))).toHaveLength(1);
  });
});

describe("extractInPage turns modern colours into rgb in the page (review)", () => {
  it("oklch() is painted to a pixel and read back as rgba; rgb() passes through", async () => {
    const { extractInPage } = await import("../../src/server/html-capture.js");
    const painted: string[] = [];
    const ctx2d = {
      clearRect() {},
      fillRect() {},
      set fillStyle(v: string) {
        painted.push(v);
      },
      getImageData: () => ({ data: [10, 20, 30, 255] }),
    };
    const el = (tag: string, style: Record<string, string>, children: unknown[] = []) => ({
      tagName: tag,
      childNodes: children,
      nodeType: 1,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 20 }),
      getAttribute: () => null,
      _style: style,
    });
    const body = el("BODY", { backgroundColor: "oklch(0.7 0.1 200)", color: "rgb(1, 2, 3)", display: "block" });
    const g = globalThis as any;
    const saved = { document: g.document, getComputedStyle: g.getComputedStyle, scrollX: g.scrollX, scrollY: g.scrollY };
    g.document = { body, querySelector: () => body, createElement: () => ({ getContext: () => ctx2d }), createRange: () => ({}) };
    g.getComputedStyle = (e: { _style: Record<string, string> }) => ({ display: "block", visibility: "visible", ...e._style });
    g.scrollX = 0;
    g.scrollY = 0;
    try {
      const tree = extractInPage({ maxDepth: 5 }) as { style: Record<string, string> };
      expect(tree.style.backgroundColor).toBe("rgba(10, 20, 30, 1)");
      expect(tree.style.color).toBe("rgb(1, 2, 3)");
      expect(painted).toContain("oklch(0.7 0.1 200)");
    } finally {
      Object.assign(g, saved);
    }
  });
});
