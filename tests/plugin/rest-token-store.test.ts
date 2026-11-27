import { describe, expect, it } from "vitest";
import { REST_TOKEN_KEY, clearToken, parseStoredToken, readStoredToken, saveToken, type TokenStorage } from "../../src/plugin/rest-token-store.js";

/**
 * How the plugin keeps the PAT in figma.clientStorage — what main.ts's
 * save-rest-token / rest-token-request handlers do, without a Figma runtime.
 */

const TOKEN = "figd_abcdefghijklmnopqrstuvwxyz1234";

function memory(initial?: unknown): TokenStorage & { data: Map<string, unknown>; failSet?: boolean } {
  const data = new Map<string, unknown>(initial === undefined ? [] : [[REST_TOKEN_KEY, initial]]);
  const s = {
    data,
    failSet: false,
    getAsync: async (k: string) => data.get(k),
    setAsync: async (k: string, v: unknown) => {
      if (s.failSet) throw new Error("quota");
      data.set(k, v);
    },
  };
  return s;
}

describe("reading what is stored", () => {
  it("current shape, legacy bare string, a Clear tombstone, garbage", () => {
    expect(parseStoredToken({ token: TOKEN, expiresAt: 5, savedAt: 9 })).toEqual({ token: TOKEN, expiresAt: 5, savedAt: 9 });
    expect(parseStoredToken(TOKEN)).toEqual({ token: TOKEN, expiresAt: null, savedAt: null });
    expect(parseStoredToken({ token: null, savedAt: 12 })).toEqual({ token: null, expiresAt: null, savedAt: 12 });
    expect(parseStoredToken({ token: "has space", expiresAt: 5 })).toEqual({ token: null, expiresAt: null, savedAt: null });
    expect(parseStoredToken(42)).toEqual({ token: null, expiresAt: null, savedAt: null });
  });

  it("a storage that throws reads as nothing stored", async () => {
    expect(await readStoredToken({ getAsync: async () => { throw new Error("x"); }, setAsync: async () => {} })).toEqual({ token: null, expiresAt: null, savedAt: null });
  });
});

describe("save and clear", () => {
  it("Save stores { token, expiresAt, savedAt } under the shared (not per-file) key", async () => {
    const st = memory();
    const res = await saveToken(st, `  ${TOKEN} `, 1000, 77);
    expect(res).toEqual({ ok: true, stored: { token: TOKEN, expiresAt: 1000, savedAt: 77 } });
    expect(st.data.get(REST_TOKEN_KEY)).toEqual({ token: TOKEN, expiresAt: 1000, savedAt: 77 });
  });

  it("a malformed token is refused and the stored one is untouched", async () => {
    const st = memory({ token: TOKEN, expiresAt: null, savedAt: 1 });
    const res = await saveToken(st, "figd_ with spaces", null, 2);
    expect(res.ok).toBe(false);
    expect(st.data.get(REST_TOKEN_KEY)).toEqual({ token: TOKEN, expiresAt: null, savedAt: 1 });
  });

  it("Clear leaves a dated tombstone — other windows can tell it is newer than what they cached", async () => {
    const st = memory({ token: TOKEN, expiresAt: null, savedAt: 1 });
    expect(await clearToken(st, 50)).toEqual({ token: null, expiresAt: null, savedAt: 50 });
    expect(await readStoredToken(st)).toEqual({ token: null, expiresAt: null, savedAt: 50 });
  });

  it("a storage write failure still returns the token for this session", async () => {
    const st = memory();
    st.failSet = true;
    expect((await saveToken(st, TOKEN, null, 3)).ok).toBe(true);
  });
});
