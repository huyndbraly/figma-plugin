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

const send = async (m: unknown) => {
  await onmessage?.(m);
  await new Promise((r) => setTimeout(r, 5));
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
