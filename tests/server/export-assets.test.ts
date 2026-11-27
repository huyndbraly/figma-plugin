import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planFiles, resolveDir, safeSegment } from "../../src/server/assets-export.js";
import { executeWrite } from "../../src/server/executor.js";
import { SessionRegistry } from "../../src/server/session.js";
import type { AnyOperation, BridgeResponse } from "../../src/shared/protocol.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "figma-plugin-assets-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("asset file names", () => {
  it("turns layer names into safe, readable file names", () => {
    expect(safeSegment("Icon/Arrow Left")).toBe("icon-arrow-left");
    expect(safeSegment("Nút bấm Đẹp")).toBe("nut-bam-dep");
    expect(safeSegment("../../etc/passwd")).toBe("etc-passwd");
    expect(safeSegment("   ")).toBe("asset");
    expect(safeSegment("IconButton")).toBe("icon-button");
  });

  it("names scales the iOS, Android or web way, and de-duplicates clashes", () => {
    const t = [{ nodeId: "1:1", name: "Logo" }, { nodeId: "1:2", name: "logo" }];
    const ios = planFiles(t, "/a", ["PNG", "SVG"], [1, 2], {}).map((p) => p.path);
    expect(ios).toEqual(["/a/logo.png", "/a/logo@2x.png", "/a/logo.svg", "/a/logo-2.png", "/a/logo-2@2x.png", "/a/logo-2.svg"]);
    expect(planFiles([t[0]!], "/a", ["PNG"], [1, 2, 3], { scaleNaming: "android" }).map((p) => p.path)).toEqual([
      "/a/drawable-mdpi/logo.png",
      "/a/drawable-xhdpi/logo.png",
      "/a/drawable-xxhdpi/logo.png",
    ]);
    expect(planFiles([t[0]!], "/a", ["PNG"], [2], { scaleNaming: "web" })[0]!.path).toBe("/a/logo-2x.png");
    expect(planFiles([{ nodeId: "1:3", name: "Icons/Close" }], "/a", ["SVG"], [1], { folders: true })[0]!.path).toBe("/a/icons/close.svg");
  });

  it("refuses a relative or root folder", () => {
    expect(() => resolveDir("assets")).toThrow(/absolute/);
    expect(() => resolveDir("/")).toThrow(/root/);
    expect(() => resolveDir("")).toThrow(/needs a `dir`/);
  });
});

/** A fake leader: one connected window holding three named nodes. */
function pluginRunner(opts: { channels?: number } = {}) {
  const calls: Array<{ op: AnyOperation; params: Record<string, unknown> }> = [];
  const names: Record<string, string> = { "1:1": "Icon/Close", "1:2": "Icon/Search", "1:3": "Hero", "1:4": "Size=sm, State=hover" };
  const runOp = async (op: AnyOperation, params: Record<string, unknown>): Promise<BridgeResponse> => {
    calls.push({ op, params });
    const ok = (result: unknown): BridgeResponse => ({ id: "x", ok: true, result });
    if (op === "list_channels") return ok(Array.from({ length: opts.channels ?? 1 }, () => ({ channel: "c" })));
    if (op === "get_nodes") {
      return ok({ nodes: (params.nodeIds as string[]).map((id) => (names[id] ? { id, name: names[id], ...(id === "1:4" ? { set: "Button" } : {}) } : { id, missing: true })) });
    }
    if (op === "get_node") return ok({ node: { id: params.nodeId, name: "Icons" }, children: [{ id: "1:1", name: "Icon/Close" }, { id: "1:2", name: "Icon/Search" }, { id: "1:9", name: "hidden", visible: false }] });
    if (op === "get_selection") return ok({ selection: [{ id: "1:3", name: "Hero" }] });
    if (op === "export_node") return ok({ base64: Buffer.from(`${params.nodeId}|${params.format}|${params.scale ?? ""}`).toString("base64") });
    return ok(null);
  };
  return { runOp, calls };
}

describe("figma.exportAssets through the plugin", () => {
  it("writes every format and scale to disk and returns paths, not bytes", async () => {
    const r = pluginRunner();
    const res = await executeWrite(
      `return await figma.exportAssets(["1:1", "1:3"], { dir: ${JSON.stringify(dir)}, formats: ["PNG", "SVG"], scales: [1, 2] });`,
      new SessionRegistry().get(),
      { runOp: r.runOp },
    );
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    const out = res.result as { files: Array<{ path: string; bytes: number }>; source: string };
    expect(out.source).toBe("plugin");
    expect(out.files.map((f) => f.path.slice(dir.length + 1))).toEqual([
      "icon-close.png",
      "icon-close@2x.png",
      "icon-close.svg",
      "hero.png",
      "hero@2x.png",
      "hero.svg",
    ]);
    expect(await readFile(join(dir, "icon-close@2x.png"), "utf8")).toBe("1:1|PNG|2");
    expect(await readFile(join(dir, "hero.svg"), "utf8")).toBe("1:3|SVG|");
    expect(JSON.stringify(res.result)).not.toContain("base64");
  });

  it("names a variant after its set", async () => {
    const r = pluginRunner();
    const res = await executeWrite(`return await figma.exportAssets(["1:4"], { dir: ${JSON.stringify(dir)} });`, new SessionRegistry().get(), { runOp: r.runOp });
    expect(await readdir(dir)).toEqual(["button-size-sm-state-hover.png"]);
    expect(res.ok).toBe(true);
  });

  it("exports the visible children of a frame, or the selection", async () => {
    const r = pluginRunner();
    const a = await executeWrite(`return await figma.exportAssets({ childrenOf: "1:0" }, { dir: ${JSON.stringify(dir)}, formats: "SVG" });`, new SessionRegistry().get(), { runOp: r.runOp });
    expect((a.result as { files: Array<{ name: string }> }).files.map((f) => f.name)).toEqual(["Icon/Close", "Icon/Search"]);
    const b = await executeWrite(`return await figma.exportAssets("selection", { dir: ${JSON.stringify(join(dir, "sel"))} });`, new SessionRegistry().get(), { runOp: r.runOp });
    expect(await readdir(join(dir, "sel"))).toEqual(["hero.png"]);
    expect(b.ok).toBe(true);
  });

  it("skips files that exist unless overwrite is set", async () => {
    await writeFile(join(dir, "hero.png"), "old");
    const r = pluginRunner();
    const first = await executeWrite(`return await figma.exportAssets(["1:3"], { dir: ${JSON.stringify(dir)} });`, new SessionRegistry().get(), { runOp: r.runOp });
    expect((first.result as { skipped: unknown[] }).skipped).toHaveLength(1);
    expect(await readFile(join(dir, "hero.png"), "utf8")).toBe("old");
    await executeWrite(`return await figma.exportAssets(["1:3"], { dir: ${JSON.stringify(dir)}, overwrite: true });`, new SessionRegistry().get(), { runOp: r.runOp });
    expect(await readFile(join(dir, "hero.png"), "utf8")).toBe("1:3|PNG|1");
  });

  it("names missing ids and refuses a relative dir before rendering anything", async () => {
    const r = pluginRunner();
    const miss = await executeWrite(`return await figma.exportAssets(["9:9"], { dir: ${JSON.stringify(dir)} });`, new SessionRegistry().get(), { runOp: r.runOp });
    expect(miss.error?.message).toMatch(/"9:9"/);
    const rel = await executeWrite(`return await figma.exportAssets(["1:1"], { dir: "assets" });`, new SessionRegistry().get(), { runOp: r.runOp });
    expect(rel.error?.message).toMatch(/absolute/);
    expect(r.calls.some((c) => c.op === "export_node")).toBe(false);
  });

  it("without a window and without REST set-up, says how to get either", async () => {
    const r = pluginRunner({ channels: 0 });
    const res = await executeWrite(`return await figma.exportAssets(["1:1"], { dir: ${JSON.stringify(dir)} });`, new SessionRegistry().get(), { runOp: r.runOp, figmaToken: "" });
    expect(res.error?.code).toBe("NOT_CONNECTED");
    expect(res.error?.hint).toMatch(/fileKey/);
  });
});

describe("figma.exportAssets through the REST API", () => {
  it("names files from /nodes, batches /images, retries a 429, downloads and writes", async () => {
    const r = pluginRunner({ channels: 0 });
    const seen: string[] = [];
    let imagesCalls = 0;
    const restFetch = async (url: string, init: RequestInit): Promise<Response> => {
      seen.push(url);
      expect((init.headers as Record<string, string>)["X-Figma-Token"]).toBe("tok");
      if (url.includes("/nodes?")) {
        return Response.json({ nodes: { "1:1": { document: { name: "Icon/Close" } }, "1:2": { document: { name: "Icon/Search" } } } });
      }
      if (url.includes("/images/")) {
        imagesCalls++;
        if (imagesCalls === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "0.01" } });
        const fmt = new URL(url).searchParams.get("format");
        return Response.json({ err: null, images: { "1:1": `https://cdn.example.com/1-${fmt}`, "1:2": `https://cdn.example.com/2-${fmt}` } });
      }
      return new Response("?", { status: 500 });
    };
    const imageFetch = async (url: string): Promise<Response> => new Response(`bytes:${url}`, { status: 200 });
    const res = await executeWrite(
      `return await figma.exportAssets(["1:1", "1:2"], { dir: ${JSON.stringify(dir)}, formats: ["SVG"], fileKey: "FILE123" });`,
      new SessionRegistry().get(),
      {
        runOp: r.runOp,
        figmaToken: "tok",
        restFetch,
        imageFetch,
        resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      },
    );
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect((res.result as { source: string }).source).toBe("rest");
    expect(await readFile(join(dir, "icon-close.svg"), "utf8")).toBe("bytes:https://cdn.example.com/1-svg");
    expect(await readFile(join(dir, "icon-search.svg"), "utf8")).toBe("bytes:https://cdn.example.com/2-svg");
    // One /images request for both ids (after the 429 retry), not one per node.
    expect(seen.filter((u) => u.includes("/images/"))).toHaveLength(2);
    expect(seen.find((u) => u.includes("/images/"))).toContain("ids=1%3A1%2C1%3A2");
  });

  it("explains a refused token", async () => {
    await mkdir(dir, { recursive: true });
    const r = pluginRunner({ channels: 0 });
    const res = await executeWrite(
      `return await figma.exportAssets(["1:1"], { dir: ${JSON.stringify(dir)}, fileKey: "F" });`,
      new SessionRegistry().get(),
      // The body Figma really sends for a rejected token (measured 2026-11-27).
      { runOp: r.runOp, figmaToken: "bad", restFetch: async () => new Response('{"status":403,"err":"Invalid token"}', { status: 403 }) },
    );
    expect(res.error?.code).toBe("UNAUTHORIZED");
    expect(res.error?.hint).toMatch(/FIGMA_TOKEN/);
  });
});
