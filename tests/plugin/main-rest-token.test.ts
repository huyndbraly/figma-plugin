import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * main.ts's own handlers for the REST token and the panel language, run
 * against a fake `figma` (main.ts installs itself on import). The storage
 * rules live in rest-token-store.ts and are tested there; this pins the
 * WIRING: which message reads/writes what, and what goes back to the UI.
 */

const TOKEN = "figd_abcdefghijklmnopqrstuvwxyz1234";
const store = new Map<string, unknown>();
const posted: Array<Record<string, unknown>> = [];
let onmessage: ((m: unknown) => Promise<void> | void) | undefined;

beforeAll(async () => {
  (globalThis as any).__html__ = "<html></html>";
  (globalThis as any).figma = {
    editorType: "figma",
    fileKey: "K",
    mixed: Symbol("mixed"),
    root: { name: "File", children: [] },
    currentPage: { name: "Page 1", children: [], on() {} },
    showUI() {},
    on() {},
    ui: {
      postMessage: (m: Record<string, unknown>) => posted.push(m),
      resize() {},
      set onmessage(fn: (m: unknown) => void) {
        onmessage = fn;
      },
    },
    clientStorage: {
      getAsync: async (k: string) => store.get(k),
      setAsync: async (k: string, v: unknown) => void store.set(k, v),
      deleteAsync: async (k: string) => void store.delete(k),
    },
  };
  await import("../../src/plugin/main.js");
});

// main.ts's handler is async and awaits clientStorage: awaiting it is the
// condition (no guessed sleep).
const send = async (m: unknown) => {
  await onmessage?.(m);
};
const lastOf = (kind: string) => [...posted].reverse().find((m) => m.kind === kind);

describe("main.ts REST token handlers", () => {
  it("save → clientStorage { token, expiresAt, savedAt } and a `saved` answer", async () => {
    await send({ kind: "save-rest-token", token: TOKEN, expiresAt: 123 });
    const stored = store.get("figma-plugin:rest-token") as { token: string; expiresAt: number; savedAt: number };
    expect(stored).toMatchObject({ token: TOKEN, expiresAt: 123 });
    expect(typeof stored.savedAt).toBe("number");
    expect(lastOf("rest-token")).toMatchObject({ token: TOKEN, expiresAt: 123, savedAt: stored.savedAt, reason: "saved" });
  });

  it("rest-token-request reads clientStorage AGAIN (another window may have changed it)", async () => {
    store.set("figma-plugin:rest-token", { token: null, savedAt: 999 }); // cleared elsewhere
    await send({ kind: "rest-token-request" });
    expect(lastOf("rest-token")).toEqual({ kind: "rest-token", token: null, expiresAt: null, savedAt: 999, reason: "sync" });
  });

  it("a malformed token is rejected and nothing is stored", async () => {
    store.set("figma-plugin:rest-token", { token: TOKEN, savedAt: 1 });
    await send({ kind: "save-rest-token", token: "figd_ bad token" });
    expect(lastOf("rest-token")).toMatchObject({ reason: "rejected", token: null });
    expect(store.get("figma-plugin:rest-token")).toEqual({ token: TOKEN, savedAt: 1 });
  });

  it("clear leaves a dated tombstone", async () => {
    await send({ kind: "save-rest-token", token: null });
    expect(store.get("figma-plugin:rest-token")).toMatchObject({ token: null });
    expect(lastOf("rest-token")).toMatchObject({ token: null, reason: "cleared" });
  });

  it("the hello carries no token at all", async () => {
    await send({ kind: "hello-request" });
    const hello = lastOf("hello") as { hello: Record<string, unknown> };
    expect(JSON.stringify(hello)).not.toContain("figd_");
    expect(hello.hello).not.toHaveProperty("restToken");
  });

  it("save-ui-lang stores en/vi only; the handshake sends it back", async () => {
    await send({ kind: "save-ui-lang", lang: "vi" });
    await send({ kind: "save-ui-lang", lang: "<script>" });
    expect(store.get("figma-plugin:ui-lang")).toBe("vi");
    await send({ kind: "handshake" });
    await vi.waitFor(() => expect(lastOf("ui-lang")).toEqual({ kind: "ui-lang", lang: "vi" }));
  });
});

describe("main.ts AI key handlers", () => {
  const A = "sk-openai-abcdefghijklmnopqrstu";
  const B = "AIza-gemini-abcdefghijklmnopqrs";

  it("two Saves sent back to back both land (saves run one at a time)", async () => {
    store.delete("figma-plugin:ai-keys");
    // Not awaited between: two clicks, or two windows, in quick succession.
    void send({ kind: "save-ai-key", provider: "openai", key: A });
    void send({ kind: "save-ai-key", provider: "gemini", key: B });
    await send({ kind: "ai-keys-request" }); // waits for the queued saves
    expect(lastOf("ai-keys")).toMatchObject({ reason: "sync", keys: { openai: A, gemini: B } });
    const by = (lastOf("ai-keys") as { savedAtBy: Record<string, number> }).savedAtBy;
    expect(by.gemini).toBeGreaterThan(by.openai!);
  });

  it("a bad key is refused with a reason and nothing is stored", async () => {
    const before = JSON.stringify(store.get("figma-plugin:ai-keys"));
    await send({ kind: "save-ai-key", provider: "flux", key: "has a space" });
    await send({ kind: "ai-keys-request" });
    expect([...posted].reverse().find((m) => m.kind === "ai-keys" && m.reason === "rejected")).toMatchObject({ error: expect.stringMatching(/API key/) });
    expect(JSON.stringify(store.get("figma-plugin:ai-keys"))).toBe(before);
  });
});
