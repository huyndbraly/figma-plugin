/**
 * Module 1 of the Claude Desktop upgrade (2026-11-27): images from a file or
 * URL without base64 in the agent's context, local background removal, and
 * BYOK image generation with keys from the plugin panel (OpenAI, Gemini, Flux).
 */
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { MAX_IMAGE_FILE_BYTES, readImageFile, resolveImagePath, sniffImage } from "../../src/server/image-file.js";
import { loadBackgroundRemover, removeBackgroundPng, resetBackgroundRemover, type BackgroundRemover } from "../../src/server/bg-removal.js";
import { chooseImageProvider, generateImage, loadByokConfig } from "../../src/server/byok.js";
import { AiKeyStore } from "../../src/server/ai-keys.js";
import { cleanAiKeySet, maskAiKey } from "../../src/shared/ai-key.js";
import { executeWrite } from "../../src/server/executor.js";
import { SessionRegistry } from "../../src/server/session.js";
import { Bridge } from "../../src/server/bridge.js";
import { validateOperation } from "../../src/server/validate.js";
import type { BridgeResponse, WireMessage } from "../../src/shared/protocol.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const GIF = Buffer.from("GIF89a\u0001\u0000", "latin1");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
const PNG_B64 = PNG.toString("base64");
const CUT = Buffer.concat([PNG, Buffer.from("cut-out")]);

const ok = (result: unknown): BridgeResponse => ({ id: "x", ok: true, result });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "figma-media-"));
  resetBackgroundRemover();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
describe("image files read by the server (loadImage { filePath })", () => {
  it("sniffs PNG, JPEG, GIF and WebP by their first bytes", () => {
    expect(sniffImage(PNG)).toBe("png");
    expect(sniffImage(JPEG)).toBe("jpeg");
    expect(sniffImage(GIF)).toBe("gif");
    expect(sniffImage(WEBP)).toBe("webp");
    expect(sniffImage(Buffer.from("SECRET=1"))).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
  });

  it("takes absolute paths, ~/ and file:// URLs; refuses relative ones", () => {
    expect(resolveImagePath("/a/b.png")).toBe("/a/b.png");
    expect(resolveImagePath("~/x.png")).toBe(join(homedir(), "x.png"));
    expect(resolveImagePath(pathToFileURL("/tmp/y z.png").href)).toBe("/tmp/y z.png");
    expect(() => resolveImagePath("assets/hero.png")).toThrow(/absolute/);
    expect(() => resolveImagePath("")).toThrow(/non-empty/);
  });

  it("reads a real image to base64", async () => {
    const p = join(dir, "hero.png");
    await writeFile(p, PNG);
    expect(await readImageFile(p)).toMatchObject({ base64: PNG_B64, kind: "png", bytes: PNG.length, path: p });
  });

  it("never reads a non-image into Figma, and never quotes it", async () => {
    const p = join(dir, ".env");
    await writeFile(p, "OPENAI_API_KEY=sk-very-secret");
    const e = await readImageFile(p).catch((x) => x);
    expect(e).toMatchObject({ code: "INVALID_PARAMS" });
    expect(e.message).toMatch(/not a PNG, JPEG or GIF/);
    expect(`${e.message} ${e.hint}`).not.toContain("sk-very-secret");
  });

  it("explains WebP, a missing file, a directory and an oversized file", async () => {
    const w = join(dir, "a.webp");
    await writeFile(w, WEBP);
    await expect(readImageFile(w)).rejects.toThrow(/WebP/);
    await expect(readImageFile(join(dir, "nope.png"))).rejects.toThrow(/No file at/);
    await mkdir(join(dir, "folder"));
    await expect(readImageFile(join(dir, "folder"))).rejects.toThrow(/not a file/);
    const big = join(dir, "big.png");
    await writeFile(big, Buffer.alloc(MAX_IMAGE_FILE_BYTES + 1));
    await expect(readImageFile(big)).rejects.toThrow(/over the 32 MB limit/);
  });
});

// ---------------------------------------------------------------------------
async function write(code: string, extra: Partial<Parameters<typeof executeWrite>[2]> = {}, answer: (op: string, params: any) => unknown = () => ({ id: "9:1" })) {
  const calls: Array<[string, any]> = [];
  const res = await executeWrite(code, new SessionRegistry().get(), {
    runOp: async (op, params) => {
      calls.push([op, params]);
      return ok(answer(op, params));
    },
    ...extra,
  });
  return { res, calls };
}

describe("figma.loadImage without base64 in the agent's context", () => {
  it("{ filePath } is read by the server and named after the file; the result has no bytes", async () => {
    const p = join(dir, "Hero Banner.png");
    await writeFile(p, PNG);
    const { res, calls } = await write(`return await figma.loadImage({ filePath: ${JSON.stringify(p)}, parentId: "1:1", w: 200 });`);
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(calls).toEqual([["load_image", { name: "Hero Banner", parentId: "1:1", w: 200, base64: PNG_B64 }]]);
    expect(JSON.stringify(res.result)).not.toContain(PNG_B64);
  });

  it("a file:// URL works positionally; an explicit name wins", async () => {
    const p = join(dir, "a.jpg");
    await writeFile(p, JPEG);
    const { res, calls } = await write(`return await figma.loadImage(${JSON.stringify(pathToFileURL(p).href)}, { name: "Photo" });`);
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(calls[0]![1]).toEqual({ name: "Photo", base64: JPEG.toString("base64") });
  });

  it("{ imageUrl } is fetched by the server", async () => {
    const fetched: string[] = [];
    const { res, calls } = await write(`return await figma.loadImage({ imageUrl: "https://example.com/a.png" });`, {
      imageFetcher: async (u) => {
        fetched.push(u);
        return PNG_B64;
      },
    });
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(fetched).toEqual(["https://example.com/a.png"]);
    expect(calls[0]![1]).toEqual({ base64: PNG_B64 });
  });

  it("refuses two sources at once and a non-http imageUrl", async () => {
    const two = await write(`return await figma.loadImage({ filePath: "/a.png", imageUrl: "https://x/y.png" });`);
    expect(two.res.error).toMatchObject({ code: "INVALID_PARAMS", message: expect.stringMatching(/more than one image source/) });
    const bad = await write(`return await figma.loadImage({ imageUrl: "ftp://x/y.png" });`);
    expect(bad.res.error?.message).toMatch(/http\(s\) URL/);
    expect(bad.calls).toEqual([]);
  });

  it("works inside figma.batch too", async () => {
    const p = join(dir, "b.gif");
    await writeFile(p, GIF);
    const { res, calls } = await write(`return await figma.batch([{ op: "load_image", params: { filePath: ${JSON.stringify(p)}, parentId: "1:1" } }]);`);
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    const sent = JSON.stringify(calls);
    expect(sent).toContain(GIF.toString("base64"));
    expect(sent).not.toContain("filePath");
  });

  it("load_image validates replaceId / besideId as node ids, one at a time", () => {
    expect(() => validateOperation("load_image", { base64: "x", replaceId: "1:2", besideId: "1:3" })).toThrow(/OR besideId/);
    expect(() => validateOperation("load_image", { base64: "x", besideId: "" })).toThrow();
    expect(validateOperation("load_image", { base64: "x", besideId: "1:3" }).params).toMatchObject({ besideId: "1:3" });
  });
});

// ---------------------------------------------------------------------------
describe("removeBackground (local, optional package)", () => {
  const remover: BackgroundRemover = async (png) => {
    expect(sniffImage(png)).toBe("png");
    return CUT;
  };
  const answer = (selection: Array<{ id: string; name: string }>) => (op: string) =>
    op === "get_selection" ? { selection } : op === "export_node" ? { base64: PNG_B64, nodeId: "5:5" } : { id: "9:9", besideId: "5:5" };

  it("selection → render → cut → placed BESIDE the original; no bytes in the result", async () => {
    const { res, calls } = await write(`return await figma.removeBackground();`, { bgRemover: remover }, answer([{ id: "5:5", name: "Photo" }]));
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(calls.map((c) => c[0])).toEqual(["get_selection", "export_node", "load_image"]);
    expect(calls[1]![1]).toEqual({ nodeId: "5:5", format: "PNG", scale: 1 });
    expect(calls[2]![1]).toEqual({ base64: CUT.toString("base64"), besideId: "5:5" });
    expect(res.result).toMatchObject({ id: "9:9", mode: "beside", sourceId: "5:5", model: "medium" });
    expect(JSON.stringify(res.result)).not.toContain(CUT.toString("base64"));
  });

  it("an id and mode replace swap the fill in place; scale is clamped", async () => {
    const { res, calls } = await write(`return await figma.removeBackground("5:5", { mode: "replace", scale: 9, model: "small", name: "Cut" });`, { bgRemover: remover }, answer([]));
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(calls[0]).toEqual(["export_node", { nodeId: "5:5", format: "PNG", scale: 4 }]);
    expect(calls[1]![1]).toEqual({ base64: CUT.toString("base64"), name: "Cut", replaceId: "5:5" });
  });

  it("nothing or several selected: a clear error, no render", async () => {
    const none = await write(`return await figma.removeBackground();`, { bgRemover: remover }, answer([]));
    expect(none.res.error?.message).toMatch(/Nothing is selected/);
    const many = await write(`return await figma.removeBackground();`, { bgRemover: remover }, answer([{ id: "1:1", name: "A" }, { id: "1:2", name: "B" }]));
    expect(many.res.error?.message).toMatch(/2 layers are selected/);
    expect(many.res.error?.hint).toContain("1:2 (B)");
    expect([...none.calls, ...many.calls].some((c) => c[0] === "export_node")).toBe(false);
  });

  it("an unknown mode is refused", async () => {
    const { res } = await write(`return await figma.removeBackground("5:5", { mode: "erase" });`, { bgRemover: remover });
    expect(res.error?.message).toMatch(/"beside" or "replace"/);
  });

  it("package not installed: UNSUPPORTED_OPERATION with the install line, before anything is rendered", async () => {
    const r = await loadBackgroundRemover(async () => {
      throw new Error("Cannot find package");
    }).catch((e) => e);
    expect(r).toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    expect(r.hint).toContain("npm i @imgly/background-removal-node");
  });

  it("wraps the package's API: a Blob in, PNG bytes out; a load failure is not cached", async () => {
    await loadBackgroundRemover(async () => ({})).catch(() => {});
    const seen: unknown[] = [];
    const rm = await loadBackgroundRemover(async () => ({
      default: {
        removeBackground: async (input: Blob, cfg: unknown) => {
          seen.push(input.type, cfg);
          return new Blob([CUT]);
        },
      },
    }));
    expect(Buffer.from(await rm(PNG, { model: "small" }))).toEqual(CUT);
    expect(seen).toEqual(["image/png", { model: "small", output: { format: "image/png" } }]);
  });

  it("a remover that returns no PNG, or throws, is reported plainly", async () => {
    await expect(removeBackgroundPng(PNG, async () => JPEG)).rejects.toThrow(/not a PNG/);
    await expect(removeBackgroundPng(PNG, async () => {
      throw new Error("onnx exploded\nstack");
    })).rejects.toThrow(/Background removal failed: onnx exploded$/);
    await expect(removeBackgroundPng(JPEG, remover)).rejects.toThrow(/render of the node was not a PNG/);
  });
});

// ---------------------------------------------------------------------------
describe("AI keys from the plugin panel", () => {
  const K = "sk-panel-abcdefghijklmnop";

  it("keeps only known providers with clean keys, masks them, newest savedAt wins", () => {
    expect(cleanAiKeySet({ openai: K, gemini: "x", evil: K, flux: "has space inside" })).toEqual({ openai: K });
    expect(maskAiKey(K)).toBe("sk-…mnop");
    const s = new AiKeyStore();
    let changes = 0;
    s.onChange(() => changes++);
    expect(s.set({ openai: K }, 10)).toBe(true);
    expect(s.set({ openai: null }, 5)).toBe(false); // an older window's cache
    expect(s.get("openai")).toBe(K);
    expect(s.set({ openai: K }, 11)).toBe(true);
    expect(changes).toBe(1); // same keys again: no broadcast
    s.set({ gemini: K }, 12);
    expect(s.get("openai")).toBeUndefined();
    expect(s.status({ anthropic: "sk-env-0000000000000" })).toEqual({
      providers: [
        { provider: "gemini", source: "plugin", masked: "sk-…mnop" },
        { provider: "anthropic", source: "env", masked: "sk-…0000" },
      ],
    });
    expect(JSON.stringify(s.status())).not.toContain(K);
  });

  it("panel keys beat the environment; env names for Gemini and Flux are read", () => {
    const panel = new AiKeyStore();
    panel.set({ openai: K }, 1);
    const cfg = loadByokConfig({ OPENAI_API_KEY: "env-openai-key", GOOGLE_API_KEY: "env-google-key", BFL_API_KEY: "env-bfl-key", FIGMA_MCP_IMAGE_PROVIDER: "flux" } as NodeJS.ProcessEnv, panel);
    expect(cfg).toMatchObject({ openaiApiKey: K, geminiApiKey: "env-google-key", fluxApiKey: "env-bfl-key", imageProvider: "flux", geminiModel: "gemini-2.5-flash-image", fluxModel: "flux-pro-1.1" });
  });

  it("chooses the asked provider, else the preferred one, else the first with a key", () => {
    expect(chooseImageProvider({ geminiApiKey: "g", fluxApiKey: "f" })).toBe("gemini");
    expect(chooseImageProvider({ openaiApiKey: "o", fluxApiKey: "f", imageProvider: "flux" })).toBe("flux");
    expect(chooseImageProvider({ openaiApiKey: "o", imageProvider: "flux" })).toBe("openai");
    expect(chooseImageProvider({ openaiApiKey: "o", geminiApiKey: "g" }, "gemini")).toBe("gemini");
    expect(() => chooseImageProvider({ openaiApiKey: "o" }, "flux")).toThrow(/No Flux key/);
    expect(() => chooseImageProvider({ openaiApiKey: "o" }, "dalle")).toThrow(/Unknown image provider/);
    const none = (() => {
      try {
        chooseImageProvider({});
      } catch (e) {
        return e as { code: string; hint: string };
      }
    })();
    expect(none).toMatchObject({ code: "UNAUTHORIZED", hint: expect.stringMatching(/AI Image Key field/) });
  });

  it("the bridge hands set_ai_keys from a joined window to its handler and answers with ai_status — never echoing a key", async () => {
    const got: Array<[Record<string, unknown>, number | null]> = [];
    const bridge = new Bridge({ onAiKeys: (k, at) => got.push([k, at]) });
    bridge.setAiStatusProvider(() => ({ providers: [{ provider: "openai", source: "plugin", masked: "sk-…mnop" }] }));
    const port = await bridge.listen(0, "t");
    try {
      // A socket that never said hello is ignored.
      const stranger = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((r) => stranger.once("open", () => r()));
      stranger.send(JSON.stringify({ type: "set_ai_keys", keys: { openai: K }, savedAt: 1 }));
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const msgs: WireMessage[] = [];
      await new Promise<void>((r) => ws.once("open", () => r()));
      ws.on("message", (d) => msgs.push(JSON.parse(d.toString()) as WireMessage));
      ws.send(JSON.stringify({ type: "hello", protocolVersion: 9, pluginVersion: "1", fileKey: null, fileName: "F", pageName: "P", editorType: "figma" }));
      await new Promise((r) => setTimeout(r, 40));
      ws.send(JSON.stringify({ type: "set_ai_keys", keys: { openai: K }, savedAt: 3 }));
      ws.send(JSON.stringify({ type: "set_ai_keys", keys: "junk" }));
      await new Promise((r) => setTimeout(r, 40));
      expect(got).toEqual([[{ openai: K }, 3]]);
      expect(msgs.filter((m) => m.type === "ai_status")).toHaveLength(1);
      expect(JSON.stringify(msgs)).not.toContain(K);
      ws.close();
      stranger.close();
    } finally {
      await bridge.close();
    }
  });
});

// ---------------------------------------------------------------------------
describe("image providers", () => {
  const K = "provider-key-SECRET-123456";

  it("Gemini: key in x-goog-api-key, aspect ratio from size, inline image data back", async () => {
    const seen: any[] = [];
    const out = await generateImage("a fox", { size: "1536x1024", provider: "gemini" }, { geminiApiKey: K }, async (url, init) => {
      seen.push({ url, headers: init.headers, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "here" }, { inlineData: { mimeType: "image/png", data: PNG_B64 } }] } }] }), { status: 200 });
    });
    expect(out).toEqual({ base64: PNG_B64, model: "gemini-2.5-flash-image", size: "1536x1024", provider: "gemini" });
    expect(seen[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent");
    expect(seen[0].headers["x-goog-api-key"]).toBe(K);
    expect(seen[0].body.generationConfig).toEqual({ responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "3:2" } });
    expect(JSON.stringify(seen[0].body)).not.toContain(K);
  });

  it("Gemini: a 400 API_KEY_INVALID is a refused key; a blocked prompt says why", async () => {
    const bad = await generateImage("x", { provider: "gemini" }, { geminiApiKey: K }, async () => new Response(`{"error":{"status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}],"key":"${K}"}}`, { status: 400 })).catch((e) => e);
    expect(bad).toMatchObject({ code: "UNAUTHORIZED" });
    expect(`${bad.message} ${bad.hint}`).not.toContain(K);
    const blocked = await generateImage("x", { provider: "gemini" }, { geminiApiKey: K }, async () => new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }), { status: 200 })).catch((e) => e);
    expect(blocked.message).toMatch(/no image \(SAFETY\)/);
  });

  it("Flux: submit, poll the bfl.ai URL with the key, download the sample WITHOUT it", async () => {
    const seen: Array<{ url: string; key?: string }> = [];
    let polls = 0;
    const out = await generateImage("a lamp", { size: "1024x1536", provider: "flux", sleep: async () => {} }, { fluxApiKey: K }, async (url, init) => {
      seen.push({ url, key: (init.headers as Record<string, string> | undefined)?.["x-key"] });
      if (url === "https://api.bfl.ai/v1/flux-pro-1.1") {
        expect(JSON.parse(String(init.body))).toEqual({ prompt: "a lamp", width: 1024, height: 1536, output_format: "png" });
        return new Response(JSON.stringify({ id: "j1", polling_url: "https://api.eu.bfl.ai/v1/get_result?id=j1" }));
      }
      if (url.startsWith("https://api.eu.bfl.ai/")) return new Response(JSON.stringify(++polls < 2 ? { status: "Pending" } : { status: "Ready", result: { sample: "https://delivery.example/s.png?sig=1" } }));
      return new Response(PNG);
    });
    expect(out).toMatchObject({ base64: PNG_B64, provider: "flux", model: "flux-pro-1.1" });
    expect(seen.map((s) => [s.url.split("?")[0], s.key])).toEqual([
      ["https://api.bfl.ai/v1/flux-pro-1.1", K],
      ["https://api.eu.bfl.ai/v1/get_result", K],
      ["https://api.eu.bfl.ai/v1/get_result", K],
      ["https://delivery.example/s.png", undefined],
    ]);
  });

  it("Flux: a polling URL outside bfl.ai is never sent the key; moderation is explained", async () => {
    const urls: string[] = [];
    const off = await generateImage("x", { provider: "flux", sleep: async () => {} }, { fluxApiKey: K }, async (url) => {
      urls.push(url);
      return new Response(JSON.stringify({ id: "j", polling_url: "https://evil.example/poll" }));
    }).catch((e) => e);
    expect(off.message).toMatch(/outside bfl.ai/);
    expect(urls).toEqual(["https://api.bfl.ai/v1/flux-pro-1.1"]);
    const mod = await generateImage("x", { provider: "flux", sleep: async () => {} }, { fluxApiKey: K }, async (url) =>
      new Response(JSON.stringify(url.includes("get_result") ? { status: "Content Moderated" } : { id: "j" })),
    ).catch((e) => e);
    expect(mod.message).toMatch(/Content Moderated/);
    expect(mod.hint).toMatch(/moderated/);
  });

  it("a 429 is RATE_LIMITED; an image Figma cannot decode is refused before it reaches the plugin", async () => {
    const limited = await generateImage("x", {}, { openaiApiKey: K }, async () => new Response("", { status: 429 })).catch((e) => e);
    expect(limited.code).toBe("RATE_LIMITED");
    const webp = await generateImage("x", {}, { openaiApiKey: K }, async () => new Response(JSON.stringify({ data: [{ b64_json: WEBP.toString("base64") }] }))).catch((e) => e);
    expect(webp.message).toMatch(/cannot decode \(webp\)/);
  });

  it("figma.generateImage passes the provider and reports which one drew it", async () => {
    const { res, calls } = await write(`return await figma.generateImage("hero", { provider: "gemini", parentId: "1:1" });`, {
      byok: { geminiApiKey: K, openaiApiKey: K },
      aiFetch: async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: PNG_B64 } }] } }] })),
    });
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(calls[0]).toEqual(["load_image", { base64: PNG_B64, name: "hero", parentId: "1:1" }]);
    expect(res.result).toMatchObject({ provider: "gemini" });
    expect(JSON.stringify(res)).not.toContain(K);
  });
});
