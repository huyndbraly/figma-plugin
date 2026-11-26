import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { executeWrite, fetchImageFollowingSafeRedirects, type ExecutorDeps } from "../../src/server/executor.js";
import { defaultFetcher, type Fetcher } from "../../src/server/icons.js";
import { SessionRegistry, type Session } from "../../src/server/session.js";
import { validateOperation } from "../../src/server/validate.js";
import { ErrorCode, type AnyOperation, type BridgeResponse } from "../../src/shared/protocol.js";

/**
 * Regressions from a review of the figma_write executor: batch warnings and
 * timeouts, positional-arg shapes, undefined args across the worker boundary,
 * host-written state, in-flight ops at the deadline and at a normal finish,
 * and server-side resolution inside batch.
 */

type Ctx = { signal?: AbortSignal; timeoutMs?: number };
type Call = { op: AnyOperation; params: Record<string, unknown>; ctx?: Ctx };

/** A runner that validates like index.ts does, then answers from `answer`. */
function runner(answer?: (op: AnyOperation, params: Record<string, unknown>, ctx?: Ctx) => Promise<BridgeResponse> | BridgeResponse) {
  const calls: Call[] = [];
  const runOp = async (op: AnyOperation, params: Record<string, unknown>, ctx?: Ctx): Promise<BridgeResponse> => {
    const v = validateOperation(op, params);
    calls.push({ op: v.op, params: v.params, ...(ctx ? { ctx } : {}) });
    if (answer) return answer(v.op, v.params, ctx);
    if (v.op === "batch") {
      const ops = v.params.ops as unknown[];
      return { id: "x", ok: true, result: { items: ops.map(() => ({ ok: true, result: { id: "1:1" } })) } };
    }
    return { id: "x", ok: true, result: { id: "1:1" } };
  };
  return { runOp, calls };
}

const session = (): Session => new SessionRegistry().get();
const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
/** A fresh icon name per call: the icon cache is on disk and shared. */
const freshIcon = () => `zz-review-${Math.random().toString(36).slice(2, 10)}`;
const iconFetcher: Fetcher = async () => ({ ok: true, status: 200, text: async () => svg });

describe("figma.batch", () => {
  it("surfaces each item's warnings, once", async () => {
    const r = runner((op, params) => {
      const ops = params.ops as unknown[];
      return {
        id: "x",
        ok: true,
        result: { items: ops.map(() => ({ ok: true, result: { id: "1:1" }, warnings: ["clamped radius", "font fell back"] })) },
      };
    });
    const res = await executeWrite(
      `return figma.batch([{ op: "create", params: { type: "FRAME" } }, { op: "create", params: { type: "FRAME" } }]);`,
      session(),
      { runOp: r.runOp },
    );
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(res.warnings.filter((w) => w === "clamped radius")).toHaveLength(1);
    expect(res.warnings).toContain("font fell back");
  });

  it("times each chunk by the ops in it, not the flat 30s of a batch dispatch", async () => {
    const r = runner();
    const res = await executeWrite(
      `return figma.batch([
        { op: "instantiate", params: { component: "Button" } },
        { op: "create", params: { type: "FRAME" } },
        { op: "responsive_audit", params: { nodeId: "1:2" } },
      ]);`,
      session(),
      { runOp: r.runOp },
    );
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    const batch = r.calls.find((c) => c.op === "batch");
    expect(batch?.ctx?.timeoutMs).toBe(60_000 + 30_000 + 120_000);
    // The per-call abort signal still rides along.
    expect(batch?.ctx?.signal).toBeInstanceOf(AbortSignal);
  });

  it("fails a null item at its own index and runs the rest", async () => {
    const r = runner();
    const res = await executeWrite(
      `return figma.batch([{ op: "create", params: { type: "FRAME" } }, null, { op: "create", params: { type: "TEXT" } }]);`,
      session(),
      { runOp: r.runOp },
    );
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    const out = res.result as { ok: number; failed: number; results: Array<{ index: number; ok: boolean; error?: { code: string } }> };
    expect(out.ok).toBe(2);
    expect(out.results[1]).toMatchObject({ index: 1, ok: false, error: { code: ErrorCode.INVALID_PARAMS } });
  });

  it("resolves load_image sources server-side: a URL is fetched, a data: URI stripped", async () => {
    const r = runner();
    const fetched: string[] = [];
    const deps: ExecutorDeps = {
      runOp: r.runOp,
      imageFetcher: async (url) => {
        fetched.push(url);
        return "QUJD";
      },
    };
    const res = await executeWrite(
      `return figma.batch([
        { op: "load_image", params: { source: "https://example.com/a.png", w: 10 } },
        { op: "load_image", params: { source: "data:image/png;base64,REVG" } },
        { op: "load_image", params: { base64: "R0hJ" } },
      ]);`,
      session(),
      deps,
    );
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(fetched).toEqual(["https://example.com/a.png"]);
    const sent = (r.calls.find((c) => c.op === "batch")!.params.ops as Array<{ params: Record<string, unknown> }>).map((o) => o.params);
    expect(sent[0]).toEqual({ base64: "QUJD", w: 10 });
    expect(sent[1]).toEqual({ base64: "REVG" });
    expect(sent[2]).toEqual({ base64: "R0hJ" });
  });

  it("loads a load_icon item's SVG by name, and rejects one with neither name nor svg", async () => {
    const r = runner();
    const name = freshIcon();
    const res = await executeWrite(
      `return figma.batch([
        { op: "load_icon", params: { name: ${JSON.stringify(name)}, size: 16, x: 4 } },
        { op: "load_icon", params: { size: 16 } },
      ]);`,
      session(),
      { runOp: r.runOp, iconFetcher },
    );
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    const out = res.result as { results: Array<{ ok: boolean; error?: { hint?: string } }> };
    expect(out.results[0]!.ok).toBe(true);
    expect(out.results[1]!.ok).toBe(false);
    expect(out.results[1]!.error?.hint).toContain("figma.loadIcon");
    const sent = r.calls.find((c) => c.op === "batch")!.params.ops as Array<{ params: Record<string, unknown> }>;
    expect(sent).toHaveLength(1);
    expect(sent[0]!.params).toMatchObject({ name, svg, size: 16, x: 4, library: "lucide" });
  });
});

describe("positional args", () => {
  it("passes a single options bag through for node ops (exportNode, layoutAudit, resize)", async () => {
    const r = runner();
    const res = await executeWrite(
      `await figma.exportNode({ nodeId: "1:2", format: "SVG" });
       await figma.layoutAudit({ nodeId: "1:3" });
       await figma.resize({ nodeId: "1:4", width: 10, height: 20 });
       await figma.clone("1:5", { x: 3 });`,
      session(),
      { runOp: r.runOp },
    );
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(r.calls.map((c) => [c.op, c.params])).toEqual([
      ["export_node", { nodeId: "1:2", format: "SVG" }],
      ["layout_audit", { nodeId: "1:3" }],
      ["resize", { nodeId: "1:4", width: 10, height: 20 }],
      ["clone", expect.objectContaining({ nodeId: "1:5", x: 3 })],
    ]);
  });

  it("forwards every load_icon placement option, not just size/color/parentId", async () => {
    const r = runner();
    const name = freshIcon();
    const res = await executeWrite(
      `return figma.loadIcon(${JSON.stringify(name)}, { library: "lucide", size: 20, color: "#000000", parentId: "1:2", x: 4, y: 5, inset: 8, align: "center", insertAt: 0 });`,
      session(),
      { runOp: r.runOp, iconFetcher },
    );
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(r.calls[0]!.params).toEqual({
      name,
      canonical: name,
      library: "lucide",
      svg,
      size: 20,
      color: "#000000",
      parentId: "1:2",
      x: 4,
      y: 5,
      inset: 8,
      align: "center",
      insertAt: 0,
    });
  });

  it("keeps an undefined arg undefined across the worker boundary", async () => {
    const r = runner();
    const s = session();
    const res = await executeWrite(
      `await figma.a11yAudit(undefined, { minTouch: 48 });
       await figma.loadIcon(${JSON.stringify(freshIcon())}, undefined);
       await figma.batch([{ op: "create", params: { type: "FRAME" } }], undefined);
       figma.useComponentMap({ components: { Button: { figma: "Button" } } });
       await figma.render("Button", {}, undefined);
       await figma.loadImage("QUJD", null);
       return true;`,
      s,
      { runOp: r.runOp, iconFetcher },
    );
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(r.calls[0]).toMatchObject({ op: "a11y_audit", params: { minTouch: 48 } });
    expect(r.calls[0]!.params.nodeId).toBeUndefined();
    expect(r.calls.map((c) => c.op)).toEqual(["a11y_audit", "load_icon", "batch", "instantiate", "load_image"]);
  });

  it("merges opts after a {key} component ref, and accepts {key} as the swap target", async () => {
    const r = runner();
    const res = await executeWrite(
      `await figma.instantiate({ key: "abc123" }, { parentId: "1:2", variant: { Size: "lg" } });
       await figma.instantiate({ key: "abc123" }, "1:3");
       await figma.swapComponent("5:5", { key: "def456" }, { variant: { Tone: "x" } });
       await figma.swapComponent("5:5", { id: "7:7", key: "local-key", name: "Icon" });`,
      session(),
      { runOp: r.runOp },
    );
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(r.calls[0]!.params).toEqual({ key: "abc123", parentId: "1:2", variant: { Size: "lg" }, placeGroup: expect.any(String) });
    expect(r.calls[1]!.params).toMatchObject({ key: "abc123", parentId: "1:3" });
    expect(r.calls[2]!.params).toEqual({ nodeId: "5:5", key: "def456", variant: { Tone: "x" } });
    // A node read back from Figma swaps by its id: an unpublished key would not import.
    expect(r.calls[3]!.params).toEqual({ nodeId: "5:5", componentId: "7:7" });
  });
});

describe("validation", () => {
  it("lifts component: {key} to key for instantiate and swap_component", () => {
    expect(validateOperation("swap_component", { nodeId: "5:5", component: { key: "k1" } }).params).toEqual({ nodeId: "5:5", key: "k1" });
    expect(validateOperation("instantiate", { component: { key: "k2" }, parentId: "1:2" }).params).toEqual({ key: "k2", parentId: "1:2" });
  });

  it("accepts set_instance_properties with props as well as properties", () => {
    expect(() => validateOperation("set_instance_properties", { nodeId: "5:5", props: { Label: "Hi" } })).not.toThrow();
    expect(() => validateOperation("set_instance_properties", { nodeId: "5:5", properties: { Label: "Hi" } })).not.toThrow();
    expect(() => validateOperation("set_instance_properties", { nodeId: "5:5" })).toThrow(/properties/);
  });
});

describe("state written by the host", () => {
  it("is visible later in the same call, and in-call edits to it survive the exit sync", async () => {
    const r = runner();
    const s = session();
    const res = await executeWrite(
      `await figma.setupTokens({ colors: { primary: "#112233" } });
       const seen = state.tokens && state.tokens.primary;
       state.tokens.accent = "#445566";
       figma.useComponentMap({ components: { Button: { figma: "Button" } } });
       await figma.getNode("1:1");
       return { seen, map: Boolean(state.componentMap && state.componentMap.components.Button) };`,
      s,
      { runOp: r.runOp },
    );
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(res.result).toEqual({ seen: "#112233", map: true });
    expect(s.state.tokens).toEqual({ primary: "#112233", accent: "#445566" });
    expect(s.state.componentMap).toEqual({ components: { Button: { figma: "Button" } } });
  });

  it("still lands when the sandbox never saw it (not awaited before return)", async () => {
    const r = runner(async (op) => {
      if (op === "setup_tokens") await new Promise((res) => setTimeout(res, 30));
      return { id: "x", ok: true, result: {} };
    });
    const s = session();
    const res = await executeWrite(`figma.setupTokens({ colors: { primary: "#112233" } }); state.x = 1;`, s, { runOp: r.runOp });
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(s.state).toMatchObject({ x: 1, tokens: { primary: "#112233" } });
  });
});

describe("ops still running", () => {
  it("at the deadline: the hint names the op and warns a write may have landed", async () => {
    const r = runner(
      (_op, _p, ctx) =>
        new Promise<BridgeResponse>((_res, rej) => {
          ctx?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
        }),
    );
    const res = await executeWrite(`await figma.create({ type: "FRAME" });`, session(), { runOp: r.runOp }, { timeoutMs: 200 });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe(ErrorCode.PLUGIN_TIMEOUT);
    expect(res.error?.hint).toContain("figma.create");
    expect(res.error?.hint).toContain("NOT cancelled");
    expect(res.error?.hint).not.toContain("synchronous loop");
  }, 20_000);

  it("at the deadline with nothing in flight: the sync-loop hint stays", async () => {
    const res = await executeWrite(`await figma.getNode("1:1"); while (true) {}`, session(), { runOp: runner().runOp }, { timeoutMs: 200 });
    expect(res.error?.code).toBe(ErrorCode.PLUGIN_TIMEOUT);
    expect(res.error?.hint).toContain("synchronous loop");
  }, 20_000);

  it("on a normal finish: un-awaited ops are waited for and their errors become warnings", async () => {
    let settledAt = 0;
    const r = runner(async (op) => {
      await new Promise((res) => setTimeout(res, 50));
      settledAt = Date.now();
      return op === "delete"
        ? { id: "x", ok: false, error: { code: ErrorCode.NODE_NOT_FOUND, message: "no node 9:9" } }
        : { id: "x", ok: true, result: { id: "1:1" } };
    });
    const res = await executeWrite(`figma.create({ type: "FRAME" }); figma.delete("9:9"); return 1;`, session(), { runOp: r.runOp });
    const returnedAt = Date.now();
    expect(res.ok).toBe(true);
    expect(settledAt).toBeGreaterThan(0);
    expect(settledAt).toBeLessThanOrEqual(returnedAt);
    expect(res.warnings.some((w) => w.includes("figma.delete") && w.includes("no node 9:9"))).toBe(true);
  });

  it("on a normal finish past the budget: what is still queued is aborted, with a warning", async () => {
    let aborted = false;
    const r = runner(
      (_op, _p, ctx) =>
        new Promise<BridgeResponse>((_res, rej) => {
          ctx?.signal?.addEventListener("abort", () => {
            aborted = true;
            rej(new Error("aborted"));
          });
        }),
    );
    const res = await executeWrite(`figma.create({ type: "FRAME" }); return 1;`, session(), { runOp: r.runOp }, { timeoutMs: 100 });
    expect(res.ok).toBe(true);
    expect(aborted).toBe(true);
    expect(res.warnings.some((w) => w.includes("still running") && w.includes("figma.create"))).toBe(true);
  }, 20_000);
});

describe("server-side fetches follow the call's abort signal", () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.closeAllConnections();
    server?.close();
    server = undefined;
  });

  it("hands the signal to the image fetcher and the icon fetcher", async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const deps: ExecutorDeps = {
      runOp: runner().runOp,
      imageFetcher: async (_url, init) => {
        seen.push(init?.signal);
        return "QUJD";
      },
      iconFetcher: async (_url, init) => {
        seen.push(init?.signal);
        return { ok: true, status: 200, text: async () => svg };
      },
    };
    const res = await executeWrite(
      `await figma.loadImage("https://example.com/a.png"); await figma.loadIcon(${JSON.stringify(freshIcon())});`,
      session(),
      deps,
    );
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(seen).toHaveLength(2);
    for (const s of seen) expect(s).toBeInstanceOf(AbortSignal);
  });

  it("passes the signal to each redirect hop's transport", async () => {
    const ctl = new AbortController();
    const inits: RequestInit[] = [];
    await fetchImageFollowingSafeRedirects(
      "https://example.com/a.png",
      async (_u, init) => {
        inits.push(init);
        return new Response("x", { status: 200 });
      },
      async () => [{ address: "93.184.216.34", family: 4 }],
      ctl.signal,
    );
    expect(inits[0]!.signal).toBe(ctl.signal);
  });

  it("the default icon fetcher stops when the caller aborts", async () => {
    server = createServer(() => {
      /* never answers */
    });
    await new Promise<void>((res) => server!.listen(0, "127.0.0.1", () => res()));
    const { port } = server.address() as AddressInfo;
    const ctl = new AbortController();
    const t0 = Date.now();
    const p = defaultFetcher(`http://127.0.0.1:${port}/icon.svg`, { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 50);
    await expect(p).rejects.toThrow(/cancelled/);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
