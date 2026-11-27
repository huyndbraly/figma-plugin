import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import {
  RestHub,
  describeRequest,
  maskToken,
  cleanToken,
  type RestEvent,
  type TokenStatus,
  type ForwardedRequest,
} from "../../src/server/rest-hub.js";
import { Bridge } from "../../src/server/bridge.js";
import { handleStatus, type Diagnostics, type ToolContext } from "../../src/server/tools.js";
import { SessionRegistry } from "../../src/server/session.js";
import type { WireMessage } from "../../src/shared/protocol.js";

/**
 * The REST token lifecycle. What each case pins is something a user would
 * see go wrong: a token echoed back to an agent, a badge stuck on "Valid"
 * after Figma started answering 401, a follower that cannot read a link the
 * leader could, a window reconnecting with no token that wipes the saved one.
 */

const TOKEN = "figd_abcdefghijklmnopqrstuvwxyz1234";
const ENV_TOKEN = "figd_envtokenenvtokenenvtoken9999";

interface Call {
  url: string;
  method: string;
  token: string | null;
  body?: string;
}

function fakeNet(answer: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const h = new Headers(init.headers ?? {});
    const c: Call = { url, method: (init.method ?? "GET").toUpperCase(), token: h.get("x-figma-token"), ...(typeof init.body === "string" ? { body: init.body } : {}) };
    calls.push(c);
    return answer(c);
  };
  return { calls, fetch };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function hub(net: ReturnType<typeof fakeNet>, env?: string): RestHub {
  return new RestHub({ env: () => env, fetch: net.fetch });
}

async function settle(h: RestHub): Promise<TokenStatus> {
  // Let a background check finish.
  for (let i = 0; i < 20 && h.getStatus().state === "checking"; i++) await new Promise((r) => setTimeout(r, 5));
  return h.getStatus();
}

describe("masking and cleaning", () => {
  it("never shows more than the prefix and the last four characters", () => {
    expect(maskToken(TOKEN)).toBe("figd_…1234");
    expect(maskToken("short")).toBe("••••");
    expect(maskToken(null)).toBeUndefined();
    expect(maskToken(TOKEN)).not.toContain("abcdef");
  });

  it("refuses strings that cannot be a token", () => {
    expect(cleanToken(`  ${TOKEN}\n`)).toBe(TOKEN);
    expect(cleanToken("figd_ has space")).toBeNull();
    expect(cleanToken("x")).toBeNull();
    expect(cleanToken(42)).toBeNull();
  });
});

describe("token lifecycle", () => {
  it("starts not_set, then checks a saved token against /v1/me and reports the handle", async () => {
    const net = fakeNet(() => json({ handle: "ngoc", email: "x@y" }));
    const h = hub(net);
    expect(h.getStatus().state).toBe("not_set");
    const seen: string[] = [];
    h.onStatus((s) => seen.push(s.state));
    expect(h.setPluginToken(TOKEN).state).toBe("checking");
    const s = await settle(h);
    expect(s).toMatchObject({ state: "valid", source: "plugin", handle: "ngoc", masked: "figd_…1234" });
    expect(seen).toEqual(["checking", "valid"]);
    expect(net.calls[0]).toMatchObject({ url: "https://api.figma.com/v1/me", token: TOKEN });
    // The email is not something the panel needs; it is not kept.
    expect(JSON.stringify(s)).not.toContain("x@y");
  });

  it.each([
    [401, "invalid"],
    [403, "invalid"],
    [429, "rate_limited"],
    [500, "error"],
  ] as const)("maps a %i on the check to %s", async (status, state) => {
    const h = hub(fakeNet(() => json({ err: "x" }, status)));
    h.setPluginToken(TOKEN);
    expect((await settle(h)).state).toBe(state);
  });

  it("a network failure is `error`, not `invalid` — the token may be fine", async () => {
    const h = hub(fakeNet(() => Promise.reject(new Error("ENOTFOUND"))));
    h.setPluginToken(TOKEN);
    const s = await settle(h);
    expect(s.state).toBe("error");
    expect(s.message).toMatch(/ENOTFOUND/);
  });

  it("prefers the plugin token over FIGMA_TOKEN, and falls back to it on Clear", async () => {
    const net = fakeNet(() => json({ handle: "h" }));
    const h = hub(net, ENV_TOKEN);
    expect(h.getStatus()).toMatchObject({ state: "unverified", source: "env" });
    h.setPluginToken(TOKEN);
    await settle(h);
    expect(h.token()).toBe(TOKEN);
    expect(h.source()).toBe("plugin");
    h.setPluginToken(null);
    await settle(h);
    expect(h.token()).toBe(ENV_TOKEN);
    expect(h.getStatus().source).toBe("env");
  });

  it("Clear with no env token is not_set", () => {
    const h = hub(fakeNet(() => json({})));
    h.setPluginToken(TOKEN);
    expect(h.setPluginToken(null).state).toBe("not_set");
    expect(h.token()).toBeUndefined();
  });

  it("refuses a malformed token without sending it anywhere", () => {
    const net = fakeNet(() => json({}));
    const h = hub(net);
    expect(h.setPluginToken("not a token").state).toBe("invalid");
    expect(net.calls).toHaveLength(0);
    expect(h.token()).toBeUndefined();
  });

  it("drops the result of a check for a token that was replaced meanwhile", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const net = fakeNet(async (c) => {
      if (c.token === TOKEN) {
        await gate;
        return json({}, 401);
      }
      return json({ handle: "second" });
    });
    const h = hub(net);
    h.setPluginToken(TOKEN);
    h.setPluginToken(`${TOKEN}X`);
    release();
    await new Promise((r) => setTimeout(r, 20));
    const s = await settle(h);
    expect(s).toMatchObject({ state: "valid", handle: "second" });
  });

  it("the same token again (a reconnect hello) does not re-check a valid token", async () => {
    const net = fakeNet(() => json({ handle: "h" }));
    const h = hub(net);
    h.setPluginToken(TOKEN);
    await settle(h);
    h.setPluginToken(TOKEN);
    await settle(h);
    expect(net.calls.filter((c) => c.url.endsWith("/me"))).toHaveLength(1);
  });
});

describe("hub.fetch — the one door every REST request goes through", () => {
  it("injects the CURRENT token, replacing whatever the caller sent", async () => {
    const net = fakeNet(() => json({ ok: 1 }));
    const h = hub(net);
    h.setPluginToken(TOKEN);
    await settle(h);
    await h.fetch("https://api.figma.com/v1/files/KEY/nodes?ids=1:2", { headers: { "X-Figma-Token": "stale" } });
    expect(net.calls.at(-1)!.token).toBe(TOKEN);
  });

  it("reports every request as a token-free event", async () => {
    const net = fakeNet((c) => (c.url.includes("/comments") ? json({}, 404) : json({ ok: 1 })));
    const h = hub(net);
    h.setPluginToken(TOKEN);
    await settle(h);
    const events: RestEvent[] = [];
    h.onEvent((e) => events.push(e));
    await h.fetch("https://api.figma.com/v1/files/KEY/nodes?ids=1:2", {});
    await h.fetch("https://api.figma.com/v1/files/KEY/comments", { method: "POST", body: "{}" });
    expect(events).toMatchObject([
      { type: "rest_event", op: "get_nodes", fileKey: "KEY", status: 200, ok: true, kind: "read" },
      { op: "post_comment", status: 404, ok: false, kind: "write", message: "Not found" },
    ]);
    expect(JSON.stringify(events)).not.toContain(TOKEN);
  });

  it("a 401 on a real request flips the badge to invalid at once", async () => {
    let fail = false;
    const net = fakeNet(() => (fail ? json({ status: 401, err: "Invalid token" }, 401) : json({ handle: "h" })));
    const h = hub(net);
    h.setPluginToken(TOKEN);
    await settle(h);
    fail = true;
    const res = await h.fetch("https://api.figma.com/v1/files/KEY", {});
    expect(res.status).toBe(401);
    expect(h.getStatus()).toMatchObject({ state: "invalid", httpStatus: 401 });
  });

  it("a 403 that names the token is invalid; a 403 for one file asks /me instead", async () => {
    let mode: "token" | "file" | "ok" = "ok";
    const net = fakeNet((c) => {
      if (c.url.endsWith("/me")) return json({ handle: "h" });
      if (mode === "token") return json({ status: 403, err: "Invalid token" }, 403);
      if (mode === "file") return json({ status: 403, err: "Forbidden" }, 403);
      return json({});
    });
    const h = hub(net);
    h.setPluginToken(TOKEN);
    await settle(h);

    mode = "file";
    await h.fetch("https://api.figma.com/v1/files/OTHER", {});
    expect(h.getStatus().state).toBe("valid"); // no access to ONE file is not a bad token
    await new Promise((r) => setTimeout(r, 300));
    expect(net.calls.filter((c) => c.url.endsWith("/me")).length).toBe(2); // it asked

    mode = "token";
    await h.fetch("https://api.figma.com/v1/files/KEY", {});
    expect(h.getStatus().state).toBe("invalid");
  });

  it("a 429 shows rate-limited, and the next success clears it", async () => {
    let status = 429;
    const net = fakeNet((c) => (c.url.endsWith("/me") ? json({ handle: "h" }) : json({}, status, { "retry-after": "3" })));
    const h = hub(net);
    h.setPluginToken(TOKEN);
    await settle(h);
    await h.fetch("https://api.figma.com/v1/files/KEY", {});
    expect(h.getStatus()).toMatchObject({ state: "rate_limited", httpStatus: 429 });
    expect(h.getStatus().message).toMatch(/retry in 3 s/);
    status = 200;
    await h.fetch("https://api.figma.com/v1/files/KEY", {});
    expect(h.getStatus().state).toBe("valid");
  });

  it("with no token at all it throws a hint that names the plugin panel", async () => {
    const h = hub(fakeNet(() => json({})));
    await expect(h.fetch("https://api.figma.com/v1/files/KEY", {})).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      hint: expect.stringMatching(/plugin panel/),
    });
  });
});

describe("followers use the leader's token without ever holding it", () => {
  it("forwards to the leader, which runs the request with ITS token", async () => {
    const leaderNet = fakeNet(() => json({ name: "File" }));
    const leader = hub(leaderNet);
    leader.setPluginToken(TOKEN);
    await settle(leader);

    const followerNet = fakeNet(() => json({}, 500));
    const follower = hub(followerNet);
    const forwarded: ForwardedRequest[] = [];
    follower.setRemote(() => async (req) => {
      forwarded.push(req);
      // What crosses the process boundary is JSON.
      return JSON.parse(JSON.stringify(await leader.serveForwarded(req)));
    });
    const res = await follower.fetch("https://api.figma.com/v1/files/KEY?depth=1", {});
    expect(await res.json()).toEqual({ name: "File" });
    expect(followerNet.calls).toHaveLength(0);
    expect(leaderNet.calls.at(-1)!.token).toBe(TOKEN);
    expect(JSON.stringify(forwarded)).not.toContain(TOKEN);
    expect(follower.token()).toBeUndefined();
  });

  it("falls back to the follower's own FIGMA_TOKEN when the leader has none", async () => {
    const leader = hub(fakeNet(() => json({})));
    const followerNet = fakeNet(() => json({ mine: true }));
    const follower = hub(followerNet, ENV_TOKEN);
    follower.setRemote(() => (req) => leader.serveForwarded(req));
    const res = await follower.fetch("https://api.figma.com/v1/files/KEY", {});
    expect(await res.json()).toEqual({ mine: true });
    expect(followerNet.calls[0]!.token).toBe(ENV_TOKEN);
  });

  it("the leader refuses to forward anything that is not api.figma.com", async () => {
    const leader = hub(fakeNet(() => json({})));
    leader.setPluginToken(TOKEN);
    await expect(leader.serveForwarded({ url: "https://evil.example/v1/me" })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(leader.serveForwarded({ url: "https://api.figma.com/v1/me", method: "PUT" })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });

  it("a follower's status is the leader's when the leader has a token", async () => {
    const follower = hub(fakeNet(() => json({})));
    follower.setRemote(
      () => async () => ({ noToken: true }),
      async () => ({ state: "valid", source: "plugin", handle: "lead", masked: "figd_…1234" }),
    );
    expect(await follower.effectiveStatus()).toMatchObject({ state: "valid", handle: "lead" });
    expect(await follower.available()).toBe(true);
  });
});

describe("describeRequest names calls the way the activity log shows them", () => {
  it.each([
    ["https://api.figma.com/v1/files/K/nodes?ids=1", "GET", "get_nodes"],
    ["https://api.figma.com/v1/images/K?ids=1", "GET", "render"],
    ["https://api.figma.com/v1/files/K/comments", "GET", "get_comments"],
    ["https://api.figma.com/v1/files/K/comments", "POST", "post_comment"],
    ["https://api.figma.com/v1/files/K/versions", "GET", "get_versions"],
    ["https://api.figma.com/v1/files/K?depth=1", "GET", "get_file"],
    ["https://api.figma.com/v1/me", "GET", "me"],
  ])("%s %s → %s", (url, method, op) => {
    expect(describeRequest(url, method).op).toBe(op);
  });
});

// ---------------------------------------------------------------------------
// The bridge carries the token in and the status / events out.
// ---------------------------------------------------------------------------

const bridges: Bridge[] = [];
afterEach(async () => {
  while (bridges.length) await bridges.pop()?.close();
});

async function plugin(port: number, hello: Record<string, unknown> = {}): Promise<{ ws: WebSocket; got: WireMessage[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const got: WireMessage[] = [];
  await new Promise<void>((res, rej) => {
    ws.once("open", () => res());
    ws.once("error", rej);
  });
  ws.on("message", (d) => got.push(JSON.parse(d.toString()) as WireMessage));
  ws.send(JSON.stringify({ type: "hello", protocolVersion: 7, pluginVersion: "1", fileKey: null, fileName: "F", pageName: "P", editorType: "figma", ...hello }));
  await new Promise((r) => setTimeout(r, 40));
  return { ws, got };
}

describe("bridge ↔ plugin token messages", () => {
  let tokens: Array<string | null>;
  let bridge: Bridge;
  let port: number;
  beforeEach(async () => {
    tokens = [];
    bridge = new Bridge({ onRestToken: (t) => tokens.push(t) });
    bridges.push(bridge);
    bridge.setRestStatusProvider(() => ({ state: "valid", source: "plugin", handle: "h", masked: "figd_…1234" }));
    port = await bridge.listen(0, "t");
  });

  it("takes a saved token from the hello, and tells the window the status right after assigning it", async () => {
    const p = await plugin(port, { restToken: TOKEN });
    expect(tokens).toEqual([TOKEN]);
    const types = p.got.map((m) => m.type);
    expect(types.indexOf("rest_status")).toBeGreaterThan(types.indexOf("assigned"));
    expect(JSON.stringify(p.got)).not.toContain(TOKEN);
    p.ws.close();
  });

  it("a hello WITHOUT a token never clears one (a window that missed the save must not wipe it)", async () => {
    const p = await plugin(port, { restToken: null });
    expect(tokens).toEqual([]);
    p.ws.close();
  });

  it("set_rest_token from a joined window saves or clears", async () => {
    const p = await plugin(port);
    p.ws.send(JSON.stringify({ type: "set_rest_token", token: TOKEN }));
    p.ws.send(JSON.stringify({ type: "set_rest_token", token: null }));
    p.ws.send(JSON.stringify({ type: "set_rest_token", token: 42 }));
    await new Promise((r) => setTimeout(r, 40));
    expect(tokens).toEqual([TOKEN, null]);
    p.ws.close();
  });

  it("ignores set_rest_token from a socket that never said hello", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((res) => ws.once("open", () => res()));
    ws.send(JSON.stringify({ type: "set_rest_token", token: TOKEN }));
    await new Promise((r) => setTimeout(r, 40));
    expect(tokens).toEqual([]);
    ws.close();
  });

  it("broadcast reaches every window", async () => {
    const a = await plugin(port);
    const b = await plugin(port, { fileName: "G" });
    bridge.broadcast({ type: "rest_event", at: 1, op: "get_nodes", method: "GET", status: 200, ms: 5, ok: true, kind: "read" });
    await new Promise((r) => setTimeout(r, 40));
    for (const p of [a, b]) expect(p.got.some((m) => m.type === "rest_event")).toBe(true);
    a.ws.close();
    b.ws.close();
  });
});

describe("figma_status shows the token's state, never the token", () => {
  function ctxWith(restToken: TokenStatus): ToolContext {
    const d: Diagnostics = {
      mode: "leader",
      port: 1,
      bridgeAuth: "ok",
      pluginConnected: true,
      statusSource: "local",
      channels: [],
      lastHeartbeatMs: 1,
      queueLength: 0,
      pendingCount: 0,
      restToken,
    };
    return {
      runValidated: async () => ({}),
      runWrite: async () => ({}),
      sessions: new SessionRegistry(),
      diagnostics: async () => d,
    };
  }

  it("reports state, source, handle and the masked preview", async () => {
    const out = await handleStatus(ctxWith({ state: "valid", source: "plugin", handle: "ngoc", masked: maskToken(TOKEN) }));
    expect(out.restToken).toEqual({ state: "valid", source: "plugin", handle: "ngoc", masked: "figd_…1234" });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it("an invalid token comes with a hint telling the agent what the user must do", async () => {
    const out = await handleStatus(ctxWith({ state: "invalid", source: "plugin", httpStatus: 403 }));
    expect((out.hints as string[]).join("\n")).toMatch(/REST Token → Save/);
  });
});

// ---------------------------------------------------------------------------
// Bodies captured from the live API on 2026-11-27 (a real PAT, its scopes as
// the user picked them). Fakes elsewhere used "{}" / "no" for a 403 — which is
// how a missing scope was reported as "Figma refused the token" before.
// ---------------------------------------------------------------------------
const LIVE = {
  invalidToken: '{"status":401,"err":"Invalid token"}',
  missingCredentials: '{"status":401,"err":"Missing credentials"}',
  scope:
    '{"error":true,"status":403,"message":"Invalid scope: [\\"current_user:read\\", \\"file_comments:read\\", \\"file_comments:write\\", \\"file_content:read\\", \\"file_metadata:read\\", \\"file_versions:read\\", \\"library_assets:read\\", \\"library_content:read\\", \\"team_library_content:read\\"]. This endpoint requires the file_read or files:read or projects:read scope.","i18n":null}',
  notFound: '{"status":404,"err":"Not found"}',
};

describe("reading Figma's failures the way Figma writes them", () => {
  it("a missing scope is `scope`, with the scope it needs and the ones the token has", async () => {
    const { classifyRestFailure } = await import("../../src/server/rest-hub.js");
    const f = classifyRestFailure(403, LIVE.scope);
    expect(f.kind).toBe("scope");
    expect(f.requiredScopes).toEqual(["file_read", "files:read", "projects:read"]);
    expect(f.grantedScopes).toContain("file_comments:write");
    expect(f.grantedScopes).toHaveLength(9);
  });

  it("401s are the token; a bare 403 is access; 404 is not found", async () => {
    const { classifyRestFailure } = await import("../../src/server/rest-hub.js");
    expect(classifyRestFailure(401, LIVE.invalidToken).kind).toBe("token");
    expect(classifyRestFailure(401, LIVE.missingCredentials).kind).toBe("token");
    expect(classifyRestFailure(403, '{"status":403,"err":"Token expired"}').kind).toBe("token");
    expect(classifyRestFailure(403, '{"status":403,"err":"Forbidden"}').kind).toBe("access");
    expect(classifyRestFailure(404, LIVE.notFound).kind).toBe("not_found");
  });

  it("restError names the scope to add, and says nothing about an expired token", async () => {
    const { restError } = await import("../../src/server/rest-hub.js");
    const e = restError(403, LIVE.scope, "list projects");
    expect(e.message).toMatch(/missing a permission to list projects.*`file_read`/);
    expect(e.hint).toMatch(/create a new personal access token with file_read/);
    expect(e.hint).toMatch(/current token has: current_user:read/);
    expect(restError(401, LIVE.invalidToken, "x").hint).toMatch(/expired \(personal access tokens last 1–90 days\)/);
  });
});

describe("scopes and expiry on the token status", () => {
  it("the check probes the token's scopes (a 403 lists them) without reporting an error", async () => {
    const net = fakeNet((c) => (c.url.endsWith("/me") ? json({ handle: "h" }) : new Response(LIVE.scope, { status: 403 })));
    const h = hub(net);
    const events: RestEvent[] = [];
    h.onEvent((e) => events.push(e));
    h.setPluginToken(TOKEN);
    const s = await settle(h);
    expect(s.state).toBe("valid");
    expect(s.scopes).toContain("file_versions:read");
    expect(net.calls.map((c) => c.url)).toEqual(["https://api.figma.com/v1/me", "https://api.figma.com/v1/teams/0/projects"]);
    expect(events.filter((e) => !e.ok)).toEqual([]); // the probe is not a failed request
  });

  it("a probe that cannot tell (any non-403) leaves scopes unknown", async () => {
    const h = hub(fakeNet((c) => (c.url.endsWith("/me") ? json({ handle: "h" }) : json({}, 404))));
    h.setPluginToken(TOKEN);
    expect((await settle(h)).scopes).toBeUndefined();
  });

  it("a missing scope on a real request keeps the token VALID and records the scope", async () => {
    const scopeBody = JSON.stringify({ error: true, status: 403, message: 'Invalid scope: ["file_content:read"]. This endpoint requires the file_comments:write scope.' });
    const net = fakeNet((c) => (c.url.endsWith("/me") ? json({ handle: "h" }) : c.method === "POST" ? new Response(scopeBody, { status: 403 }) : json({}, 404)));
    const h = hub(net);
    h.setPluginToken(TOKEN);
    await settle(h);
    const events: RestEvent[] = [];
    h.onEvent((e) => events.push(e));
    await h.fetch("https://api.figma.com/v1/files/K/comments", { method: "POST", body: "{}" });
    expect(h.getStatus()).toMatchObject({ state: "valid", missingScopes: ["file_comments:write"], scopes: ["file_content:read"] });
    expect(events[0]!.message).toBe("Missing scope file_comments:write");
  });

  it("the expiry the user gave travels on every status, and survives the check", async () => {
    const exp = Date.now() + 86_400_000;
    const h = hub(fakeNet((c) => (c.url.endsWith("/me") ? json({ handle: "h" }) : json({}, 404))));
    expect(h.setPluginToken(TOKEN, { expiresAt: exp }).expiresAt).toBe(exp);
    expect((await settle(h)).expiresAt).toBe(exp);
    // The same token from a reconnect hello with a corrected date updates it, no re-check.
    h.setPluginToken(TOKEN, { expiresAt: exp + 1000 });
    expect(h.getStatus().expiresAt).toBe(exp + 1000);
    h.setPluginToken(null);
    expect(h.getStatus().expiresAt).toBeUndefined();
  });
});

describe("figma_status hints for expiry and scopes", () => {
  it("warns under a day, says when the date has passed, and lists features a token cannot do", async () => {
    const { restTokenHints } = await import("../../src/server/tools.js");
    const now = 1_000_000_000_000;
    expect(restTokenHints({ state: "valid", source: "plugin", expiresAt: now + 3 * 3_600_000 }, now)[0]).toMatch(/expires in about 3h/);
    expect(restTokenHints({ state: "valid", source: "plugin", expiresAt: now - 1 }, now)[0]).toMatch(/has passed/);
    expect(restTokenHints({ state: "valid", source: "plugin", expiresAt: now + 5 * 86_400_000 }, now)).toEqual([]);
    const lacks = restTokenHints({ state: "valid", source: "plugin", scopes: ["current_user:read", "file_content:read", "file_comments:read"] }, now).join("\n");
    expect(lacks).toMatch(/file_comments:write \(postComment\)/);
    expect(lacks).toMatch(/file_versions:read \(get_versions\)/);
    expect(lacks).not.toMatch(/file_content:read \(/);
  });
});

describe("429 with a long Retry-After (live: 399946 s on a Starter plan)", () => {
  const LIVE_429 = () =>
    new Response('{"status":429,"err":"Rate limit exceeded"}', {
      status: 429,
      headers: { "retry-after": "399946", "x-figma-plan-tier": "starter", "x-figma-rate-limit-type": "low" },
    });

  it("RestClient gives up at once instead of sleeping through retries, and says when", async () => {
    const { RestClient } = await import("../../src/server/rest-read.js");
    let calls = 0;
    const c = new RestClient("t", async () => {
      calls++;
      return LIVE_429();
    });
    const started = Date.now();
    const e = (await c.get("/files/K?depth=1").catch((x) => x)) as { code: string; message: string; hint: string };
    expect(Date.now() - started).toBeLessThan(1000);
    expect(calls).toBe(1);
    expect(e.code).toBe("RATE_LIMITED");
    expect(e.message).toMatch(/retry in 4\.6 days.*plan tier "starter", limit "low"/);
    expect(e.hint).toMatch(/Do not retry now.*plugin/);
  });

  it("a short Retry-After is still waited out and retried", async () => {
    const { retryDelayMs } = await import("../../src/server/rest-hub.js");
    expect(retryDelayMs(new Headers({ "retry-after": "2" }), 0)).toBe(2000);
    expect(retryDelayMs(new Headers({ "retry-after": "399946" }), 0)).toBeNull();
    expect(retryDelayMs(new Headers(), 0)).toBe(2000);
    expect(retryDelayMs(new Headers({ "retry-after": "1" }), 3)).toBeNull(); // bounded attempts
  });

  it("the token status carries retryAt, tier and type for the badge and figma_status", async () => {
    const now = 1_000_000;
    const h = new RestHub({ env: () => undefined, now: () => now, fetch: async (u) => (u.endsWith("/me") ? json({ handle: "h" }) : u.includes("/teams/") ? json({}, 404) : LIVE_429()) });
    h.setPluginToken(TOKEN);
    await settle(h);
    await h.fetch("https://api.figma.com/v1/files/K", {});
    expect(h.getStatus()).toMatchObject({ state: "rate_limited", retryAt: now + 399946_000, planTier: "starter", rateLimitType: "low" });
    expect(h.getStatus().message).toMatch(/retry in 4\.6 days/);
  });

  it("a follower gets the tier headers from the leader too", async () => {
    const leader = new RestHub({ env: () => undefined, fetch: async (u) => (u.endsWith("/me") ? json({ handle: "h" }) : u.includes("/teams/") ? json({}, 404) : LIVE_429()) });
    leader.setPluginToken(TOKEN);
    await settle(leader);
    const follower = new RestHub({ env: () => undefined });
    follower.setRemote(() => async (req) => JSON.parse(JSON.stringify(await leader.serveForwarded(req))));
    const res = await follower.fetch("https://api.figma.com/v1/files/K", {});
    expect(res.status).toBe(429);
    expect(res.headers.get("x-figma-plan-tier")).toBe("starter");
    expect(res.headers.get("retry-after")).toBe("399946");
  });
});
