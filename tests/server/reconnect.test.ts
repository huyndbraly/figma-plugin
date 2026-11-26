import { describe, it, expect, afterEach } from "vitest";
import { request as httpRequest } from "node:http";
import { WebSocket } from "ws";
import { Bridge, type BridgeHandlers, type BridgeOptions } from "../../src/server/bridge.js";
import { resolveRoute } from "../../src/server/route.js";
import type { WireMessage, BridgeRequest, PluginHello } from "../../src/shared/protocol.js";

/**
 * The reconnect gap: what happens to ops while a Figma window reloads, the
 * leader is taken over, or two windows of one file share a stored channel.
 * Every case here was a reproduced failure — an op landing on the wrong
 * file, failing in 0ms, or being reported as "retry" when it may already
 * have drawn.
 */

class Plugin {
  ws!: WebSocket;
  channel?: string;
  resumeToken?: string;
  page: string;
  received: BridgeRequest[] = [];
  /** Answer requests (default) or hold them so the test can. */
  answer = true;

  constructor(
    public fileName: string,
    page = "Page 1",
  ) {
    this.page = page;
  }

  async connect(port: number, hello: Partial<PluginHello> = {}, autoPong = true): Promise<this> {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { autoPong });
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
    this.ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as WireMessage;
      if (msg.type === "assigned") {
        this.channel = msg.channel;
        this.resumeToken = msg.resumeToken;
      }
      if (msg.type === "request") {
        this.received.push(msg.payload);
        if (this.answer) this.reply(msg.payload);
      }
    });
    this.ws.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: 6,
        pluginVersion: "1",
        fileKey: null,
        fileName: this.fileName,
        pageName: this.page,
        editorType: "figma",
        ...hello,
      }),
    );
    await waitFor(() => this.channel !== undefined, 3000);
    return this;
  }

  reply(req: BridgeRequest): void {
    if (req.op === "set_current_page") this.page = String((req.params as { name: string }).name);
    const result =
      req.op === "set_current_page" ? { name: this.page } : { file: this.fileName, page: this.page, op: req.op };
    this.ws.send(JSON.stringify({ type: "response", payload: { id: req.id, ok: true, result } }));
  }

  /** The window goes away without a goodbye. */
  kill(): void {
    this.ws.terminate();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("waitFor timed out");
    await delay(5);
  }
}

const bridges: Bridge[] = [];
async function newBridge(
  opts: BridgeOptions = {},
  onRpc?: BridgeHandlers["onRpc"],
): Promise<{ bridge: Bridge; port: number }> {
  const bridge = new Bridge(onRpc ? { onRpc } : {}, { livenessProbeMs: 200, reconnectGraceMs: 600, ...opts });
  bridges.push(bridge);
  const port = await bridge.listen(44000 + Math.floor(Math.random() * 900), "tok");
  return { bridge, port };
}

afterEach(async () => {
  while (bridges.length) await bridges.pop()?.close();
});

describe("a session whose window is reconnecting", () => {
  it("waits for its own window instead of re-pinning to another file", async () => {
    const { bridge, port } = await newBridge();
    const a = await new Plugin("File A").connect(port);
    const b = await new Plugin("File B").connect(port);
    await bridge.dispatch("get_selection", {}, { sessionId: "s1", file: "File A" });
    expect(bridge.sessionBinding("s1")).toBe(a.channel);

    a.kill();
    await delay(30);
    // Previously this routed to File B in ~0ms ("single") and re-bound s1 there.
    const pending = bridge.dispatch("get_selection", {}, { sessionId: "s1" });
    await delay(100);
    expect(b.received.map((r) => r.op)).toEqual([]);

    const a2 = await new Plugin("File A").connect(port, { channel: a.channel, resumeToken: a.resumeToken });
    const res = await pending;
    expect((res.result as { file: string }).file).toBe("File A");
    expect(a2.channel).toBe(a.channel);
    expect(bridge.sessionBinding("s1")).toBe(a.channel);
  });

  it("fails CHANNEL_NOT_FOUND naming the file it was on when the window does not come back", async () => {
    const { bridge, port } = await newBridge();
    const a = await new Plugin("File A", "Flows").connect(port);
    const b = await new Plugin("File B").connect(port);
    await bridge.dispatch("get_selection", {}, { sessionId: "s1", file: "File A" });
    a.kill();
    await delay(30);

    const t0 = Date.now();
    const err = await bridge.dispatch("get_selection", {}, { sessionId: "s1" }).catch((e: unknown) => e);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400); // it waited the grace
    expect(err).toMatchObject({ code: "CHANNEL_NOT_FOUND", message: expect.stringContaining("File A") });
    expect((err as Error).message).toContain("Flows");
    expect(b.received).toHaveLength(0);
    expect(bridge.sessionBinding("s1")).toBe(a.channel);
  });

  it("follows its window when it comes back under a NEW channel (same file)", async () => {
    const { bridge, port } = await newBridge();
    const a = await new Plugin("File A").connect(port);
    await new Plugin("File B").connect(port);
    await bridge.dispatch("get_selection", {}, { sessionId: "s1", file: "File A" });
    a.kill();
    await delay(30);

    const pending = bridge.dispatch("get_selection", {}, { sessionId: "s1" });
    // Storage lost: it rejoins without its channel.
    const a2 = await new Plugin("File A").connect(port);
    expect(a2.channel).not.toBe(a.channel);
    const res = await pending;
    expect((res.result as { file: string }).file).toBe("File A");
    expect(res.warnings?.join(" ")).toMatch(/reconnected as channel/);
    expect(bridge.sessionBinding("s1")).toBe(a2.channel);
  });
});

describe("ops in the reconnect gap", () => {
  it("an op naming its file waits for that window instead of failing in 0ms", async () => {
    const { bridge, port } = await newBridge();
    const pending = bridge.dispatch("get_selection", {}, { file: "File A" });
    await delay(50);
    await new Plugin("File A").connect(port);
    expect(((await pending).result as { file: string }).file).toBe("File A");
  });

  it("parked ops are routed one by one on hello, not drained onto the first window", async () => {
    const { bridge, port } = await newBridge({ reconnectGraceMs: 2000 });
    const a = await new Plugin("File A").connect(port);
    const b = await new Plugin("File B").connect(port);
    await bridge.dispatch("get_selection", {}, { sessionId: "sa", file: "File A" });
    await bridge.dispatch("get_selection", {}, { sessionId: "sb", file: "File B" });
    a.kill();
    b.kill();
    await delay(30);

    const forA = bridge.dispatch("get_selection", {}, { sessionId: "sa" });
    const forB = bridge.dispatch("get_selection", {}, { sessionId: "sb" });
    await delay(30);
    // B reconnects first; previously every parked op drained onto it.
    const b2 = await new Plugin("File B").connect(port, { channel: b.channel, resumeToken: b.resumeToken });
    expect(((await forB).result as { file: string }).file).toBe("File B");
    expect(b2.received.filter((r) => r.op === "get_selection")).toHaveLength(1);
    await new Plugin("File A").connect(port, { channel: a.channel, resumeToken: a.resumeToken });
    expect(((await forA).result as { file: string }).file).toBe("File A");
  });

  it("a fresh session does not guess 'the only window' while another just left", async () => {
    const { bridge, port } = await newBridge();
    const a = await new Plugin("File A").connect(port);
    const b = await new Plugin("File B").connect(port);
    a.kill();
    await delay(30);
    const t0 = Date.now();
    const res = await bridge.dispatch("get_selection", {}, { sessionId: "new" });
    // It held the op through the grace; then B is the only window and wins.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
    expect(res).toMatchObject({ result: { file: "File B" } });
    expect(b.received).toHaveLength(1);
  });
});

describe("requests lost with a connection", () => {
  it("a write on the wire says it may have completed; a queued op says nothing was sent", async () => {
    const { bridge, port } = await newBridge();
    const p = await new Plugin("File A").connect(port);
    p.answer = false;
    const write = bridge.dispatch("create", { type: "FRAME" }).catch((e: unknown) => e);
    const queued = bridge.dispatch("get_selection", {}).catch((e: unknown) => e);
    await waitFor(() => p.received.length === 1);
    p.kill();
    const [w, q] = await Promise.all([write, queued]);
    expect(w).toMatchObject({ code: "NOT_CONNECTED", hint: expect.stringContaining("may well have completed") });
    expect(q).toMatchObject({ code: "NOT_CONNECTED", hint: expect.stringContaining("Nothing was sent") });
  });

  it("on a reconnect, ops that never left the queue run on the new connection", async () => {
    const { bridge, port } = await newBridge();
    const p = await new Plugin("File A").connect(port, {}, false); // dead: never pongs
    p.answer = false;
    const first = bridge.dispatch("get_selection", {}).catch((e: unknown) => e);
    const second = bridge.dispatch("get_selection", { n: 2 });
    await waitFor(() => p.received.length === 1);

    const p2 = await new Plugin("File A").connect(port, { channel: p.channel, resumeToken: p.resumeToken });
    expect(p2.channel).toBe(p.channel);
    expect(await first).toMatchObject({ code: "NOT_CONNECTED" });
    expect(((await second).result as { file: string }).file).toBe("File A");
    expect(p2.received.map((r) => r.params)).toEqual([{ n: 2 }]);
  });
});

describe("a resume hello for a channel whose socket is alive", () => {
  it("gets a fresh channel; the live window keeps its own", async () => {
    const { bridge, port } = await newBridge();
    const first = await new Plugin("Untitled").connect(port);
    // A second window of the same file read the same stored channel + token.
    const second = await new Plugin("Untitled").connect(port, {
      channel: first.channel,
      resumeToken: first.resumeToken,
    });
    expect(second.channel).not.toBe(first.channel);
    expect(first.ws.readyState).toBe(WebSocket.OPEN);
    const res = await bridge.dispatch("get_selection", {}, { channel: first.channel });
    expect(res.ok).toBe(true);
    expect(first.received).toHaveLength(1);
    expect(bridge.channelCount).toBe(2);
  });
});

describe("page switch and op are queued together", () => {
  it("two sessions on different pages of one window never run on each other's page", async () => {
    const { bridge, port } = await newBridge();
    const p = await new Plugin("File A", "Cover").connect(port);
    const [one, two] = await Promise.all([
      bridge.dispatch("get_selection", {}, { sessionId: "s1", file: "File A", page: "Flows" }),
      bridge.dispatch("get_selection", {}, { sessionId: "s2", file: "File A", page: "Specs" }),
    ]);
    expect((one.result as { page: string }).page).toBe("Flows");
    expect((two.result as { page: string }).page).toBe("Specs");
    expect(p.received.map((r) => r.op)).toEqual([
      "set_current_page",
      "get_selection",
      "set_current_page",
      "get_selection",
    ]);
  });

  it("a failed switch cancels its op before it is sent", async () => {
    const { bridge, port } = await newBridge();
    const p = await new Plugin("File A", "Cover").connect(port);
    p.answer = false;
    const res = bridge.dispatch("create", { type: "FRAME" }, { file: "File A", page: "Nope" }).catch((e: unknown) => e);
    await waitFor(() => p.received.length === 1);
    const sw = p.received[0]!;
    p.ws.send(
      JSON.stringify({
        type: "response",
        payload: { id: sw.id, ok: false, error: { code: "NODE_NOT_FOUND", message: "No page Nope" } },
      }),
    );
    expect(await res).toMatchObject({ code: "NODE_NOT_FOUND" });
    await delay(30);
    expect(p.received.map((r) => r.op)).toEqual(["set_current_page"]);
  });
});

describe("an abandoned /rpc call", () => {
  it("drops its op from the queue when the follower's request closes", async () => {
    let bridge!: Bridge;
    const made = await newBridge({}, (op, params, sessionId, _route, signal) =>
      bridge.dispatch(op as "get_selection", params, { ...(sessionId ? { sessionId } : {}), ...(signal ? { signal } : {}) }),
    );
    bridge = made.bridge;
    const p = await new Plugin("File A").connect(made.port);
    p.answer = false;
    const busy = bridge.dispatch("get_selection", {}, { timeoutMs: 2000 }).catch(() => undefined);
    await waitFor(() => p.received.length === 1);

    const req = httpRequest({
      host: "127.0.0.1",
      port: made.port,
      path: "/rpc",
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
    });
    req.on("error", () => {});
    req.end(JSON.stringify({ op: "create", params: { marker: "abandoned" } }));
    await waitFor(() => bridge.queueLength === 1);
    req.destroy();
    await waitFor(() => bridge.queueLength === 0);

    p.reply(p.received[0]!);
    await busy;
    await delay(30);
    expect(p.received.map((r) => r.op)).toEqual(["get_selection"]);
  });
});

describe("resolveRoute with recently disconnected windows", () => {
  const win = (channel: string, fileName: string) => ({
    channel,
    fileName,
    pageName: "P",
    lastUserActivityAt: 0,
    queueLength: 0,
  });

  it("an explicit file matching a window that just left waits for it", () => {
    const d = resolveRoute({
      file: "File A",
      windows: [win("b", "File B")],
      gone: [{ channel: "a", fileName: "File A", pageName: "P", goneAt: 1_000 }],
      now: 2_000,
      graceMs: 15_000,
    });
    expect(d).toMatchObject({ ok: false, waitUntil: 16_000 });
  });

  it("a file nobody had open fails at once", () => {
    const d = resolveRoute({
      file: "File Z",
      windows: [win("b", "File B")],
      gone: [{ channel: "a", fileName: "File A", pageName: "P", goneAt: 1_000 }],
      now: 2_000,
    });
    expect(d.ok).toBe(false);
    expect((d as { waitUntil?: number }).waitUntil).toBeUndefined();
  });

  it("past the grace, a bound session refuses instead of guessing another file", () => {
    const d = resolveRoute({
      sessionBoundChannel: "a",
      sessionBoundLast: { fileName: "File A", pageName: "P" },
      windows: [win("b", "File B")],
      gone: [{ channel: "a", fileName: "File A", pageName: "P", goneAt: 1_000 }],
      now: 60_000,
      graceMs: 15_000,
    });
    expect(d).toMatchObject({ ok: false, code: "CHANNEL_NOT_FOUND" });
    expect((d as { message: string }).message).toContain("File A");
  });
});
