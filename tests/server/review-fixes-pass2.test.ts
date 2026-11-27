import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { RestHub, anySignal, mergeFollowerRestStatus, type TokenStatus } from "../../src/server/rest-hub.js";
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
/** Wait for a condition, not for a guessed number of milliseconds. */
const settle = async (h: RestHub) => {
  await vi.waitFor(() => expect(h.getStatus().state).not.toBe("checking"));
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
    await vi.waitFor(() => expect(seen).toEqual(["rate_limited", "unverified"]));
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
    await vi.waitFor(() => expect(b.channelSummaries()).toHaveLength(1));
    ws.send(JSON.stringify({ type: "set_rest_token", token: A, savedAt: 1 }));
    await vi.waitFor(() => expect(hub.getStatus().masked).toBe("figd_…aaaa"));
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

  it("names: not lowercase (HTML tags), no reserved words or device names; _ and $ starts are fine", () => {
    for (const bad of ["button", "class", "default", "CON", "Nul", "my-button"]) expect(isComponentIdent(bad), bad).toBe(false);
    for (const ok of ["Button", "_Private", "$Icon"]) expect(isComponentIdent(ok), ok).toBe(true);
  });

  it("a case-insensitive file clash is a COLLISION (its own list), and only between names that produce a file", () => {
    const one = mapToCodeConnect({ components: { Button: { figma: "B" }, BUTTON: { figma: "B" } } }, { B: "1:1" }, { fileKey: "K" });
    expect(one.files.map((f) => f.fileName)).toEqual(["Button.figma.tsx"]);
    expect(one.invalid).toEqual([]);
    expect(one.collisions[0]).toMatch(/^BUTTON \(same file as Button/);
    // Button has no Figma node → no file → BUTTON collides with nothing.
    const two = mapToCodeConnect({ components: { Button: { figma: "Missing" }, BUTTON: { figma: "B" } } }, { B: "1:1" }, { fileKey: "K" });
    expect(two.files.map((f) => f.fileName)).toEqual(["BUTTON.figma.tsx"]);
    expect(two.missing).toEqual(["Button"]);
    expect(two.collisions).toEqual([]);
  });

  it("a // inside a template's ${…} is not a comment; props after it are still read", () => {
    const { connections } = parseCodeConnect(
      'figma.connect(Btn, "https://www.figma.com/design/K/x?node-id=1-1", {\n' +
        "  example: (p) => <Btn href={`https://x/${p.id + '//'}`}>{p.label}</Btn>,\n" +
        '  props: { label: figma.string("Label") },\n' +
        "})\nconst t = `${'figma.connect(Ghost, \"u\")'}`;\n",
    );
    expect(connections.map((c) => [c.component, Object.keys(c.props)])).toEqual([["Btn", ["label"]]]);
  });

  it("a commented-out props: block above the real one is not read", () => {
    const { connections } = parseCodeConnect(
      'figma.connect(Btn, "https://www.figma.com/design/K/x?node-id=1-1", {\n  // props: { old: figma.string("Old") },\n  props: { label: figma.string("Label") },\n})',
    );
    expect(Object.keys(connections[0]!.props)).toEqual(["label"]);
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

describe("sanitizeSvg, third pass", () => {
  it("an entity beyond Unicode is a replacement character, not a RangeError", () => {
    expect(() => sanitizeSvg('<svg><rect id="&#x110000;&#99999999;"/></svg>')).not.toThrow();
  });
  it("a self-closing root ends the document", () => {
    expect(sanitizeSvg("<svg/>junk<g></g><svg></svg>")).toBe("<svg/>");
  });
  it("a bare & in text becomes &amp; (valid XML); real entities stay", () => {
    expect(sanitizeSvg("<svg><text>AT&T &amp; &nbsp;</text></svg>")).toBe("<svg><text>AT&amp;T &amp; &amp;nbsp;</text></svg>");
  });
  it("an unknown closing tag is dropped without unbalancing the document", () => {
    expect(sanitizeSvg("<svg><g></svg_x></g><rect/></svg>")).toBe("<svg><g></g><rect/></svg>");
  });
});


describe("third pass: rest-hub", () => {
  it("the follower status merge index.ts runs: the leader's when it has a token, else this process's own", () => {
    const own: TokenStatus = { state: "valid", source: "env", masked: "figd_…envv" };
    expect(mergeFollowerRestStatus({ state: "valid", source: "plugin", masked: "figd_…lead" }, own).masked).toBe("figd_…lead");
    expect(mergeFollowerRestStatus({ state: "not_set", source: null }, own)).toBe(own);
    expect(mergeFollowerRestStatus(undefined, own)).toBe(own);
  });

  it("a follower WITH its own FIGMA_TOKEN keys its cache on the leader's token (that is what its requests use)", async () => {
    let leaderGen = 1;
    let now = 1_000;
    const f = new RestHub({ env: () => B, now: () => now, fetch: async () => json({}) });
    f.setRemote(() => async () => ({ noToken: true }), async () => ({ state: "valid", source: "plugin", masked: "figd_…same", tokenGen: leaderGen }));
    const k1 = await f.cacheKey();
    leaderGen = 2;
    now += 6_000; // past the 5 s leader-status cache
    expect(await f.cacheKey()).not.toBe(k1); // same mask, different token: different key
  });

  it("a Retry-After longer than a timer can wait is reached in steps, never early", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const h = new RestHub({ env: () => undefined, now: () => now, fetch: async (u) => (u.endsWith("/me") ? json({ handle: "h" }) : u.includes("/teams/") ? json({}, 404) : json({}, 429, { "retry-after": "3000000" })) });
      h.setPluginToken(A);
      await settle(h);
      await h.fetch("https://api.figma.com/v1/files/K", {});
      const retryAt = h.getStatus().retryAt!;
      expect(retryAt).toBe(3_000_000_000);
      // The first timer fires at the longest wait a timer allows — before retryAt.
      now = 2_147_483_000;
      await vi.advanceTimersByTimeAsync(2_147_483_000);
      expect(h.getStatus()).toMatchObject({ state: "rate_limited", retryAt }); // held, same deadline
      // The next step is due exactly at retryAt: one ms before, still held…
      now = retryAt - 1;
      await vi.advanceTimersByTimeAsync(retryAt - 1 - 2_147_483_000);
      expect(h.getStatus().state).toBe("rate_limited");
      // …and at retryAt the limit is lifted (by THE aging timer: nothing else is due then).
      now = retryAt;
      await vi.advanceTimersByTimeAsync(1);
      expect(h.getStatus().state).not.toBe("rate_limited");
    } finally {
      vi.useRealTimers();
    }
  });

  it("anySignal's Node 18 path removes its listeners once the combined signal aborts", () => {
    const real = (AbortSignal as unknown as { any?: unknown }).any;
    (AbortSignal as unknown as { any?: unknown }).any = undefined;
    try {
      const longLived = new AbortController();
      let added = 0;
      let removed = 0;
      const sig = longLived.signal;
      const add = sig.addEventListener.bind(sig);
      const rem = sig.removeEventListener.bind(sig);
      sig.addEventListener = ((...a: Parameters<typeof add>) => (added++, add(...a))) as typeof add;
      sig.removeEventListener = ((...a: Parameters<typeof rem>) => (removed++, rem(...a))) as typeof rem;
      const other = new AbortController();
      anySignal([sig, other.signal]);
      other.abort();
      expect(added).toBe(1);
      expect(removed).toBe(1);
    } finally {
      (AbortSignal as unknown as { any?: unknown }).any = real;
    }
  });

  it("a re-save while an expired rate limit is pending emits ONCE", async () => {
    let now = 0;
    const h = new RestHub({ env: () => undefined, now: () => now, fetch: async (u) => (u.endsWith("/me") ? json({ handle: "h" }) : u.includes("/teams/") ? json({}, 404) : json({}, 429, { "retry-after": "10" })) });
    h.setPluginToken(A);
    await settle(h);
    await h.fetch("https://api.figma.com/v1/files/K", {});
    now = 11_000;
    const seen: string[] = [];
    h.onStatus((s) => seen.push(s.state));
    h.setPluginToken(A); // same token
    expect(seen).toEqual(["unverified"]); // the expiry IS the answer — not a second copy of it
  });
});
