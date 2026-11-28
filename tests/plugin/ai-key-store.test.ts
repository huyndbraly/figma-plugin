import { describe, expect, it } from "vitest";
import { AI_KEYS_KEY, parseStoredAiKeys, readStoredAiKeys, saveAiKey } from "../../src/plugin/ai-key-store.js";

function memory(initial?: unknown) {
  const m = new Map<string, unknown>(initial === undefined ? [] : [[AI_KEYS_KEY, initial]]);
  return { m, getAsync: async (k: string) => m.get(k), setAsync: async (k: string, v: unknown) => void m.set(k, v) };
}
const K = "AIzaSy-abcdefghijklmnop";

describe("AI keys in clientStorage", () => {
  it("parses only known providers with clean keys", () => {
    expect(parseStoredAiKeys({ keys: { gemini: K, other: K, flux: "x y" }, savedAt: 5, savedAtBy: { gemini: 5, evil: 9 } })).toEqual({ keys: { gemini: K }, savedAt: 5, savedAtBy: { gemini: 5 } });
    expect(parseStoredAiKeys("junk")).toEqual({ keys: {}, savedAt: null, savedAtBy: {} });
    // Written before per-provider times: each stored key dates from savedAt.
    expect(parseStoredAiKeys({ keys: { gemini: K }, savedAt: 7 })).toEqual({ keys: { gemini: K }, savedAt: 7, savedAtBy: { gemini: 7 } });
  });

  it("saving one provider keeps the others, read fresh (another window may have saved one)", async () => {
    const s = memory({ keys: { openai: "sk-other-window-key-1" }, savedAt: 100 });
    const r = await saveAiKey(s, "gemini", `  ${K} `, 50);
    expect(r).toEqual({ ok: true, stored: { keys: { openai: "sk-other-window-key-1", gemini: K }, savedAt: 101, savedAtBy: { openai: 100, gemini: 101 } } });
    expect(await readStoredAiKeys(s)).toEqual({ keys: { openai: "sk-other-window-key-1", gemini: K }, savedAt: 101, savedAtBy: { openai: 100, gemini: 101 } });
  });

  it("clear removes one provider and dates it", async () => {
    const s = memory({ keys: { openai: "sk-a-key-123456789", gemini: K }, savedAt: 1 });
    const r = await saveAiKey(s, "openai", null, 9);
    // The Clear is dated too: the server must see it as newer than the key it held.
    expect(r).toEqual({ ok: true, stored: { keys: { gemini: K }, savedAt: 9, savedAtBy: { openai: 9, gemini: 1 } } });
  });

  it("a bad key or provider is refused and nothing is written", async () => {
    const s = memory();
    expect(await saveAiKey(s, "gemini", "has a space", 1)).toMatchObject({ ok: false });
    expect(await saveAiKey(s, "dalle", K, 1)).toMatchObject({ ok: false, error: expect.stringMatching(/provider/) });
    expect(s.m.size).toBe(0);
  });

  it("a failed read on Save changes nothing (it would erase every other provider's key)", async () => {
    const writes: unknown[] = [];
    const broken = { getAsync: async () => { throw new Error("storage busy"); }, setAsync: async (_k: string, v: unknown) => void writes.push(v) };
    expect(await saveAiKey(broken, "gemini", K, 1)).toMatchObject({ ok: false, error: expect.stringMatching(/nothing was changed/) });
    expect(writes).toEqual([]);
  });
});
