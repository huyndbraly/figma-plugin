/**
 * Module 1 of the Claude Desktop upgrade (2026-11-27): images from a file or
 * URL without base64 in the agent's context, and BYOK image generation with keys from the plugin panel (OpenAI, Gemini, Flux).
 */
import { mkdtemp, rm, writeFile, mkdir, chmod } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { MAX_IMAGE_FILE_BYTES, looksLikeImagePath, readImageFile, resolveImagePath, sniffImage } from "../../src/server/image-file.js";
import { chooseImageProvider, generateImage, loadByokConfig, readByokFile } from "../../src/server/byok.js";
import { AiKeyStore } from "../../src/server/ai-keys.js";
import { cleanAiKeySet, maskAiKey } from "../../src/shared/ai-key.js";
import { executeWrite } from "../../src/server/executor.js";
import { SessionRegistry } from "../../src/server/session.js";
import { Bridge } from "../../src/server/bridge.js";
import type { BridgeResponse, WireMessage } from "../../src/shared/protocol.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const GIF = Buffer.from("GIF89a\u0001\u0000", "latin1");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
const PNG_B64 = PNG.toString("base64");

const ok = (result: unknown): BridgeResponse => ({ id: "x", ok: true, result });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "figma-media-"));
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
});

// ---------------------------------------------------------------------------
describe("AI keys from the plugin panel", () => {
  const K = "sk-panel-abcdefghijklmnop";
  const K2 = "AIza-second-key-qrstuvwxyz";

  it("keeps only known providers with clean keys; masks show nothing of a short key", () => {
    expect(cleanAiKeySet({ openai: K, gemini: "x", evil: K, flux: "has space inside" })).toEqual({ openai: K });
    expect(maskAiKey(K)).toBe("sk-…mnop");
    expect(maskAiKey("sk-short-key-12345")).toBe("••••"); // 18 chars: 7 shown would be too much
    const s = new AiKeyStore(() => 1_000);
    s.set({ gemini: K }, 10, { gemini: 10 });
    expect(s.status({ anthropic: "sk-env-00000000000000000000" })).toEqual({
      providers: [
        { provider: "gemini", source: "plugin", masked: "sk-…mnop" },
        { provider: "anthropic", source: "env", masked: "sk-…0000" },
      ],
    });
    expect(JSON.stringify(s.status())).not.toContain(K);
  });

  it("merges per provider: a panel that never saved a provider does not erase another panel's key", () => {
    const s = new AiKeyStore(() => 1_000);
    let changes = 0;
    s.onChange(() => changes++);
    // Figma Desktop saved OpenAI at 10.
    expect(s.set({ openai: K, gemini: null }, 10, { openai: 10 })).toBe(true);
    // Figma in a browser (its own storage) saved Gemini at 20 and never touched OpenAI.
    s.set({ openai: null, gemini: K2 }, 20, { gemini: 20 });
    expect([s.get("openai"), s.get("gemini")]).toEqual([K, K2]);
    // A real Clear of OpenAI (dated) does remove it; an older cache cannot bring it back.
    s.set({ openai: null }, 30, { openai: 30 });
    expect(s.get("openai")).toBeUndefined();
    expect(s.set({ openai: K }, 15, { openai: 15 })).toBe(false);
    expect(s.get("openai")).toBeUndefined();
    // The same save sent again changes nothing (no broadcast).
    const before = changes;
    s.set({ gemini: K2 }, 20, { gemini: 20 });
    expect(changes).toBe(before);
  });

  it("a time from the future is clamped to now, so it cannot pin a key against later saves", () => {
    let now = 1_000;
    const s = new AiKeyStore(() => now);
    s.set({ openai: K }, 1e308, { openai: 1e308 });
    now = 2_000;
    expect(s.set({ openai: K2 }, 1_500, { openai: 1_500 })).toBe(true);
    expect(s.get("openai")).toBe(K2);
  });

  it("a legacy message (no savedAtBy) still applies its savedAt to the providers it names", () => {
    const s = new AiKeyStore(() => 1_000);
    s.set({ openai: K }, 5);
    expect(s.get("openai")).toBe(K);
    s.set({ openai: null }, 4);
    expect(s.get("openai")).toBe(K);
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

// ---------------------------------------------------------------------------
describe("code review fixes (2026-11-28)", () => {
  const K = "provider-key-SECRET-123456";
  const PANEL = "sk-panel-abcdefghijklmnop";

  it("a config file holding null / an array is refused as an OpError, not a TypeError later", async () => {
    for (const body of ["null", "[1]", "42", "not json"]) {
      const p = join(dir, "byok.json");
      await writeFile(p, body);
      expect(() => readByokFile({ FIGMA_MCP_BYOK_CONFIG: p } as NodeJS.ProcessEnv)).toThrow(/not a readable JSON object/);
    }
  });

  it("a broken config file does not hide a panel or env key; with no key at all it is reported", async () => {
    const p = join(dir, "byok.json");
    await writeFile(p, "null");
    const panel = new AiKeyStore(() => 1_000);
    panel.set({ openai: PANEL }, 1, { openai: 1 });
    expect(loadByokConfig({ FIGMA_MCP_BYOK_CONFIG: p } as NodeJS.ProcessEnv, panel).openaiApiKey).toBe(PANEL);
    expect(loadByokConfig({ FIGMA_MCP_BYOK_CONFIG: p, GEMINI_API_KEY: "env-gemini-key" } as NodeJS.ProcessEnv, new AiKeyStore()).geminiApiKey).toBe("env-gemini-key");
    expect(() => loadByokConfig({ FIGMA_MCP_BYOK_CONFIG: p } as NodeJS.ProcessEnv, new AiKeyStore())).toThrow(/not a readable JSON object/);
  });

  it("a set_ai_keys handler that throws does not take the process down; the bridge keeps serving", async () => {
    const bridge = new Bridge({ onAiKeys: () => { throw new TypeError("boom"); } });
    bridge.setAiStatusProvider(() => { throw new TypeError("boom too"); });
    const port = await bridge.listen(0, "t");
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const msgs: WireMessage[] = [];
      await new Promise<void>((r) => ws.once("open", () => r()));
      ws.on("message", (d) => msgs.push(JSON.parse(d.toString()) as WireMessage));
      ws.send(JSON.stringify({ type: "hello", protocolVersion: 9, pluginVersion: "1", fileKey: null, fileName: "F", pageName: "P", editorType: "figma" }));
      await new Promise((r) => setTimeout(r, 40));
      ws.send(JSON.stringify({ type: "set_ai_keys", keys: { openai: PANEL }, savedAt: 1 }));
      ws.send(JSON.stringify({ type: "ping" }));
      await new Promise((r) => setTimeout(r, 40));
      expect(ws.readyState).toBe(WebSocket.OPEN);
      expect(msgs.some((m) => m.type === "assigned")).toBe(true);
      ws.close();
    } finally {
      await bridge.close();
    }
  });

  it("Flux: \"Task not found\" right after submit is waited out, not a failure", async () => {
    let polls = 0;
    const out = await generateImage("x", { provider: "flux", sleep: async () => {} }, { fluxApiKey: K }, async (url) => {
      if (url.includes("get_result")) return new Response(JSON.stringify(++polls === 1 ? { status: "Task not found" } : { status: "Ready", result: { sample: "https://delivery.bfl.ai/s.png" } }));
      if (url.startsWith("https://delivery")) return new Response(PNG);
      return new Response(JSON.stringify({ id: "j" }));
    });
    expect(out.provider).toBe("flux");
    expect(polls).toBe(2);
  });

  it("Flux: a sample over the size cap is refused; a *.bfl.ml polling URL gets no key", async () => {
    const big = await generateImage("x", { provider: "flux", sleep: async () => {} }, { fluxApiKey: K }, async (url) => {
      if (url.includes("get_result")) return new Response(JSON.stringify({ status: "Ready", result: { sample: "https://delivery.bfl.ai/s.png" } }));
      if (url.startsWith("https://delivery")) return new Response(PNG, { headers: { "content-length": String(MAX_IMAGE_FILE_BYTES + 1) } });
      return new Response(JSON.stringify({ id: "j" }));
    }).catch((e) => e);
    expect(big.message).toMatch(/over 32 MB/);
    const urls: string[] = [];
    const ml = await generateImage("x", { provider: "flux", sleep: async () => {} }, { fluxApiKey: K }, async (url) => {
      urls.push(url);
      return new Response(JSON.stringify({ id: "j", polling_url: "https://api.bfl.ml/v1/get_result?id=j" }));
    }).catch((e) => e);
    expect(ml.message).toMatch(/outside bfl.ai/);
    expect(urls).toHaveLength(1);
  });

  it("Flux: the whole call stops at its deadline, inside the figma_write budget", async () => {
    const realNow = Date.now;
    let t = realNow();
    Date.now = () => t;
    try {
      const e = await generateImage("x", { provider: "flux", sleep: async (ms) => { t += ms * 10; } }, { fluxApiKey: K }, async (url) =>
        new Response(JSON.stringify(url.includes("get_result") ? { status: "Pending" } : { id: "j" })),
      ).catch((x) => x);
      expect(e.message).toMatch(/did not finish within 90 s/);
    } finally {
      Date.now = realNow;
    }
  });

  it("transparent: OpenAI is asked for a transparent PNG; other providers are refused; no provider → OpenAI", async () => {
    const bodies: any[] = [];
    const fetchImpl = async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }));
    };
    const out = await generateImage("a mug", { transparent: true }, { geminiApiKey: K, openaiApiKey: K, imageProvider: "gemini" }, fetchImpl);
    expect(out.provider).toBe("openai");
    expect(bodies[0]).toMatchObject({ background: "transparent", output_format: "png" });
    await expect(generateImage("x", { transparent: true, provider: "flux" }, { fluxApiKey: K }, fetchImpl)).rejects.toThrow(/Flux cannot make a transparent background/);
    await expect(generateImage("x", { transparent: true }, { geminiApiKey: K }, fetchImpl)).rejects.toThrow(/No OpenAI key/);
    const { res, calls } = await write(`return await figma.generateImage("mug", { transparent: true, parentId: "1:1" });`, { byok: { openaiApiKey: K }, aiFetch: fetchImpl });
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(calls[0]).toEqual(["load_image", { base64: PNG_B64, name: "mug", parentId: "1:1" }]);
  });

  it("a positional plain path is read as a file (base64 never holds '.' or '~'); a JPEG's base64 stays base64", async () => {
    expect(looksLikeImagePath("/Users/me/hero.png")).toBe(true);
    expect(looksLikeImagePath("~/Pictures/a.png")).toBe(true);
    expect(looksLikeImagePath("/9j/4AAQSkZJRgABAQ==")).toBe(false);
    expect(looksLikeImagePath("iVBORw0KGgo=")).toBe(false);
    const p = join(dir, "pos.png");
    await writeFile(p, PNG);
    const { res, calls } = await write(`return await figma.loadImage(${JSON.stringify(p)});`);
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(calls[0]![1]).toEqual({ base64: PNG_B64 });
    const jpegB64 = await write(`return await figma.loadImage("/9j/4AAQSkZJRgABAQ==");`);
    expect(jpegB64.calls[0]![1]).toEqual({ base64: "/9j/4AAQSkZJRgABAQ==" });
  });

  it("a batch item with a non-string filePath / imageUrl gets a clear error, not 'requires base64'", async () => {
    // Batch errors are per item, in the result.
    const a = await write(`return await figma.batch([{ op: "load_image", params: { filePath: 123 } }]);`);
    expect(JSON.stringify(a.res.result)).toMatch(/filePath must be a non-empty string/);
    const b = await write(`return await figma.batch([{ op: "load_image", params: { imageUrl: {} } }]);`);
    expect(JSON.stringify(b.res.result)).toMatch(/imageUrl must be an http\(s\) URL/);
    expect(a.calls.concat(b.calls)).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)("a file stat can see but open cannot read is a clear permission error", async () => {
    const p = join(dir, "locked.png");
    await writeFile(p, PNG);
    await chmod(p, 0o000);
    try {
      await expect(readImageFile(p)).rejects.toMatchObject({ code: "INVALID_PARAMS", message: expect.stringMatching(/may not read/) });
    } finally {
      await chmod(p, 0o644);
    }
  });
});
